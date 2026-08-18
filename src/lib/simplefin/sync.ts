import { getAccount } from '@/lib/accounts';
import { runEngine, type EngineResult } from '@/lib/categorize/engine';
import { nowIso } from '@/lib/clock';
import { readEnv } from '@/lib/env';
import { commitImport, type CommitRow } from '@/lib/import/commit';
import { DEDUP_HASH_VERSION } from '@/lib/import/dedup';
import { applyLoanMatchers } from '@/lib/loans';
import { parseAmountToCents } from '@/lib/money';
import type { RowError } from '@/lib/import/parse';
import { SimplefinError, fetchAccounts, type Fetcher, type SimplefinAccount } from './client';
import {
  MAX_WINDOW_DAYS,
  OVERLAP_DAYS,
  assertRequestBudget,
  consumeRequest,
  getAccessUrl,
  getConnection,
  listLinks,
  markSynced,
  updateLinkBalance,
} from './connection';

const DAY = 86400;

/** end = now; start = last sync minus a 5-day overlap, clamped to the 90-day maximum. */
export function syncWindow(input: { lastSyncAt: string | null; now?: Date }): { startDate: number; endDate: number } {
  const now = input.now ?? new Date();
  const endDate = Math.floor(now.getTime() / 1000);
  const floor = endDate - MAX_WINDOW_DAYS * DAY;
  if (input.lastSyncAt === null) return { startDate: floor, endDate };
  const last = Math.floor(new Date(input.lastSyncAt).getTime() / 1000);
  return { startDate: Math.max(floor, last - OVERLAP_DAYS * DAY), endDate };
}

export function postedToIsoDate(posted: number, tz?: string): string {
  const zone = tz ?? readEnv().tz;
  return new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    new Date(posted * 1000),
  );
}

/**
 * Negative = debit, matching the app's sign convention with no transformation.
 * Delegates to the CSV importer's parseAmountToCents rather than duplicating
 * decimal-to-cents math: SimpleFIN permits arbitrary precision (e.g. "8.165"),
 * and a flat Number.EPSILON nudge is too small to correct the float error at
 * that magnitude — parseAmountToCents's magnitude-scaled epsilon rounds
 * correctly (817, not 816) and stays sign/format-compatible with every case
 * already covered here (thousands separators, plain "-12.34", etc).
 */
export function amountToCents(amount: string): number | null {
  if (typeof amount !== 'string') return null;
  return parseAmountToCents(amount);
}

export interface AccountSyncResult {
  simplefinAccountId: string;
  accountName: string;
  importId: number | null;
  added: number;
  duplicates: number;
  skippedPending: number;
  errors: number;
  currencyWarning: string | null;
}

export interface SyncResult {
  ranAt: string;
  accounts: AccountSyncResult[];
  errlist: string[];
  totalAdded: number;
  totalDuplicates: number;
  engine: EngineResult;
  /** true when runEngine threw after the rows were already committed — same contract as import/flow.ts. */
  engineFailed: boolean;
  loanLinksCreated: number;
  /** F5 fix-round: true when applyLoanMatchers's own internal catch (MUST-13.5) fired. */
  loanMatchFailed: boolean;
}

function syncLabel(at: Date): string {
  return `simplefin ${nowIso(at).slice(0, 16).replace('T', ' ')}`;
}

export async function runSync(input: { userId: number; fetcher?: Fetcher; now?: Date }): Promise<SyncResult> {
  const now = input.now ?? new Date();
  const connection = getConnection();
  if (!connection) throw new SimplefinError('bad_token', 'There is no SimpleFIN connection configured yet.', 409);
  if (!connection.enabled) throw new SimplefinError('bad_token', 'The SimpleFIN connection is disabled.', 409);

  // Budget check happens BEFORE the request so a refusal never burns a call.
  assertRequestBudget(now);

  const accessUrl = getAccessUrl();
  if (accessUrl === null) throw new SimplefinError('bad_token', 'There is no SimpleFIN connection configured yet.', 409);

  const window = syncWindow({ lastSyncAt: connection.lastSyncAt, now });
  consumeRequest(now);
  const set = await fetchAccounts({ accessUrl, startDate: window.startDate, endDate: window.endDate, fetcher: input.fetcher });

  const links = listLinks();
  const results: AccountSyncResult[] = [];
  const insertedIds: number[] = [];

  for (const remote of set.accounts as SimplefinAccount[]) {
    const link = links.find((candidate) => candidate.simplefinAccountId === remote.id);
    if (!link) continue; // unmapped remote accounts are ignored by design

    const account = getAccount(link.accountId);
    if (!account) continue;

    const rows: CommitRow[] = [];
    const errors: RowError[] = [];
    let skippedPending = 0;
    let rowIndex = 0;

    for (const txn of remote.transactions ?? []) {
      const index = rowIndex;
      rowIndex += 1;

      if (txn.pending === true) {
        // Pending rows change id and amount before settling — never store them.
        skippedPending += 1;
        continue;
      }
      const externalId = typeof txn.id === 'string' ? txn.id.trim() : '';
      if (externalId.length === 0) {
        errors.push({ rowIndex: index, cells: [String(txn.description ?? '')], reason: 'malformed row' });
        continue;
      }
      const amountCents = amountToCents(String(txn.amount ?? ''));
      if (amountCents === null) {
        errors.push({ rowIndex: index, cells: [externalId, String(txn.amount ?? '')], reason: 'unparseable amount' });
        continue;
      }
      const description = String(txn.description ?? '').trim();
      if (description.length === 0) {
        errors.push({ rowIndex: index, cells: [externalId], reason: 'missing description' });
        continue;
      }

      const postedNum = Number(txn.posted);
      if (!Number.isFinite(postedNum)) {
        // A malformed/missing posted date would otherwise reach
        // Intl.DateTimeFormat with an Invalid Date and throw a RangeError,
        // crashing the whole sync AFTER the request budget was already spent.
        errors.push({ rowIndex: index, cells: [externalId, String(txn.posted)], reason: 'unparseable date' });
        continue;
      }
      const date = postedToIsoDate(postedNum);
      rows.push({
        rowIndex: index,
        rawDate: String(txn.posted),
        date,
        rawDescription: description,
        amountCents,
        cells: [],
        occurrenceIndex: 0,
        // SimpleFIN rows dedup on external_id, not on the CSV hash.
        dedupHash: '',
        hashVersion: DEDUP_HASH_VERSION,
        externalId,
      });
    }

    const committed = commitImport({
      accountId: link.accountId,
      profileId: null,
      filename: syncLabel(now),
      importedBy: input.userId,
      rows,
      errors,
      at: now,
    });
    insertedIds.push(...committed.insertedTransactionIds);

    const balanceCents = amountToCents(String(remote.balance ?? ''));
    // Same guard as the per-transaction posted date: a malformed balance-date
    // must not throw out of Intl.DateTimeFormat and crash the whole sync.
    const balanceDateRaw = remote['balance-date'];
    const balanceDate =
      typeof balanceDateRaw === 'number' && Number.isFinite(balanceDateRaw) ? postedToIsoDate(balanceDateRaw) : null;
    updateLinkBalance({
      simplefinAccountId: remote.id,
      balanceCents,
      balanceDate,
    });

    const currency = String(remote.currency ?? link.currency ?? 'CAD').toUpperCase();
    results.push({
      simplefinAccountId: remote.id,
      accountName: account.name,
      importId: committed.importId,
      added: committed.rowsAdded,
      duplicates: committed.rowsDuplicate,
      skippedPending,
      errors: errors.length,
      currencyWarning:
        currency === 'CAD'
          ? null
          : `${account.name} reports ${currency}. This app stores integer cents with no conversion, so mixing currencies will distort your reports.`,
    });
  }

  // The rows are already committed here, so a categorizer failure must not
  // throw out of the sync (import/flow.ts makes the same trade): throwing
  // would skip markSynced(), leaving last_sync_at stale so the next sync
  // re-fetches a window it already stored, and would surface as "sync failed"
  // even though every row is safely in the database. Uncategorized rows are
  // exactly what the review queue is for.
  let engine: EngineResult;
  let engineFailed = false;
  try {
    engine = runEngine(insertedIds);
  } catch {
    engineFailed = true;
    engine = { processed: 0, categorized: 0, transfers: 0, skipped: 0 };
  }
  // MUST-13.7: same post-commit slot as import/flow.ts, on the sync's own inserted ids.
  // Same out-param pattern as flow.ts for F5's loanMatchFailed.
  const loanMatchReport = { failed: false };
  const loanLinksCreated = applyLoanMatchers(insertedIds, undefined, loanMatchReport);
  markSynced(now);

  return {
    ranAt: nowIso(now),
    accounts: results,
    errlist: set.errlist,
    totalAdded: results.reduce((sum, row) => sum + row.added, 0),
    totalDuplicates: results.reduce((sum, row) => sum + row.duplicates, 0),
    engine,
    engineFailed,
    loanLinksCreated,
    loanMatchFailed: loanMatchReport.failed,
  };
}

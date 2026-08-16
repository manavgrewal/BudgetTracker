import { getAccount } from '@/lib/accounts';
import { runEngine, type EngineResult } from '@/lib/categorize/engine';
import { commitImport } from './commit';
import { computeRowHashes } from './dedup';
import type { ImportMapping } from './mapping';
import { parseCsv } from './parse';
import { forkProfileIfBuiltin, setAccountProfile } from './presets';
import { deleteStagedFile, readStagedFile } from './staging';
import { getDb } from '@/db/client';
import { transactions } from '@/db/schema';
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';

export interface CommitFlowResult {
  importId: number;
  profileId: number;
  rowsAdded: number;
  rowsDuplicate: number;
  rowsError: number;
  needsReview: number;
  engine: EngineResult;
  /** true when runEngine threw after the rows were already committed (review-review finding 2). */
  engineFailed: boolean;
}

export function commitStagedImport(input: {
  stagingId: string;
  filename: string;
  accountId: number;
  profileId: number;
  mapping: ImportMapping;
  userId: number;
}): CommitFlowResult {
  const account = getAccount(input.accountId);
  if (!account) throw new Error(`No account ${input.accountId}`);

  const buf = readStagedFile(input.stagingId);

  // Parse (and thereby validate: byte-size cap, row-count cap, per-row
  // errors) BEFORE touching the account's profile pointer. A 413/row-cap
  // failure here must throw before any fork is created or the account is
  // repointed — otherwise the account would end up pointed at a profile
  // that was never actually used to import anything (review finding 3).
  const parsed = parseCsv(buf, input.mapping);
  const hashed = computeRowHashes(input.accountId, parsed.rows);

  // Copy-on-write: an edited built-in forks into a per-account profile.
  // Only reached once the file above is known to be valid.
  const profileId = forkProfileIfBuiltin({
    profileId: input.profileId,
    accountName: account.name,
    mapping: input.mapping,
  });
  setAccountProfile(input.accountId, profileId);

  const committed = commitImport({
    accountId: input.accountId,
    profileId,
    filename: input.filename,
    importedBy: input.userId,
    rows: hashed,
    errors: parsed.errors,
  });

  // Spec section 5 step 5: transfer detection + categorizer run after the insert.
  // The rows are already committed at this point, so a failure here must
  // never surface as an import failure to the user (review finding 2) —
  // the rows just stay categoryless, which the review queue already
  // recognises without any extra bookkeeping.
  let engine: EngineResult;
  let engineFailed = false;
  try {
    engine = runEngine(committed.insertedTransactionIds);
  } catch {
    engineFailed = true;
    engine = { processed: 0, categorized: 0, transfers: 0, skipped: 0 };
  } finally {
    // The staged file has done its job the moment commitImport succeeds —
    // clean it up regardless of what happens to categorization.
    deleteStagedFile(input.stagingId);
  }

  let needsReview = 0;
  if (committed.insertedTransactionIds.length > 0) {
    const row = getDb()
      .select({ c: sql<number>`count(*)` })
      .from(transactions)
      .where(
        and(
          inArray(transactions.id, committed.insertedTransactionIds),
          eq(transactions.isTransfer, false),
          or(isNull(transactions.categoryId), eq(transactions.categorizationSource, 'bayes')),
        ),
      )
      .get();
    needsReview = row?.c ?? 0;
  }

  return {
    importId: committed.importId,
    profileId,
    rowsAdded: committed.rowsAdded,
    rowsDuplicate: committed.rowsDuplicate,
    rowsError: committed.rowsError,
    needsReview,
    engine,
    engineFailed,
  };
}

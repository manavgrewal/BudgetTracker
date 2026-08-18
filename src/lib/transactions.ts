import { and, asc, desc, eq, gte, inArray, isNull, lte, ne, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '@/db/client';
import { accounts, categories, transactions, users } from '@/db/schema';
import { getAccount } from '@/lib/accounts';
import { REVIEW_WHERE, confirmCategory, runEngine, setTransferFlag } from '@/lib/categorize/engine';
import { normalizeMerchant } from '@/lib/categorize/normalize';
import { nowIso } from '@/lib/clock';
import { isIsoDate } from '@/lib/dates';
import { applyLoanMatchers } from '@/lib/loans';

export interface TransactionFilter {
  accountId?: number | null;
  categoryId?: number | 'uncategorized' | null;
  attributedUserId?: number | 'unattributed' | null;
  from?: string | null;
  to?: string | null;
  search?: string | null;
  uncategorizedOnly?: boolean;
  includeTransfers?: boolean;
  page?: number;
  pageSize?: number;
}

export interface TransactionRow {
  id: number;
  date: string;
  accountId: number;
  accountName: string;
  rawDescription: string;
  /** Spec v1.4: what the UI shows when set; raw_description is the fallback. */
  displayDescription: string | null;
  displaySource: 'manual' | 'rename' | null;
  normalizedMerchant: string;
  amountCents: number;
  categoryId: number | null;
  categoryName: string | null;
  source: 'rule' | 'bayes' | 'manual' | 'none';
  confidence: number | null;
  isTransfer: boolean;
  attributedUserId: number | null;
  attributedUserName: string | null;
  notes: string | null;
  importId: number | null;
}

export interface TransactionPage {
  rows: TransactionRow[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
}

export const manualTransactionSchema = z.object({
  accountId: z.number().int().positive(),
  date: z.string().refine(isIsoDate, 'Date must be YYYY-MM-DD'),
  description: z.string().trim().min(1, 'Description is required').max(300),
  amountCents: z.number().int(),
  categoryId: z.number().int().positive().nullable(),
  attributedUserId: z.number().int().positive().nullable(),
  notes: z.string().trim().max(500).nullable().optional(),
});

/** Spec v1.4: display_description when set, raw_description otherwise. */
export function displayNameOf(row: Pick<TransactionRow, 'rawDescription' | 'displayDescription'>): string {
  return row.displayDescription !== null && row.displayDescription.length > 0 ? row.displayDescription : row.rawDescription;
}

const SELECTION = {
  id: transactions.id,
  date: transactions.date,
  accountId: transactions.accountId,
  accountName: accounts.name,
  rawDescription: transactions.rawDescription,
  displayDescription: transactions.displayDescription,
  displaySource: transactions.displaySource,
  normalizedMerchant: transactions.normalizedMerchant,
  amountCents: transactions.amountCents,
  categoryId: transactions.categoryId,
  categoryName: categories.name,
  source: transactions.categorizationSource,
  confidence: transactions.confidence,
  isTransfer: transactions.isTransfer,
  attributedUserId: transactions.attributedUserId,
  attributedUserName: users.name,
  notes: transactions.notes,
  importId: transactions.importId,
} as const;

function baseQuery() {
  return getDb()
    .select(SELECTION)
    .from(transactions)
    .innerJoin(accounts, eq(accounts.id, transactions.accountId))
    .leftJoin(categories, eq(categories.id, transactions.categoryId))
    .leftJoin(users, eq(users.id, transactions.attributedUserId));
}

/**
 * SQL LIKE gives % and _ wildcard meaning, so a user searching for "50%" was matching
 * "50" followed by anything, and "_" matched any single character. Neither is a security
 * hole (the needle is still a bound parameter), but both are silently wrong results.
 * Escaping them (and the escape character itself, first) with an explicit ESCAPE clause
 * makes the search literal, which is what a search box in a finance app should be.
 */
const LIKE_ESCAPE = '\\';

function escapeLikeNeedle(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `${LIKE_ESCAPE}${match}`);
}

function buildWhere(filter: TransactionFilter): SQL | undefined {
  const clauses: SQL[] = [];
  if (typeof filter.accountId === 'number') clauses.push(eq(transactions.accountId, filter.accountId));

  if (filter.categoryId === 'uncategorized') clauses.push(isNull(transactions.categoryId));
  else if (typeof filter.categoryId === 'number') clauses.push(eq(transactions.categoryId, filter.categoryId));

  if (filter.attributedUserId === 'unattributed') clauses.push(isNull(transactions.attributedUserId));
  else if (typeof filter.attributedUserId === 'number') clauses.push(eq(transactions.attributedUserId, filter.attributedUserId));

  if (filter.from) clauses.push(gte(transactions.date, filter.from));
  if (filter.to) clauses.push(lte(transactions.date, filter.to));

  if (filter.search && filter.search.trim().length > 0) {
    const needle = `%${escapeLikeNeedle(filter.search.trim().toUpperCase())}%`;
    const clause = or(
      sql`upper(${transactions.rawDescription}) like ${needle} escape ${LIKE_ESCAPE}`,
      sql`upper(${transactions.normalizedMerchant}) like ${needle} escape ${LIKE_ESCAPE}`,
      // Search what the user can actually see, too (spec v1.4 display names).
      sql`upper(coalesce(${transactions.displayDescription}, '')) like ${needle} escape ${LIKE_ESCAPE}`,
    );
    if (clause) clauses.push(clause);
  }

  if (filter.uncategorizedOnly) clauses.push(isNull(transactions.categoryId));
  if (filter.includeTransfers === false) clauses.push(eq(transactions.isTransfer, false));

  if (clauses.length === 0) return undefined;
  return and(...clauses);
}

export function listTransactions(filter: TransactionFilter = {}): TransactionPage {
  const pageSize = Math.min(200, Math.max(1, filter.pageSize && filter.pageSize > 0 ? filter.pageSize : 50));
  const page = Math.max(1, filter.page ?? 1);
  const where = buildWhere(filter);

  const totalRow = getDb()
    .select({ c: sql<number>`count(*)` })
    .from(transactions)
    .where(where)
    .get();
  const total = totalRow?.c ?? 0;

  const query = baseQuery();
  const rows = (where ? query.where(where) : query)
    .orderBy(desc(transactions.date), desc(transactions.id))
    .limit(pageSize)
    .offset((page - 1) * pageSize)
    .all();

  return { rows, total, page, pageSize, pageCount: Math.max(1, Math.ceil(total / pageSize)) };
}

export function getTransaction(id: number): TransactionRow | null {
  return baseQuery().where(eq(transactions.id, id)).get() ?? null;
}

export function createManualTransaction(input: {
  accountId: number;
  date: string;
  description: string;
  amountCents: number;
  categoryId: number | null;
  attributedUserId: number | null;
  notes?: string | null;
  userId: number;
}): number {
  const parsed = manualTransactionSchema.parse({
    accountId: input.accountId,
    date: input.date,
    description: input.description,
    amountCents: input.amountCents,
    categoryId: input.categoryId,
    attributedUserId: input.attributedUserId,
    notes: input.notes ?? null,
  });

  const account = getAccount(parsed.accountId);
  if (!account) throw new Error(`No account ${parsed.accountId}`);
  const timestamp = nowIso();

  const row = getDb()
    .insert(transactions)
    .values({
      accountId: parsed.accountId,
      importId: null,
      attributedUserId: parsed.attributedUserId ?? account.ownerUserId ?? null,
      date: parsed.date,
      rawDescription: parsed.description,
      normalizedMerchant: normalizeMerchant(parsed.description),
      amountCents: parsed.amountCents,
      categoryId: null,
      categorizationSource: 'none',
      confidence: null,
      isTransfer: false,
      notes: parsed.notes ?? null,
      // Manual entries are exempt from dedup: two identical $5 coffees are legitimate.
      dedupHash: null,
      hashVersion: 1,
      createdBy: input.userId,
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    .returning({ id: transactions.id })
    .get();

  // The engine runs on manual entries too, always. A hand-typed "TD VISA PAYMENT" is
  // just as much a transfer as an imported one, and rename rules should apply to the
  // display name either way. Previously a manual entry that arrived WITH a category
  // skipped the engine entirely, so it could never be flagged as a transfer.
  //
  // Order matters: runEngine's eligibility filter only touches rows that are
  // uncategorized or Bayes-guessed, so it has to see this row before confirmCategory
  // stamps source='manual' on it. confirmCategory then overwrites whatever the engine
  // guessed with the user's explicit choice, and never touches is_transfer or the
  // display columns, so the manual category survives and the transfer flag sticks.
  runEngine([row.id]);
  if (parsed.categoryId !== null) {
    confirmCategory({ transactionId: row.id, categoryId: parsed.categoryId, userId: input.userId });
  }
  // MUST-13.7: a hand-typed loan payment is a loan payment. Runs after confirmCategory so
  // the row is in its final state, and is cheap when no loan rules exist.
  applyLoanMatchers([row.id]);
  return row.id;
}

export function updateTransactionNotes(id: number, notes: string | null): void {
  getDb().update(transactions).set({ notes, updatedAt: nowIso() }).where(eq(transactions.id, id)).run();
}

/** Attribution edits never touch created_by (who entered it). Only who spent it. */
export function bulkSetAttribution(ids: number[], attributedUserId: number | null): number {
  if (ids.length === 0) return 0;
  const result = getDb()
    .update(transactions)
    .set({ attributedUserId, updatedAt: nowIso() })
    .where(inArray(transactions.id, ids))
    .run();
  return Number(result.changes ?? 0);
}

export function bulkSetCategory(ids: number[], categoryId: number, userId: number, createRules: boolean): number {
  let changed = 0;
  for (const id of ids) {
    confirmCategory({ transactionId: id, categoryId, userId, createRule: createRules });
    changed += 1;
  }
  return changed;
}

export function bulkSetTransfer(ids: number[], isTransfer: boolean, userId: number): number {
  let changed = 0;
  for (const id of ids) {
    setTransferFlag({ transactionId: id, isTransfer, userId });
    changed += 1;
  }
  return changed;
}

/**
 * The queue definition itself lives in engine.ts (REVIEW_WHERE) and is imported, not
 * restated: this function, reviewQueueIds and reviewQueueCount must agree on what
 * "needs review" means, and a copy here had already been maintained twice.
 */
export function listReviewQueue(limit = 100, offset = 0): TransactionRow[] {
  return baseQuery()
    .where(REVIEW_WHERE)
    .orderBy(asc(transactions.date), asc(transactions.id))
    .limit(limit)
    .offset(offset)
    .all();
}

export function countMatchingMerchant(normalizedMerchant: string): number {
  const row = getDb()
    .select({ c: sql<number>`count(*)` })
    .from(transactions)
    .where(and(eq(transactions.normalizedMerchant, normalizedMerchant), eq(transactions.isTransfer, false)))
    .get();
  return row?.c ?? 0;
}

/** Exported for the transactions page's "not this category" filter chips. */
export function countExcludingCategory(categoryId: number): number {
  const row = getDb()
    .select({ c: sql<number>`count(*)` })
    .from(transactions)
    .where(or(ne(transactions.categoryId, categoryId), isNull(transactions.categoryId)))
    .get();
  return row?.c ?? 0;
}

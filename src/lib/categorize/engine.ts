import { and, asc, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { transactions } from '@/db/schema';
import { nowIso } from '@/lib/clock';
import { classify, train, untrain } from './bayes';
import { tokenize } from './normalize';
import {
  bumpRuleUsage,
  deleteExactRule,
  deleteRule,
  listRules,
  matchRule,
  upsertRuleFromCorrection,
  type MatchType,
  type MerchantRuleRecord,
} from './rules';

/**
 * Card-payment patterns ONLY (spec section 4).
 * E-transfers are deliberately absent: an e-transfer to your own account is
 * textually indistinguishable from rent to a landlord or a gift, and
 * auto-flagging would silently erase real spending from every report.
 */
export const CARD_PAYMENT_PATTERNS: readonly string[] = [
  'PAYMENT - THANK YOU',
  'PAYMENT THANK YOU',
  'PAIEMENT - MERCI',
  'TD VISA PAYMENT',
  'VISA PAYMENT',
  'MASTERCARD PAYMENT',
  'AMEX PAYMENT',
  'AMERICAN EXPRESS PAYMENT',
  'CREDIT CARD PAYMENT',
  'CREDIT CARD/LOC PAY',
  'TFR-TO',
  'TFR-FR',
  'TRANSFER TO C/C',
  'TRANSFER FROM C/C',
];

export interface EngineTxn {
  id: number;
  normalizedMerchant: string;
}

export interface CategorizeOutcome {
  categoryId: number | null;
  source: 'rule' | 'bayes' | 'none';
  confidence: number | null;
  isTransfer: boolean;
  matchedRuleId: number | null;
}

export interface CategorizeContext {
  rules: MerchantRuleRecord[];
}

export function buildContext(): CategorizeContext {
  return { rules: listRules() };
}

export function detectTransfer(normalizedMerchant: string, ctx: CategorizeContext): boolean {
  // An exact 'not_transfer' override wins outright and skips the pattern list
  // entirely: it exists specifically to undo a manual "not a transfer" toggle
  // on a merchant the CARD_PAYMENT_PATTERNS list would otherwise re-catch on
  // every future import/re-run.
  if (matchRule(normalizedMerchant, 'not_transfer', ctx.rules) !== null) return false;

  for (const pattern of CARD_PAYMENT_PATTERNS) {
    if (normalizedMerchant.includes(pattern)) return true;
  }
  // Learned transfer rules are exact-match only, by design.
  return matchRule(normalizedMerchant, 'transfer', ctx.rules) !== null;
}

export function categorizeTransaction(txn: EngineTxn, ctx: CategorizeContext): CategorizeOutcome {
  if (detectTransfer(txn.normalizedMerchant, ctx)) {
    return { categoryId: null, source: 'none', confidence: null, isTransfer: true, matchedRuleId: null };
  }

  const rule = matchRule(txn.normalizedMerchant, 'category', ctx.rules);
  if (rule && rule.categoryId !== null) {
    return { categoryId: rule.categoryId, source: 'rule', confidence: null, isTransfer: false, matchedRuleId: rule.id };
  }

  const guess = classify(tokenize(txn.normalizedMerchant));
  if (guess) {
    return { categoryId: guess.categoryId, source: 'bayes', confidence: guess.margin, isTransfer: false, matchedRuleId: null };
  }

  return { categoryId: null, source: 'none', confidence: null, isTransfer: false, matchedRuleId: null };
}

export interface EngineResult {
  processed: number;
  categorized: number;
  transfers: number;
  skipped: number;
}

/** Only rows with category_id IS NULL or source = 'bayes' are ever touched. */
const ELIGIBLE = or(isNull(transactions.categoryId), eq(transactions.categorizationSource, 'bayes'));

/** Chunked well under SQLite's default 999 bound-parameter limit (see dedup.ts). */
const ID_CHUNK = 400;

function selectRowsByIds(ids: number[]) {
  const db = getDb();
  const rows: {
    id: number;
    normalizedMerchant: string;
    categoryId: number | null;
    source: 'rule' | 'bayes' | 'manual' | 'none';
  }[] = [];
  for (let offset = 0; offset < ids.length; offset += ID_CHUNK) {
    const chunk = ids.slice(offset, offset + ID_CHUNK);
    rows.push(
      ...db
        .select({
          id: transactions.id,
          normalizedMerchant: transactions.normalizedMerchant,
          categoryId: transactions.categoryId,
          source: transactions.categorizationSource,
        })
        .from(transactions)
        .where(inArray(transactions.id, chunk))
        .all(),
    );
  }
  return rows;
}

export function runEngine(txnIds: number[]): EngineResult {
  if (txnIds.length === 0) return { processed: 0, categorized: 0, transfers: 0, skipped: 0 };

  const db = getDb();
  let result: EngineResult = { processed: 0, categorized: 0, transfers: 0, skipped: 0 };

  // The rename pass, the categorization pass and the rule-hit bumps must land
  // atomically as one unit of work, not three independent commits — a crash
  // between them would otherwise leave categorization and display state (or
  // rule hit counts) inconsistent. better-sqlite3 nests via SAVEPOINT when a
  // transaction is opened while one is already active (applyRenameRules opens
  // its own), so this composes safely.
  db.transaction((tx) => {
    const rows = selectRowsByIds(txnIds);
    const ctx = buildContext();

    // Display renames are a presentation pass over ALL the given rows — independent
    // of the categorization eligibility filter, because a row whose category is
    // already confirmed can still need its display name refreshed.
    applyRenameRules(txnIds, ctx);

    const eligible = rows.filter((row) => row.categoryId === null || row.source === 'bayes');
    const skipped = rows.length - eligible.length;

    const at = new Date();
    let categorized = 0;
    let transfers = 0;
    const ruleHits = new Map<number, number>();

    for (const row of eligible) {
      const outcome = categorizeTransaction({ id: row.id, normalizedMerchant: row.normalizedMerchant }, ctx);
      if (outcome.isTransfer) transfers += 1;
      if (outcome.categoryId !== null) categorized += 1;
      if (outcome.matchedRuleId !== null) {
        ruleHits.set(outcome.matchedRuleId, (ruleHits.get(outcome.matchedRuleId) ?? 0) + 1);
      }
      tx.update(transactions)
        .set({
          categoryId: outcome.categoryId,
          categorizationSource: outcome.source,
          confidence: outcome.confidence,
          isTransfer: outcome.isTransfer,
          updatedAt: nowIso(at),
        })
        .where(eq(transactions.id, row.id))
        .run();
    }

    for (const [ruleId, hits] of ruleHits) {
      for (let i = 0; i < hits; i += 1) bumpRuleUsage(ruleId, at);
    }

    result = { processed: eligible.length, categorized, transfers, skipped };
  });

  return result;
}

export function eligibleForRerun(scope: { accountId?: number } = {}): number[] {
  const where = scope.accountId === undefined ? ELIGIBLE : and(ELIGIBLE, eq(transactions.accountId, scope.accountId));
  return getDb()
    .select({ id: transactions.id })
    .from(transactions)
    .where(where)
    .orderBy(asc(transactions.id))
    .all()
    .map((row) => row.id);
}

export function rerunEngine(scope: { accountId?: number } = {}): EngineResult {
  return runEngine(eligibleForRerun(scope));
}

/**
 * The confirmed state. Sets source = 'manual' (the Bayes training set),
 * upserts an exact merchant rule, and updates token counts, decrementing the
 * previous category on a recategorization.
 */
export function confirmCategory(input: {
  transactionId: number;
  categoryId: number;
  userId: number;
  createRule?: boolean;
  at?: Date;
}): void {
  const db = getDb();
  const at = input.at ?? new Date();
  const row = db
    .select({
      normalizedMerchant: transactions.normalizedMerchant,
      categoryId: transactions.categoryId,
      source: transactions.categorizationSource,
    })
    .from(transactions)
    .where(eq(transactions.id, input.transactionId))
    .get();
  if (!row) throw new Error(`No transaction ${input.transactionId}`);

  const tokens = tokenize(row.normalizedMerchant);

  if (row.source === 'manual' && row.categoryId !== null) {
    if (row.categoryId === input.categoryId) {
      // Already confirmed to the same category: nothing to retrain.
      return;
    }
    untrain(tokens, row.categoryId);
  }

  db.update(transactions)
    .set({
      categoryId: input.categoryId,
      categorizationSource: 'manual',
      confidence: null,
      updatedAt: nowIso(at),
    })
    .where(eq(transactions.id, input.transactionId))
    .run();

  if (input.createRule !== false && row.normalizedMerchant.length > 0) {
    upsertRuleFromCorrection({
      pattern: row.normalizedMerchant,
      matchType: 'exact',
      ruleKind: 'category',
      categoryId: input.categoryId,
      createdBy: input.userId,
      at,
    });
  }

  train(tokens, input.categoryId);
}

export function clearCategory(input: { transactionId: number; userId: number; at?: Date }): void {
  const db = getDb();
  const row = db
    .select({
      normalizedMerchant: transactions.normalizedMerchant,
      categoryId: transactions.categoryId,
      source: transactions.categorizationSource,
    })
    .from(transactions)
    .where(eq(transactions.id, input.transactionId))
    .get();
  if (!row) throw new Error(`No transaction ${input.transactionId}`);

  if (row.source === 'manual' && row.categoryId !== null) {
    untrain(tokenize(row.normalizedMerchant), row.categoryId);
  }
  deleteExactRule(row.normalizedMerchant, 'category');

  db.update(transactions)
    .set({ categoryId: null, categorizationSource: 'none', confidence: null, updatedAt: nowIso(input.at ?? new Date()) })
    .where(eq(transactions.id, input.transactionId))
    .run();
}

export function setTransferFlag(input: { transactionId: number; isTransfer: boolean; userId: number; at?: Date }): void {
  const db = getDb();
  const at = input.at ?? new Date();
  const row = db
    .select({ normalizedMerchant: transactions.normalizedMerchant })
    .from(transactions)
    .where(eq(transactions.id, input.transactionId))
    .get();
  if (!row) throw new Error(`No transaction ${input.transactionId}`);

  db.update(transactions)
    .set({ isTransfer: input.isTransfer, updatedAt: nowIso(at) })
    .where(eq(transactions.id, input.transactionId))
    .run();

  if (input.isTransfer) {
    // EXACT match only: a contains rule learned from an e-transfer description
    // would over-match every unrelated e-transfer.
    upsertRuleFromCorrection({
      pattern: row.normalizedMerchant,
      matchType: 'exact',
      ruleKind: 'transfer',
      categoryId: null,
      createdBy: input.userId,
      at,
    });
    // Re-flagging as a transfer must undo any earlier "not a transfer" override
    // on this exact merchant, or detectTransfer's not_transfer check (which runs
    // first) would keep silently vetoing this very rule on every future re-run.
    deleteExactRule(row.normalizedMerchant, 'not_transfer');
  } else if (CARD_PAYMENT_PATTERNS.some((pattern) => row.normalizedMerchant.includes(pattern))) {
    // The card-payment pattern list would re-catch this merchant on the very
    // next runEngine/rerun. Merely deleting a (nonexistent) transfer rule would
    // not stop that, so teach an exact 'not_transfer' override instead.
    upsertRuleFromCorrection({
      pattern: row.normalizedMerchant,
      matchType: 'exact',
      ruleKind: 'not_transfer',
      categoryId: null,
      createdBy: input.userId,
      at,
    });
  } else {
    // Only a learned transfer rule (or a purely manual flag) could have flagged
    // this row — today's behaviour is unchanged: remove that rule.
    deleteExactRule(row.normalizedMerchant, 'transfer');
  }
}

/** "Apply category to all N matching transactions + create rule" (bulk action). */
export function applyCategoryToMatching(input: {
  normalizedMerchant: string;
  categoryId: number;
  userId: number;
  at?: Date;
}): number {
  const ids = getDb()
    .select({ id: transactions.id })
    .from(transactions)
    .where(
      and(
        eq(transactions.normalizedMerchant, input.normalizedMerchant),
        eq(transactions.isTransfer, false),
        or(ne(transactions.categoryId, input.categoryId), isNull(transactions.categoryId)),
      ),
    )
    .all()
    .map((row) => row.id);

  for (const id of ids) {
    confirmCategory({ transactionId: id, categoryId: input.categoryId, userId: input.userId, createRule: false, at: input.at });
  }
  if (ids.length > 0) {
    upsertRuleFromCorrection({
      pattern: input.normalizedMerchant,
      matchType: 'exact',
      ruleKind: 'category',
      categoryId: input.categoryId,
      createdBy: input.userId,
      at: input.at,
    });
  }
  return ids.length;
}

/**
 * Review queue = uncategorized rows plus auto-assigned-but-unconfirmed Bayes rows.
 * Transfers are excluded: spec section 3 removes them from all spend/income
 * reporting, so they never need a category.
 */
const REVIEW_WHERE = and(
  eq(transactions.isTransfer, false),
  or(isNull(transactions.categoryId), eq(transactions.categorizationSource, 'bayes')),
);

export function reviewQueueIds(limit = 100, offset = 0): number[] {
  return getDb()
    .select({ id: transactions.id })
    .from(transactions)
    .where(REVIEW_WHERE)
    .orderBy(asc(transactions.date), asc(transactions.id))
    .limit(limit)
    .offset(offset)
    .all()
    .map((row) => row.id);
}

export function reviewQueueCount(): number {
  const row = getDb()
    .select({ c: sql<number>`count(*)` })
    .from(transactions)
    .where(REVIEW_WHERE)
    .get();
  return row?.c ?? 0;
}

// ------------------------------------------------- merchant renames (v1.4)

/** The rename text a merchant resolves to, or null when no rename rule matches. */
export function resolveRename(normalizedMerchant: string, ctx: CategorizeContext): string | null {
  const rule = matchRule(normalizedMerchant, 'rename', ctx.rules);
  if (!rule || rule.renameTo === null || rule.renameTo.length === 0) return null;
  return rule.renameTo;
}

/**
 * Applies rename rules to the given rows (all rows when txnIds is omitted).
 *
 * Precedence is manual > rename > unset:
 *   - display_source = 'manual' rows are NEVER read or written here.
 *   - a matching rule sets display_description + display_source = 'rename'.
 *   - a row previously set by a rule that no longer matches is cleared back to raw.
 *
 * raw_description and normalized_merchant are never written, so the frozen dedup
 * hash and every categorizer input are untouched by anything in this function.
 */
export function applyRenameRules(txnIds?: number[], ctx: CategorizeContext = buildContext()): number {
  const db = getDb();
  const scope = txnIds === undefined ? undefined : txnIds;
  if (scope !== undefined && scope.length === 0) return 0;

  const columns = {
    id: transactions.id,
    normalizedMerchant: transactions.normalizedMerchant,
    displayDescription: transactions.displayDescription,
    displaySource: transactions.displaySource,
  } as const;

  const rows: {
    id: number;
    normalizedMerchant: string;
    displayDescription: string | null;
    displaySource: 'manual' | 'rename' | null;
  }[] = [];

  if (scope === undefined) {
    rows.push(...db.select(columns).from(transactions).where(ne(transactions.displaySource, 'manual')).all());
    // ne() drops NULLs in SQL three-valued logic, so fetch NULL display_source rows too.
    rows.push(...db.select(columns).from(transactions).where(isNull(transactions.displaySource)).all());
  } else {
    for (let offset = 0; offset < scope.length; offset += ID_CHUNK) {
      const chunk = scope.slice(offset, offset + ID_CHUNK);
      rows.push(
        ...db
          .select(columns)
          .from(transactions)
          .where(and(inArray(transactions.id, chunk), ne(transactions.displaySource, 'manual')))
          .all(),
      );
      // ne() drops NULLs in SQL three-valued logic, so fetch NULL display_source rows too.
      rows.push(
        ...db
          .select(columns)
          .from(transactions)
          .where(and(inArray(transactions.id, chunk), isNull(transactions.displaySource)))
          .all(),
      );
    }
  }

  const at = nowIso();
  let changed = 0;

  db.transaction((tx) => {
    for (const row of rows) {
      const rename = resolveRename(row.normalizedMerchant, ctx);

      if (rename === null) {
        // Only clear what a rule set; a NULL display_source row has nothing to clear.
        if (row.displaySource === 'rename') {
          tx.update(transactions)
            .set({ displayDescription: null, displaySource: null, updatedAt: at })
            .where(eq(transactions.id, row.id))
            .run();
          changed += 1;
        }
        continue;
      }

      if (row.displaySource === 'rename' && row.displayDescription === rename) continue;

      tx.update(transactions)
        .set({ displayDescription: rename, displaySource: 'rename', updatedAt: at })
        .where(eq(transactions.id, row.id))
        .run();
      changed += 1;
    }
  });

  return changed;
}

/** "This transaction only": manual always wins and is never overwritten by a rule. */
export function setTransactionDisplayName(input: {
  transactionId: number;
  displayDescription: string | null;
  userId: number;
  at?: Date;
}): void {
  const trimmed = input.displayDescription === null ? null : input.displayDescription.trim();
  const db = getDb();

  if (trimmed === null || trimmed.length === 0) {
    // Clearing a manual rename hands the row back to the rules.
    db.update(transactions)
      .set({ displayDescription: null, displaySource: null, updatedAt: nowIso(input.at ?? new Date()) })
      .where(eq(transactions.id, input.transactionId))
      .run();
    applyRenameRules([input.transactionId]);
    return;
  }

  db.update(transactions)
    .set({ displayDescription: trimmed, displaySource: 'manual', updatedAt: nowIso(input.at ?? new Date()) })
    .where(eq(transactions.id, input.transactionId))
    .run();
}

/** "All matching + future": create/update the rule, then bulk-apply it retroactively. */
export function upsertRenameRule(input: {
  pattern: string;
  matchType: MatchType;
  renameTo: string;
  userId: number;
  at?: Date;
}): { ruleId: number; rowsUpdated: number } {
  const renameTo = input.renameTo.trim();
  if (renameTo.length === 0) throw new Error('A rename rule needs a non-empty display name');
  if (input.pattern.trim().length === 0) throw new Error('A rename rule needs a pattern');

  const ruleId = upsertRuleFromCorrection({
    pattern: input.pattern,
    matchType: input.matchType,
    ruleKind: 'rename',
    categoryId: null,
    renameTo,
    createdBy: input.userId,
    at: input.at,
  });
  const rowsUpdated = applyRenameRules(undefined, buildContext());
  return { ruleId, rowsUpdated };
}

export function deleteRenameRule(input: { pattern: string; matchType: MatchType }): {
  ruleId: number | null;
  rowsCleared: number;
} {
  const existing = listRules('rename').find((rule) => rule.pattern === input.pattern && rule.matchType === input.matchType);
  if (!existing) return { ruleId: null, rowsCleared: 0 };
  deleteRule(existing.id);
  const rowsCleared = applyRenameRules(undefined, buildContext());
  return { ruleId: existing.id, rowsCleared };
}

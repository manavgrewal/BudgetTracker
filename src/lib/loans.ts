import { and, asc, eq, gte, inArray, sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { loanMatcherRules, loanPayments, transactions, users, warrantyItemTypes, warrantyItems } from '@/db/schema';
import { nowIso } from '@/lib/clock';
import { addDaysIso, addMonthsClamped, todayIso } from '@/lib/dates';
import type { RateVerdict } from '@/lib/notify/ratelimit';
import type { BillingCycle } from '@/lib/warranty/constants';

/**
 * Loan money-tracking (spec 2026-08-17 §13).
 *
 * MUST-13.1: interest_rate_bps is DISPLAY ONLY. Nothing in this file multiplies, accrues,
 * projects or amortises with it, and tests/ops/loan-invariants.test.ts asserts that by grep.
 *
 * MUST-13.2: loan payments STAY in their spending category and in every budget. Nothing here
 * writes is_transfer, category_id or attributed_user_id, and nothing here touches the
 * `transactions` table at all. A car payment is money that left the household this month;
 * hiding it from the budget would make the budget wrong.
 */
export const MAX_RULES_PER_LOAN = 5;
export const LOAN_BACKFILL_DAYS = 365;
export const LOAN_BACKFILL_MAX = 500;

/**
 * MUST-14.12 / MUST-14.13: the third in-memory bucket in the codebase (notify's, update's,
 * this one). They stay separate because their windows, scopes and reset semantics differ and
 * a shared abstraction over three call sites would be one abstraction and three special
 * cases. If a fourth appears, extract then.
 *
 * This is the ONE loan action that carries a limit: ordinary loan CRUD and assign/unassign
 * carry none, consistent with every existing warranty and transaction action. The backfill
 * is the only expensive one — it scans up to a year of transactions.
 */
export const BACKFILL_WINDOW_MS = 10 * 60_000;
export const BACKFILL_MAX_GLOBAL = 5;

let backfillClock: () => number = () => Date.now();
const backfillStamps: number[] = [];

export function setLoanRateLimitClockForTests(next: (() => number) | null): void {
  backfillClock = next ?? (() => Date.now());
}

export function resetLoanRateLimitsForTests(): void {
  backfillStamps.length = 0;
}

export function checkLoanBackfill(now: number = backfillClock()): RateVerdict {
  while (backfillStamps.length > 0 && (backfillStamps[0] as number) <= now - BACKFILL_WINDOW_MS) backfillStamps.shift();
  if (backfillStamps.length >= BACKFILL_MAX_GLOBAL) {
    const oldest = backfillStamps[0] ?? now;
    const waitMs = Math.max(0, oldest + BACKFILL_WINDOW_MS - now);
    return { allowed: false, retryAfterMinutes: Math.max(1, Math.ceil(waitMs / 60_000)) };
  }
  backfillStamps.push(now);
  return { allowed: true, retryAfterMinutes: 0 };
}

// ---------------------------------------------------------------- matcher rules

export interface LoanRule {
  id: number;
  itemId: number;
  merchantContains: string;
  accountId: number | null;
  enabled: boolean;
}

export function listLoanRules(itemId: number): LoanRule[] {
  return getDb()
    .select({
      id: loanMatcherRules.id,
      itemId: loanMatcherRules.itemId,
      merchantContains: loanMatcherRules.merchantContains,
      accountId: loanMatcherRules.accountId,
      enabled: loanMatcherRules.enabled,
    })
    .from(loanMatcherRules)
    .where(eq(loanMatcherRules.itemId, itemId))
    .orderBy(asc(loanMatcherRules.id))
    .all();
}

/**
 * MUST-11.11: merchant_contains is stored UPPERCASED, because it is compared against
 * transactions.normalized_merchant and normalizeMerchant() uppercases. No lower() wrapper on
 * either side. (This is the same normalizer-casing trap the notify build hit in its R1
 * review finding; it is called out here so it is not hit twice.)
 *
 * MUST-11.12: MAX_RULES_PER_LOAN is enforced here as well as in the action, so a caller that
 * does not route through the action cannot exceed it either.
 */
export function saveLoanRule(input: {
  itemId: number;
  merchantContains: string;
  accountId: number | null;
  enabled: boolean;
  at?: Date;
}): number {
  const at = nowIso(input.at ?? new Date());
  const merchant = input.merchantContains.trim().toUpperCase();
  if (merchant.length < 3) throw new Error('Use at least three characters, or this will match almost everything.');
  if (listLoanRules(input.itemId).length >= MAX_RULES_PER_LOAN) throw new Error('Five rules per loan is the limit.');
  const row = getDb()
    .insert(loanMatcherRules)
    .values({
      itemId: input.itemId,
      merchantContains: merchant,
      accountId: input.accountId,
      enabled: input.enabled,
      createdAt: at,
      updatedAt: at,
    })
    .returning({ id: loanMatcherRules.id })
    .get();
  return row.id;
}

export function deleteLoanRule(id: number): boolean {
  return getDb().delete(loanMatcherRules).where(eq(loanMatcherRules.id, id)).run().changes > 0;
}

// ---------------------------------------------------------------- links

export interface LoanLink {
  id: number;
  txnId: number;
  itemId: number;
  itemName: string;
  amountCents: number;
  appliedCents: number;
  source: 'rule' | 'manual';
}

/** One query, served by loan_payments_txn_idx. Used by the transactions page. */
export function loanLinksForTransactions(txnIds: number[]): Map<number, LoanLink[]> {
  const out = new Map<number, LoanLink[]>();
  if (txnIds.length === 0) return out;
  const rows = getDb()
    .select({
      id: loanPayments.id,
      txnId: loanPayments.txnId,
      itemId: loanPayments.itemId,
      itemName: warrantyItems.name,
      amountCents: loanPayments.amountCents,
      appliedCents: loanPayments.appliedCents,
      source: loanPayments.source,
    })
    .from(loanPayments)
    .innerJoin(warrantyItems, eq(warrantyItems.id, loanPayments.itemId))
    .where(inArray(loanPayments.txnId, txnIds))
    .orderBy(asc(loanPayments.id))
    .all();
  for (const row of rows) {
    const list = out.get(row.txnId) ?? [];
    list.push(row);
    out.set(row.txnId, list);
  }
  return out;
}

interface ActiveRule {
  ruleId: number;
  itemId: number;
  merchantContains: string;
  accountId: number | null;
  balanceCents: number;
}

/**
 * Every ENABLED rule whose item is a loan-kind item with a non-null current_balance_cents,
 * in ONE query. This is the loans-side dormancy bail: a household with no loans pays one
 * indexed read per import and nothing else (AC5).
 */
function activeRules(tx: ReturnType<typeof getDb>): ActiveRule[] {
  return tx
    .select({
      ruleId: loanMatcherRules.id,
      itemId: loanMatcherRules.itemId,
      merchantContains: loanMatcherRules.merchantContains,
      accountId: loanMatcherRules.accountId,
      balanceCents: sql<number>`${warrantyItems.currentBalanceCents}`,
    })
    .from(loanMatcherRules)
    .innerJoin(warrantyItems, eq(warrantyItems.id, loanMatcherRules.itemId))
    .innerJoin(warrantyItemTypes, eq(warrantyItemTypes.id, warrantyItems.typeId))
    .where(
      and(
        eq(loanMatcherRules.enabled, true),
        eq(warrantyItemTypes.kind, 'loan'),
        sql`${warrantyItems.currentBalanceCents} is not null`,
      ),
    )
    .orderBy(asc(loanMatcherRules.id))
    .all();
}

/**
 * MUST-11.15: the link row IS the guard. INSERT ... ON CONFLICT DO NOTHING, and the
 * decrement runs in the SAME statement sequence, conditional on changes > 0 — so a crash
 * between "decide to apply" and "record that we applied" is impossible.
 *
 * MUST-11.14 / MUST-13.6: applied_cents records the CLAMPED figure, so a reversal restores
 * the balance exactly, with no drift, in every clamping case. A payment against a loan
 * already at zero produces a link row with applied_cents = 0 — the payment is recorded, the
 * balance stays at zero, and nothing is silently swallowed.
 */
function link(
  tx: ReturnType<typeof getDb>,
  input: { txnId: number; itemId: number; amountCents: number; balanceCents: number; source: 'rule' | 'manual'; at: string },
): number | null {
  const applied = Math.max(0, Math.min(input.amountCents, input.balanceCents));
  const result = tx
    .insert(loanPayments)
    .values({
      txnId: input.txnId,
      itemId: input.itemId,
      amountCents: input.amountCents,
      appliedCents: applied,
      source: input.source,
      createdAt: input.at,
    })
    .onConflictDoNothing()
    .run();
  if (result.changes === 0) return null;
  if (applied > 0) {
    tx.update(warrantyItems)
      .set({ currentBalanceCents: sql`${warrantyItems.currentBalanceCents} - ${applied}` })
      // MUST-11.8: balance_updated_at is NOT touched. It is the human anchor.
      .where(eq(warrantyItems.id, input.itemId))
      .run();
  }
  return applied;
}

interface Candidate {
  id: number;
  accountId: number;
  normalizedMerchant: string;
  amountCents: number;
  isTransfer: boolean;
}

function candidates(tx: ReturnType<typeof getDb>, txnIds: number[]): Candidate[] {
  return tx
    .select({
      id: transactions.id,
      accountId: transactions.accountId,
      normalizedMerchant: transactions.normalizedMerchant,
      amountCents: transactions.amountCents,
      isTransfer: transactions.isTransfer,
    })
    .from(transactions)
    .where(inArray(transactions.id, txnIds))
    .orderBy(asc(transactions.id))
    .all();
}

function alreadyLinked(tx: ReturnType<typeof getDb>, txnIds: number[]): Set<number> {
  if (txnIds.length === 0) return new Set();
  const rows = tx.select({ txnId: loanPayments.txnId }).from(loanPayments).where(inArray(loanPayments.txnId, txnIds)).all();
  return new Set(rows.map((row) => row.txnId));
}

/**
 * MUST-13.3: the rule matcher, in one db.transaction.
 *
 * MUST-13.4 (one link per transaction, from the rule path): step 3's "already has any link"
 * check and step 4's "first rule by id wins" together guarantee the rule path creates at most
 * one link per transaction, EVER. Without it, two loans whose rules both match one merchant
 * string would each take the full payment off their balance and the household would appear
 * to have paid twice.
 *
 * MUST-13.5: this function NEVER throws into its caller. A loan-matching failure may not
 * break an import, a SimpleFIN sync, a manual entry or a category confirmation.
 */
export function applyLoanMatchers(txnIds: number[], at: Date = new Date()): number {
  if (txnIds.length === 0) return 0;
  try {
    const stamp = nowIso(at);
    return getDb().transaction((tx) => {
      const rules = activeRules(tx);
      if (rules.length === 0) return 0; // the loans-side dormancy bail
      const balances = new Map(rules.map((rule) => [rule.itemId, rule.balanceCents]));
      const linked = alreadyLinked(tx, txnIds);

      let created = 0;
      for (const txn of candidates(tx, txnIds)) {
        if (txn.isTransfer) continue;
        if (txn.amountCents >= 0) continue; // a loan payment is money out
        if (linked.has(txn.id)) continue;

        const match = rules.find(
          (rule) =>
            txn.normalizedMerchant.includes(rule.merchantContains) &&
            (rule.accountId === null || rule.accountId === txn.accountId),
        );
        if (match === undefined) continue;

        const amount = Math.abs(txn.amountCents);
        const applied = link(tx, {
          txnId: txn.id,
          itemId: match.itemId,
          amountCents: amount,
          balanceCents: balances.get(match.itemId) ?? 0,
          source: 'rule',
          at: stamp,
        });
        if (applied === null) continue;
        balances.set(match.itemId, (balances.get(match.itemId) ?? 0) - applied);
        linked.add(txn.id);
        created += 1;
      }
      return created;
    });
  } catch (error) {
    console.error('[loans] matcher failed', error);
    return 0;
  }
}

/**
 * MUST-13.9 / MUST-13.10: the opt-in historical pass. Scans transactions with
 * date >= addDaysIso(today, -LOAN_BACKFILL_DAYS) — served by transactions_date_idx — applies
 * the same matching and clamping rules, and stops after LOAN_BACKFILL_MAX links. One
 * transaction, and it reports both the count and the total applied so a mistake is visible
 * immediately rather than discovered a month later.
 */
export function backfillLoanRule(
  ruleId: number,
  opts: { days?: number; max?: number; at?: Date } = {},
): { linked: number; appliedCents: number } {
  const at = opts.at ?? new Date();
  const since = addDaysIso(todayIso(at), -(opts.days ?? LOAN_BACKFILL_DAYS));
  const cap = opts.max ?? LOAN_BACKFILL_MAX;
  try {
    const stamp = nowIso(at);
    return getDb().transaction((tx) => {
      const rule = activeRules(tx).find((candidate) => candidate.ruleId === ruleId);
      if (rule === undefined) return { linked: 0, appliedCents: 0 };

      const rows = tx
        .select({
          id: transactions.id,
          accountId: transactions.accountId,
          amountCents: transactions.amountCents,
        })
        .from(transactions)
        .where(
          and(
            gte(transactions.date, since),
            eq(transactions.isTransfer, false),
            sql`${transactions.amountCents} < 0`,
            sql`instr(${transactions.normalizedMerchant}, ${rule.merchantContains}) > 0`,
            rule.accountId === null ? sql`1 = 1` : eq(transactions.accountId, rule.accountId),
            sql`not exists (select 1 from ${loanPayments} lp where lp.txn_id = ${transactions.id})`,
          ),
        )
        .orderBy(asc(transactions.date), asc(transactions.id))
        .limit(cap)
        .all();

      let balance = rule.balanceCents;
      let linked = 0;
      let appliedTotal = 0;
      for (const row of rows) {
        const applied = link(tx, {
          txnId: row.id,
          itemId: rule.itemId,
          amountCents: Math.abs(row.amountCents),
          balanceCents: balance,
          source: 'rule',
          at: stamp,
        });
        if (applied === null) continue;
        balance -= applied;
        appliedTotal += applied;
        linked += 1;
      }
      return { linked, appliedCents: appliedTotal };
    });
  } catch (error) {
    console.error('[loans] backfill failed', error);
    return { linked: 0, appliedCents: 0 };
  }
}

/**
 * MUST-13.11: the same insert-and-decrement as the rule path, with source 'manual' and two
 * differences: it does NOT skip a transaction that already has a link to a DIFFERENT loan
 * (MUST-11.16 — a combined payment is legitimate), and it does NOT require the transaction
 * to be negative, because a household may want a loan disbursement or an adjustment on the
 * record. It still refuses a transaction already linked to THIS loan; the unique index makes
 * that a no-op, reported as linked: false.
 */
export function assignTransactionToLoan(input: { txnId: number; itemId: number; at?: Date }): {
  linked: boolean;
  appliedCents: number;
} {
  const stamp = nowIso(input.at ?? new Date());
  return getDb().transaction((tx) => {
    const txn = tx
      .select({ amountCents: transactions.amountCents })
      .from(transactions)
      .where(eq(transactions.id, input.txnId))
      .get();
    if (!txn) throw new Error('That transaction no longer exists.');

    const item = tx
      .select({ balance: warrantyItems.currentBalanceCents })
      .from(warrantyItems)
      .where(eq(warrantyItems.id, input.itemId))
      .get();
    if (!item) throw new Error('That loan no longer exists.');

    const amount = Math.abs(txn.amountCents);
    if (amount === 0) throw new Error('A zero-amount transaction cannot be a loan payment.');
    const applied = link(tx, {
      txnId: input.txnId,
      itemId: input.itemId,
      amountCents: amount,
      balanceCents: item.balance ?? 0,
      source: 'manual',
      at: stamp,
    });
    return applied === null ? { linked: false, appliedCents: 0 } : { linked: true, appliedCents: applied };
  });
}

/**
 * MUST-13.12: deletes the link row and adds applied_cents back to current_balance_cents in
 * the SAME transaction. Neither operation touches balance_updated_at (MUST-11.8).
 */
export function unassignTransactionFromLoan(input: { txnId: number; itemId: number }): boolean {
  return getDb().transaction((tx) => {
    const row = tx
      .select({ appliedCents: loanPayments.appliedCents })
      .from(loanPayments)
      .where(and(eq(loanPayments.txnId, input.txnId), eq(loanPayments.itemId, input.itemId)))
      .get();
    if (!row) return false;
    tx.delete(loanPayments)
      .where(and(eq(loanPayments.txnId, input.txnId), eq(loanPayments.itemId, input.itemId)))
      .run();
    if (row.appliedCents > 0) {
      tx.update(warrantyItems)
        .set({ currentBalanceCents: sql`coalesce(${warrantyItems.currentBalanceCents}, 0) + ${row.appliedCents}` })
        .where(eq(warrantyItems.id, input.itemId))
        .run();
    }
    return true;
  });
}

/**
 * MUST-13.14: called INSIDE undoImport's existing transaction, BEFORE tx.delete(transactions).
 *
 * The ON DELETE CASCADE on loan_payments.txn_id would remove the rows anyway — but a cascade
 * cannot restore a balance, so the explicit reversal must run first. Returns rows reversed.
 */
export function reverseLoanLinksForTransactions(txnIds: number[]): number {
  if (txnIds.length === 0) return 0;
  const db = getDb();
  const rows = db
    .select({ itemId: loanPayments.itemId, appliedCents: loanPayments.appliedCents })
    .from(loanPayments)
    .where(inArray(loanPayments.txnId, txnIds))
    .all();
  if (rows.length === 0) return 0;

  const byItem = new Map<number, number>();
  for (const row of rows) byItem.set(row.itemId, (byItem.get(row.itemId) ?? 0) + row.appliedCents);
  for (const [itemId, applied] of byItem) {
    if (applied === 0) continue;
    db.update(warrantyItems)
      .set({ currentBalanceCents: sql`coalesce(${warrantyItems.currentBalanceCents}, 0) + ${applied}` })
      .where(eq(warrantyItems.id, itemId))
      .run();
  }
  db.delete(loanPayments).where(inArray(loanPayments.txnId, txnIds)).run();
  return rows.length;
}

// Note on reverseLoanLinksForTransactions and the enclosing transaction: it uses getDb()
// rather than a passed-in tx handle. better-sqlite3 transactions are synchronous and
// db.transaction() nests statements on the same connection, so calls made through getDb()
// inside an open transaction join it. That is the same pattern undoImport's untrain() hook
// already relies on; do not change it to take a tx parameter without also changing the Bayes
// hook, or the two will disagree about what "inside the transaction" means.

// ---------------------------------------------------------------- read model (summary)

/**
 * MUST-15.4: payoffFraction = clamp(1 - balance / principal, 0, 1), null unless both are set
 * and principal > 0. A zero principal would divide by zero; null is the honest answer.
 */
function payoff(principalCents: number | null, balanceCents: number | null): number | null {
  if (principalCents === null || balanceCents === null || principalCents <= 0) return null;
  return Math.min(1, Math.max(0, 1 - balanceCents / principalCents));
}

/**
 * MUST-15.4: the first date on or after today in addMonthsClamped(startDate, k) for 'monthly'
 * or addMonthsClamped(startDate, 12k) for 'annual'; null when billing_cycle is null, and
 * capped at expiry_date when that is set -- there is no next payment after the payoff date.
 * addMonthsClamped is the EXISTING helper, so month-end clamping (a loan that started on the
 * 31st) is already solved and no new date arithmetic is written here.
 */
function nextPayment(input: {
  startDate: string;
  cycle: BillingCycle | null;
  expiryDate: string | null;
  today: string;
}): string | null {
  if (input.cycle === null) return null;
  const step = input.cycle === 'monthly' ? 1 : 12;
  // A loan that started decades ago must not spin: 1200 steps is a century of months.
  for (let k = 1; k <= 1200; k += 1) {
    const date = addMonthsClamped(input.startDate, step * k);
    if (date < input.today) continue;
    if (input.expiryDate !== null && date > input.expiryDate) return null;
    return date;
  }
  return null;
}

export interface LoanSummary {
  itemId: number;
  name: string;
  ownerUserId: number;
  ownerName: string;
  principalCents: number | null;
  interestRateBps: number | null;
  currentBalanceCents: number | null;
  balanceUpdatedAt: string | null;
  billingCycle: BillingCycle | null;
  billingAmountCents: number | null;
  startDate: string;
  expiryDate: string | null;
  isLifetime: boolean;
  payoffFraction: number | null;
  nextPaymentDate: string | null;
  lastPaymentAt: string | null;
  paymentCount: number;
}

export function listLoans(today: string = todayIso()): LoanSummary[] {
  const rows = getDb()
    .select({
      itemId: warrantyItems.id,
      name: warrantyItems.name,
      ownerUserId: warrantyItems.ownerUserId,
      ownerName: users.name,
      principalCents: warrantyItems.principalCents,
      interestRateBps: warrantyItems.interestRateBps,
      currentBalanceCents: warrantyItems.currentBalanceCents,
      balanceUpdatedAt: warrantyItems.balanceUpdatedAt,
      billingCycle: warrantyItems.billingCycle,
      billingAmountCents: warrantyItems.billingAmountCents,
      startDate: warrantyItems.purchaseDate,
      expiryDate: warrantyItems.expiryDate,
      isLifetime: warrantyItems.isLifetime,
      // MUST-11.8: the DISPLAY "as of" value the UI shows is max(anchor, newest payment), and
      // the two are labelled differently ("You set this on ..." versus "Last payment ...").
      lastPaymentAt: sql<string | null>`(select max(created_at) from ${loanPayments} lp where lp.item_id = ${warrantyItems.id})`,
      paymentCount: sql<number>`(select count(*) from ${loanPayments} lp where lp.item_id = ${warrantyItems.id})`,
    })
    .from(warrantyItems)
    .innerJoin(warrantyItemTypes, eq(warrantyItemTypes.id, warrantyItems.typeId))
    .innerJoin(users, eq(users.id, warrantyItems.ownerUserId))
    .where(eq(warrantyItemTypes.kind, 'loan'))
    .orderBy(asc(warrantyItems.name), asc(warrantyItems.id))
    .all();

  return rows.map((row) => ({
    ...row,
    payoffFraction: payoff(row.principalCents, row.currentBalanceCents),
    nextPaymentDate: nextPayment({
      startDate: row.startDate,
      cycle: row.billingCycle,
      expiryDate: row.expiryDate,
      today,
    }),
  }));
}

export function loansTotalOwedCents(): number {
  return listLoans().reduce((sum, loan) => sum + (loan.currentBalanceCents ?? 0), 0);
}

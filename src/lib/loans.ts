import { and, asc, eq, gte, inArray, sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { loanMatcherRules, loanPayments, transactions, users, warrantyItemTypes, warrantyItems } from '@/db/schema';
import { nowIso } from '@/lib/clock';
import { addDaysIso, addMonths, addMonthsClamped, monthEnd, monthOf, monthRange, todayIso } from '@/lib/dates';
import type { RateVerdict } from '@/lib/notify/ratelimit';
import type { BillingCycle } from '@/lib/warranty/constants';

/**
 * Loan money-tracking (spec 2026-08-17 §13).
 *
 * MUST-13.1: interest_rate_bps is DISPLAY ONLY. Nothing in this file multiplies, accrues,
 * projects or amortises with it. Task 14 is expected to lock that in with its own grep-style
 * invariant test, the same way tests/lib/loans/invariants.test.ts (added by Task 10's round-3
 * fix) locks in transactions.amount_cents' immutability.
 *
 * MUST-13.2: loan payments STAY in their spending category and in every budget. Nothing here
 * writes is_transfer, category_id or attributed_user_id, and nothing here touches the
 * `transactions` table at all. A car payment is money that left the household this month;
 * hiding it from the budget would make the budget wrong.
 */
export const MAX_RULES_PER_LOAN = 5;
export const LOAN_BACKFILL_DAYS = 365;
export const LOAN_BACKFILL_MAX = 500;

/** F6 fix-round: the repo's chunking convention (src/lib/import/commit.ts, categorize/engine.ts)
 * applied to the id lists this file receives from callers, which are never capped in advance. */
const ID_CHUNK = 400;

function chunkIds(ids: number[]): number[][] {
  const out: number[][] = [];
  for (let offset = 0; offset < ids.length; offset += ID_CHUNK) out.push(ids.slice(offset, offset + ID_CHUNK));
  return out;
}

/**
 * MUST-14.12 / MUST-14.13: the third in-memory bucket in the codebase (notify's, update's,
 * this one). They stay separate because their windows, scopes and reset semantics differ and
 * a shared abstraction over three call sites would be one abstraction and three special
 * cases. If a fourth appears, extract then.
 *
 * This is the ONE loan action that carries a limit: ordinary loan CRUD and assign/unassign
 * carry none, consistent with every existing warranty and transaction action. The backfill
 * is the only expensive one. It scans up to a year of transactions.
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
  const db = getDb();
  for (const chunk of chunkIds(txnIds)) {
    const rows = db
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
      .where(inArray(loanPayments.txnId, chunk))
      .orderBy(asc(loanPayments.id))
      .all();
    for (const row of rows) {
      const list = out.get(row.txnId) ?? [];
      list.push(row);
      out.set(row.txnId, list);
    }
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
 * MUST-11.15: the link row IS the guard. INSERT ... ON CONFLICT DO NOTHING, and the balance
 * move runs in the SAME statement sequence, conditional on changes > 0, so a crash between
 * "decide to apply" and "record that we applied" is impossible.
 *
 * F1 fix-round (sign-aware apply): `signedAmountCents` carries the transaction's real sign.
 * A NEGATIVE transaction is a PAYMENT (money left the household) and DECREMENTS the
 * balance, clamped at zero exactly as before (MUST-11.14 / MUST-13.6). A POSITIVE
 * transaction is a DISBURSEMENT or an adjustment (money arrived) and INCREMENTS the
 * balance by its full magnitude; there is no ceiling to clamp against on that side.
 *
 * `applied_cents` always stores the UNSIGNED size of the move (never negative, so the
 * existing `applied_cents >= 0 AND applied_cents <= amount_cents` CHECK in drizzle/0007
 * needs no migration). The DIRECTION is therefore never read back off this row. It is
 * recovered at reversal time from the linked transaction's own (immutable) sign instead, by
 * `unassignTransactionFromLoan` and `reverseLoanLinksForTransactions` below. A payment
 * against a loan already at zero still produces a link row with applied_cents = 0: the
 * payment is recorded, the balance stays at zero, and nothing is silently swallowed.
 *
 * NEW-2 fix-round: `balanceCents` is `number | null` because `assignTransactionToLoan` can
 * target a loan whose balance is genuinely UNKNOWN (never anchored). An unknown balance
 * cannot be moved in either direction, so `applied` is forced to 0, recording the link (the
 * assignment itself is still real and still shown) without ever fabricating a move. Treating
 * null as 0 here was the exact bug: a disbursement against an unset balance would otherwise
 * record a phantom `applied_cents`, and a LATER unassign, after a person finally anchors the
 * balance, would subtract that phantom figure off a real number it had nothing to do with.
 */
function link(
  tx: ReturnType<typeof getDb>,
  input: { txnId: number; itemId: number; signedAmountCents: number; balanceCents: number | null; source: 'rule' | 'manual'; at: string },
): number | null {
  const magnitude = Math.abs(input.signedAmountCents);
  const isPayment = input.signedAmountCents < 0;
  // Payments clamp at zero; disbursements/adjustments apply in full (no ceiling exists for
  // how much can be added back onto an outstanding balance) -- except when the balance is
  // unknown, in which case neither direction applies anything (NEW-2).
  const applied = input.balanceCents === null ? 0 : isPayment ? Math.max(0, Math.min(magnitude, input.balanceCents)) : magnitude;
  const delta = isPayment ? -applied : applied;
  const result = tx
    .insert(loanPayments)
    .values({
      txnId: input.txnId,
      itemId: input.itemId,
      amountCents: magnitude,
      appliedCents: applied,
      source: input.source,
      createdAt: input.at,
    })
    .onConflictDoNothing()
    .run();
  if (result.changes === 0) return null;
  if (delta !== 0) {
    tx.update(warrantyItems)
      .set({ currentBalanceCents: sql`${warrantyItems.currentBalanceCents} + ${delta}` })
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
  const out: Candidate[] = [];
  for (const chunk of chunkIds(txnIds)) {
    out.push(
      ...tx
        .select({
          id: transactions.id,
          accountId: transactions.accountId,
          normalizedMerchant: transactions.normalizedMerchant,
          amountCents: transactions.amountCents,
          isTransfer: transactions.isTransfer,
        })
        .from(transactions)
        .where(inArray(transactions.id, chunk))
        .orderBy(asc(transactions.id))
        .all(),
    );
  }
  // NEW-6 fix-round: each chunk is sorted internally, but the CALLER's id list is chunked by
  // position, not by value, so ids above ID_CHUNK were no longer globally ascending once
  // concatenated. Restoring it here keeps "first rule by id wins" (MUST-13.4) and
  // "first match by date" style guarantees stable regardless of list size.
  out.sort((a, b) => a.id - b.id);
  return out;
}

function alreadyLinked(tx: ReturnType<typeof getDb>, txnIds: number[]): Set<number> {
  const out = new Set<number>();
  for (const chunk of chunkIds(txnIds)) {
    for (const row of tx.select({ txnId: loanPayments.txnId }).from(loanPayments).where(inArray(loanPayments.txnId, chunk)).all()) {
      out.add(row.txnId);
    }
  }
  return out;
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
 *
 * F5 fix-round: the optional `report` out-param is how a caller learns the catch below fired,
 * without widening this function's own return type (still a plain `number`, unchanged for
 * the many call sites and tests that only care about the count). Only import/flow.ts and
 * simplefin/sync.ts pass one, to surface `loanMatchFailed` alongside `engineFailed`. The
 * other three call sites (createManualTransaction, confirmCategory) have nowhere spec'd for
 * that signal to go and don't need it.
 */
export function applyLoanMatchers(txnIds: number[], at: Date = new Date(), report?: { failed: boolean }): number {
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
        // F1 ruling: rules auto-link PAYMENTS only. A positive transaction (a disbursement or
        // an adjustment) is manual-assign only (assignTransactionToLoan, below). A rule
        // silently deciding that an unrelated deposit is a loan disbursement would be a much
        // worse mistake than a household having to link one by hand.
        if (txn.amountCents >= 0) continue;
        if (linked.has(txn.id)) continue;

        const match = rules.find(
          (rule) =>
            txn.normalizedMerchant.includes(rule.merchantContains) &&
            (rule.accountId === null || rule.accountId === txn.accountId),
        );
        if (match === undefined) continue;

        const applied = link(tx, {
          txnId: txn.id,
          itemId: match.itemId,
          signedAmountCents: txn.amountCents,
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
    if (report) report.failed = true;
    return 0;
  }
}

/**
 * MUST-13.9 / MUST-13.10: the opt-in historical pass. Scans transactions with
 * date >= addDaysIso(today, -LOAN_BACKFILL_DAYS) (served by transactions_date_idx), applies
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
        // The query above already filters to amount_cents < 0 (payments only, same rule as
        // applyLoanMatchers), so row.amountCents is always negative here.
        const applied = link(tx, {
          txnId: row.id,
          itemId: rule.itemId,
          signedAmountCents: row.amountCents,
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
 * (MUST-11.16: a combined payment is legitimate), and it does NOT require the transaction
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

    if (txn.amountCents === 0) throw new Error('A zero-amount transaction cannot be a loan payment.');
    // F1 ruling: manual assign supports BOTH signs. A negative txn decrements the balance
    // (a payment), a positive one increments it (a disbursement or an adjustment).
    // NEW-2 fix-round: item.balance is passed through UNCOALESCED -- `?? 0` here used to
    // treat "unknown balance" as "zero balance", see link()'s docblock.
    const applied = link(tx, {
      txnId: input.txnId,
      itemId: input.itemId,
      signedAmountCents: txn.amountCents,
      balanceCents: item.balance,
      source: 'manual',
      at: stamp,
    });
    return applied === null ? { linked: false, appliedCents: 0 } : { linked: true, appliedCents: applied };
  });
}

/**
 * MUST-13.12: deletes the link row and restores current_balance_cents in the SAME
 * transaction. Neither operation touches balance_updated_at (MUST-11.8).
 *
 * F1 fix-round: undoes the SIGNED delta `link()` applied, recovered from the linked
 * transaction's own (immutable) sign, not from this row. A payment link (a decrement) is
 * restored by adding applied_cents back; a disbursement link (an increment) is restored by
 * subtracting it back.
 *
 * F2 fix-round: an UNKNOWN balance must stay unknown. The old `coalesce(..., 0)` fabricated
 * a balance out of NULL the moment any link was reversed; the `is not null` guard instead
 * makes the update match zero rows when the balance is already unknown, same as every other
 * read here treating NULL as "we don't track this loan's balance", not "it is zero".
 *
 * NEW-1 fix-round: the restore is clamped at zero (`max(0, ...)`), the same inexactness trade
 * the forward payment clamp already makes. Two links against one loan do not commute when the
 * balance has moved in between (a disbursement followed by a payment that clamped can leave
 * less room than the disbursement's own applied_cents), so undoing just one of them in
 * isolation can ask for a balance below zero, which used to hit the `current_balance_cents
 * >= 0` CHECK and throw a raw SqliteError instead of ever reaching a state a person could see.
 * Clamping trades perfect reconstruction for "never crash, never go negative", which is the
 * same trade every other clamp in this file already makes.
 */
export function unassignTransactionFromLoan(input: { txnId: number; itemId: number }): boolean {
  return getDb().transaction((tx) => {
    const row = tx
      .select({ appliedCents: loanPayments.appliedCents, txnAmountCents: transactions.amountCents })
      .from(loanPayments)
      .innerJoin(transactions, eq(transactions.id, loanPayments.txnId))
      .where(and(eq(loanPayments.txnId, input.txnId), eq(loanPayments.itemId, input.itemId)))
      .get();
    if (!row) return false;
    tx.delete(loanPayments)
      .where(and(eq(loanPayments.txnId, input.txnId), eq(loanPayments.itemId, input.itemId)))
      .run();
    if (row.appliedCents > 0) {
      const restore = row.txnAmountCents < 0 ? row.appliedCents : -row.appliedCents;
      tx.update(warrantyItems)
        .set({ currentBalanceCents: sql`max(0, ${warrantyItems.currentBalanceCents} + ${restore})` })
        .where(and(eq(warrantyItems.id, input.itemId), sql`${warrantyItems.currentBalanceCents} is not null`))
        .run();
    }
    return true;
  });
}

/**
 * MUST-13.14: called INSIDE undoImport's existing transaction, BEFORE tx.delete(transactions).
 *
 * The ON DELETE CASCADE on loan_payments.txn_id would remove the rows anyway, but a cascade
 * cannot restore a balance, so the explicit reversal must run first. Returns rows reversed.
 *
 * F1 fix-round: joins back to the (still-existing, not-yet-deleted) transaction to recover
 * each link's sign, same as unassignTransactionFromLoan, and sums SIGNED restores per item
 * before applying. A batch can legitimately reverse a payment and a disbursement on the
 * same loan in one undo.
 *
 * F2 fix-round: same "don't fabricate a balance out of NULL" guard as unassign.
 *
 * NEW-1 fix-round: same zero-clamp as unassign, and for the same reason it matters MORE
 * here: this runs inside undoImport's own transaction, and an uncaught CHECK-constraint
 * SqliteError would abort that ENTIRE transaction, rolling back the delete of every OTHER
 * sole transaction the undo was supposed to remove, not just this loan's. Clamping makes
 * that abort structurally impossible rather than merely unlikely.
 */
export function reverseLoanLinksForTransactions(txnIds: number[]): number {
  if (txnIds.length === 0) return 0;
  const db = getDb();
  const rows: { itemId: number; appliedCents: number; txnAmountCents: number }[] = [];
  for (const chunk of chunkIds(txnIds)) {
    rows.push(
      ...db
        .select({ itemId: loanPayments.itemId, appliedCents: loanPayments.appliedCents, txnAmountCents: transactions.amountCents })
        .from(loanPayments)
        .innerJoin(transactions, eq(transactions.id, loanPayments.txnId))
        .where(inArray(loanPayments.txnId, chunk))
        .all(),
    );
  }
  if (rows.length === 0) return 0;

  const byItem = new Map<number, number>();
  for (const row of rows) {
    const restore = row.txnAmountCents < 0 ? row.appliedCents : -row.appliedCents;
    byItem.set(row.itemId, (byItem.get(row.itemId) ?? 0) + restore);
  }
  for (const [itemId, restore] of byItem) {
    if (restore === 0) continue;
    db.update(warrantyItems)
      .set({ currentBalanceCents: sql`max(0, ${warrantyItems.currentBalanceCents} + ${restore})` })
      .where(and(eq(warrantyItems.id, itemId), sql`${warrantyItems.currentBalanceCents} is not null`))
      .run();
  }
  for (const chunk of chunkIds(txnIds)) {
    db.delete(loanPayments).where(inArray(loanPayments.txnId, chunk)).run();
  }
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

// ---------------------------------------------------------------- read model (debt over time)

export interface DebtPoint {
  month: string;
  owedCents: number | null;
}

/**
 * MUST-15.7: the reconstruction, exactly. One point per calendar month, oldest first. For a
 * month whose last day is E, each loan L contributes:
 *   - E < date(L.created_at)                      -> 0        (the loan did not exist)
 *   - L.current_balance_cents IS NULL, or
 *     L.balance_updated_at IS NULL                -> 0        (no balance is being tracked)
 *   - E < date(L.balance_updated_at)              -> UNKNOWN  (a person typed a balance after
 *       this month, which discarded whatever it was before; anything plotted here would be
 *       invented)
 *   - otherwise -> L.current_balance_cents + SUM(the signed undo of applied_cents) over rows
 *       with created_at > E
 *
 * The month's owedCents is the sum UNLESS any loan contributed unknown, in which case it is
 * null and the line breaks. A total that silently drops a loan for some months and includes
 * it for others is a chart that lies about a trend.
 *
 * MUST-15.9: the walk goes BACKWARDS from the present, never forwards from the principal. The
 * present balance is the one number a person has verified; the principal is a figure from a
 * contract that may never have matched the first statement.
 *
 * MUST-15.8: TWO queries, then a fold in memory over the month axis produced by the existing
 * monthRange/addMonths helpers -- the same pair cashflowTrend uses. No per-month query, no N+1.
 *
 * Task 10's fix round established that loan_payments.applied_cents is UNSIGNED -- a link's
 * direction is only recoverable from its transaction's amount sign, the same way
 * reverseLoanLinksForTransactions reads it back (see that function's doc comment above).
 * Undoing a payment (a negative transaction, which DECREMENTED the balance going forward) ADDS
 * applied_cents back; undoing a disbursement (a positive transaction, which INCREMENTED it)
 * SUBTRACTS applied_cents back. The join below folds that sign into the per-month sum, rather
 * than summing applied_cents unsigned, so a disbursement walked backwards is not mistaken for
 * a payment.
 *
 * Task 10 carry (a) -- KNOWN, DOCUMENTED drift after a clamped unassign: unassignTransactionFromLoan
 * and reverseLoanLinksForTransactions clamp their restore at zero (NEW-1 fix-round) rather than
 * ever driving current_balance_cents negative. That clamp is correct for the CURRENT balance --
 * it is the number a person can see and it must never go negative -- but the clamped link row is
 * then DELETED, so the amount the clamp swallowed leaves no trace for this function's backward
 * walk to re-add. Concretely: balance 10,000; a +60,000 disbursement in June takes it to 70,000;
 * a -70,000 payment in July takes it to exactly 0; unassigning the June disbursement afterwards
 * asks for 0 - 60,000 = -60,000, which clamps to 0 and deletes the June link row entirely. The
 * CURRENT month is still exact (0, matching current_balance_cents precisely, because this
 * function anchors every reconstruction on that column). Every month BEFORE the clamped event
 * is off by exactly the amount the clamp swallowed -- here, the reconstructed pre-June balance
 * comes back as 70,000, not the true 10,000, because the deleted June row can no longer be added
 * back on the walk backwards. This is a chart-history inexactness, not a balance-correctness bug
 * (MUST-13.12's own guarantee -- the CURRENT balance is always exactly restored -- still holds);
 * tests/lib/loans/debt-over-time.test.ts pins the exact numbers above as the documented behavior,
 * so a future change to either clamp cannot silently make the drift worse without that test
 * being touched on purpose.
 */
export function debtOverTime(months: number, opts: { endMonth?: string; today?: string } = {}): DebtPoint[] {
  const today = opts.today ?? todayIso();
  const endMonth = opts.endMonth ?? monthOf(today);
  const keys = monthRange(addMonths(endMonth, -(months - 1)), endMonth);

  const loans = getDb()
    .select({
      itemId: warrantyItems.id,
      createdAt: warrantyItems.createdAt,
      balanceCents: warrantyItems.currentBalanceCents,
      anchorAt: warrantyItems.balanceUpdatedAt,
    })
    .from(warrantyItems)
    .innerJoin(warrantyItemTypes, eq(warrantyItemTypes.id, warrantyItems.typeId))
    .where(eq(warrantyItemTypes.kind, 'loan'))
    .all();
  if (loans.length === 0) return keys.map((month) => ({ month, owedCents: null }));

  const applied = getDb()
    .select({
      itemId: loanPayments.itemId,
      month: sql<string>`substr(${loanPayments.createdAt}, 1, 7)`,
      // Signed undo delta: +applied_cents for a payment (undo a decrement), -applied_cents
      // for a disbursement (undo an increment) -- see the sign-recovery note above.
      total: sql<number>`sum(case when ${transactions.amountCents} < 0 then ${loanPayments.appliedCents} else -${loanPayments.appliedCents} end)`,
    })
    .from(loanPayments)
    .innerJoin(transactions, eq(transactions.id, loanPayments.txnId))
    .groupBy(loanPayments.itemId, sql`substr(${loanPayments.createdAt}, 1, 7)`)
    .all();

  const byItem = new Map<number, Map<string, number>>();
  for (const row of applied) {
    const inner = byItem.get(row.itemId) ?? new Map<string, number>();
    inner.set(row.month, (inner.get(row.month) ?? 0) + (row.total ?? 0));
    byItem.set(row.itemId, inner);
  }

  return keys.map((month) => {
    const end = monthEnd(month);
    let total = 0;
    for (const loan of loans) {
      if (end < loan.createdAt.slice(0, 10)) continue;
      if (loan.balanceCents === null || loan.anchorAt === null) continue;
      if (end < loan.anchorAt.slice(0, 10)) return { month, owedCents: null };
      let owed = loan.balanceCents;
      for (const [paymentMonth, cents] of byItem.get(loan.itemId) ?? []) {
        // "created_at > E" is the whole of every LATER month, since E is a month end.
        if (paymentMonth > month) owed += cents;
      }
      total += owed;
    }
    return { month, owedCents: total };
  });
}

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { commitImport, undoImport, type CommitResult } from '@/lib/import/commit';
import { computeRowHashes } from '@/lib/import/dedup';
import type { CandidateRow } from '@/lib/import/parse';
import { applyLoanMatchers, assignTransactionToLoan, loanLinksForTransactions, saveLoanRule, unassignTransactionFromLoan } from '@/lib/loans';
import { setupLoanTest, type LoanTestContext } from './fixtures';

let ctx: LoanTestContext;

beforeEach(() => {
  ctx = setupLoanTest();
});
afterEach(() => {
  ctx.t.cleanup();
});

describe('MUST-11.14 / MUST-13.12: unassign restores the exact balance', () => {
  it.each([
    ['ordinary', 2_000_000, 45_000, 1_955_000],
    ['clamped', 30_000, 45_000, 0],
    ['zero balance', 0, 45_000, 0],
  ])('%s', (_label, start, payment, afterLink) => {
    const { itemId } = ctx.seedLoan({ balanceCents: start });
    const txnId = ctx.spend('HONDA FIN SVC', -payment);
    assignTransactionToLoan({ txnId, itemId });
    expect(ctx.balanceOf(itemId)).toBe(afterLink);
    expect(unassignTransactionFromLoan({ txnId, itemId })).toBe(true);
    expect(ctx.balanceOf(itemId)).toBe(start);
  });
});

describe('MUST-13.14 / MUST-13.15: import undo', () => {
  /** Builds a one-row CSV-shaped commit input, hashed the same way import/commit.ts expects. */
  function candidateRow(over: { rawDescription: string; amountCents: number; date?: string }): CandidateRow {
    return {
      rowIndex: 0,
      rawDate: over.date ?? '2026-08-01',
      date: over.date ?? '2026-08-01',
      rawDescription: over.rawDescription,
      amountCents: over.amountCents,
      cells: [],
    };
  }

  function commitOne(filename: string, row: CandidateRow): CommitResult {
    const hashed = computeRowHashes(ctx.accountId, [row]);
    return commitImport({ accountId: ctx.accountId, profileId: null, filename, importedBy: ctx.userId, rows: hashed, errors: [] });
  }

  it('restores balances for sole transactions and leaves shared ones linked', () => {
    const { itemId } = ctx.seedLoan({ balanceCents: 2_000_000 });
    saveLoanRule({ itemId, merchantContains: 'HONDA FIN', accountId: null, enabled: true });
    const startBalance = 2_000_000;
    const sharedPayment = 45_000;

    // Import A: two matching rows, one of which import B will also pick up (dedup by hash).
    const sharedRow = candidateRow({ rawDescription: 'HONDA FIN SVC', amountCents: -sharedPayment, date: '2026-08-01' });
    const soleRow = candidateRow({ rawDescription: 'HONDA FIN SVC', amountCents: -30_000, date: '2026-08-02' });
    const hashedA = computeRowHashes(ctx.accountId, [sharedRow, soleRow]);
    const first = commitImport({ accountId: ctx.accountId, profileId: null, filename: 'a.csv', importedBy: ctx.userId, rows: hashedA, errors: [] });
    const [sharedTxnId, soleTxnId] = first.insertedTransactionIds;

    // Import B duplicate-hits the shared row only, making it associated with two imports.
    commitOne('b.csv', sharedRow);

    expect(applyLoanMatchers(first.insertedTransactionIds)).toBe(2);
    expect(ctx.balanceOf(itemId)).toBe(startBalance - sharedPayment - 30_000);

    const result = undoImport(first.importId);
    expect(result.loanLinksReversed).toBe(1);
    expect(ctx.balanceOf(itemId)).toBe(startBalance - sharedPayment);
    expect(loanLinksForTransactions([sharedTxnId]).get(sharedTxnId)).toHaveLength(1);
    expect(loanLinksForTransactions([soleTxnId]).get(soleTxnId)).toBeUndefined();
  });

  it('R8: import -> match -> undo -> re-import -> match leaves the balance exactly where it started', () => {
    const { itemId } = ctx.seedLoan({ balanceCents: 2_000_000 });
    saveLoanRule({ itemId, merchantContains: 'HONDA FIN', accountId: null, enabled: true });
    const row = candidateRow({ rawDescription: 'HONDA FIN SVC', amountCents: -45_000 });

    const start = ctx.balanceOf(itemId);
    const first = commitOne('r8.csv', row);
    applyLoanMatchers(first.insertedTransactionIds);
    const moved = ctx.balanceOf(itemId);
    expect(moved).toBeLessThan(start!);

    undoImport(first.importId);
    expect(ctx.balanceOf(itemId)).toBe(start);

    const second = commitOne('r8-again.csv', row);
    applyLoanMatchers(second.insertedTransactionIds);
    expect(ctx.balanceOf(itemId)).toBe(moved);
  });

  it('F8: undoing an import whose match CLAMPED restores the balance exactly, including the zero it clamped to', () => {
    const { itemId } = ctx.seedLoan({ balanceCents: 30_000 });
    saveLoanRule({ itemId, merchantContains: 'HONDA FIN', accountId: null, enabled: true });
    const row = candidateRow({ rawDescription: 'HONDA FIN SVC', amountCents: -45_000 });

    const start = ctx.balanceOf(itemId);
    const first = commitOne('clamped.csv', row);
    expect(applyLoanMatchers(first.insertedTransactionIds)).toBe(1);
    expect(ctx.balanceOf(itemId)).toBe(0);
    const link = loanLinksForTransactions(first.insertedTransactionIds).get(first.insertedTransactionIds[0])![0]!;
    expect(link.amountCents).toBe(45_000);
    expect(link.appliedCents).toBe(30_000);

    const result = undoImport(first.importId);
    expect(result.loanLinksReversed).toBe(1);
    expect(ctx.balanceOf(itemId)).toBe(start);
  });
});

describe('MUST-13.11 / MUST-11.16: manual assign', () => {
  it('allows a second loan on the same transaction and refuses a second link to the same loan', () => {
    const car = ctx.seedLoan({ name: 'Car', balanceCents: 2_000_000 });
    const boat = ctx.seedLoan({ name: 'Boat', balanceCents: 500_000 });
    const txnId = ctx.spend('COMBINED PAYMENT', -60_000);
    expect(assignTransactionToLoan({ txnId, itemId: car.itemId })).toEqual({ linked: true, appliedCents: 60_000 });
    expect(assignTransactionToLoan({ txnId, itemId: car.itemId })).toEqual({ linked: false, appliedCents: 0 });
    // F7: pin the conflict-skip branch itself, not just its return value — the second
    // (refused) attempt must not have decremented the balance a second time.
    expect(ctx.balanceOf(car.itemId)).toBe(1_940_000);
    expect(assignTransactionToLoan({ txnId, itemId: boat.itemId })).toEqual({ linked: true, appliedCents: 60_000 });
  });

  it('does not require a negative amount — a disbursement or an adjustment may be recorded', () => {
    const { itemId } = ctx.seedLoan({ balanceCents: 2_000_000 });
    const txnId = ctx.spend('LOAN DISBURSEMENT', 60_000);
    expect(assignTransactionToLoan({ txnId, itemId }).linked).toBe(true);
  });
});

describe('F1: sign-aware apply — a disbursement/adjustment INCREMENTS the balance', () => {
  it('a positive transaction increments the balance by its full magnitude, with no clamp', () => {
    const { itemId } = ctx.seedLoan({ balanceCents: 20_000_00 });
    const txnId = ctx.spend('LOAN DISBURSEMENT', 600_00);
    expect(assignTransactionToLoan({ txnId, itemId })).toEqual({ linked: true, appliedCents: 600_00 });
    expect(ctx.balanceOf(itemId)).toBe(20_600_00);
  });

  it('unassigning a disbursement link restores the balance by subtracting it back', () => {
    const { itemId } = ctx.seedLoan({ balanceCents: 20_000_00 });
    const txnId = ctx.spend('LOAN DISBURSEMENT', 600_00);
    assignTransactionToLoan({ txnId, itemId });
    expect(ctx.balanceOf(itemId)).toBe(20_600_00);
    expect(unassignTransactionFromLoan({ txnId, itemId })).toBe(true);
    expect(ctx.balanceOf(itemId)).toBe(20_000_00);
  });

  it('a clamped payment is unchanged by the sign-aware refactor', () => {
    const { itemId } = ctx.seedLoan({ balanceCents: 30_000 });
    const txnId = ctx.spend('HONDA FIN SVC', -45_000);
    expect(assignTransactionToLoan({ txnId, itemId })).toEqual({ linked: true, appliedCents: 30_000 });
    expect(ctx.balanceOf(itemId)).toBe(0);
    expect(unassignTransactionFromLoan({ txnId, itemId })).toBe(true);
    expect(ctx.balanceOf(itemId)).toBe(30_000);
  });
});

describe('F2: reverse paths never fabricate a balance out of NULL', () => {
  it('unassign leaves an unknown balance unknown', () => {
    const { itemId } = ctx.seedLoan({ balanceCents: 2_000_000 });
    const txnId = ctx.spend('HONDA FIN SVC', -45_000);
    assignTransactionToLoan({ txnId, itemId });
    expect(ctx.balanceOf(itemId)).toBe(1_955_000);

    // Simulate the balance being cleared back to "unknown" directly (e.g. a later edit that
    // clears principal/balance), independent of the loans.ts write paths.
    ctx.t.sqlite.prepare('update warranty_items set current_balance_cents = null, balance_updated_at = null where id = ?').run(itemId);
    expect(ctx.balanceOf(itemId)).toBeNull();

    expect(unassignTransactionFromLoan({ txnId, itemId })).toBe(true);
    expect(ctx.balanceOf(itemId)).toBeNull();
  });

  it('import-undo leaves an unknown balance unknown', () => {
    const { itemId } = ctx.seedLoan({ balanceCents: 2_000_000 });
    saveLoanRule({ itemId, merchantContains: 'HONDA FIN', accountId: null, enabled: true });
    const row: CandidateRow = {
      rowIndex: 0,
      rawDate: '2026-08-01',
      date: '2026-08-01',
      rawDescription: 'HONDA FIN SVC',
      amountCents: -45_000,
      cells: [],
    };
    const hashed = computeRowHashes(ctx.accountId, [row]);
    const first = commitImport({ accountId: ctx.accountId, profileId: null, filename: 'f2.csv', importedBy: ctx.userId, rows: hashed, errors: [] });
    applyLoanMatchers(first.insertedTransactionIds);
    expect(ctx.balanceOf(itemId)).toBe(1_955_000);

    ctx.t.sqlite.prepare('update warranty_items set current_balance_cents = null, balance_updated_at = null where id = ?').run(itemId);
    expect(ctx.balanceOf(itemId)).toBeNull();

    const result = undoImport(first.importId);
    expect(result.loanLinksReversed).toBe(1);
    expect(ctx.balanceOf(itemId)).toBeNull();
  });
});

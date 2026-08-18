import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createSeededTestDb, insertTestAccount, insertTestUser, type TestDb } from '../../helpers/db';
import { assignTransactionToLoan, debtOverTime, unassignTransactionFromLoan } from '@/lib/loans';

let t: TestDb;
let userId = 0;
let accountId = 0;
let typeId = 0;

beforeEach(() => {
  t = createSeededTestDb();
  userId = insertTestUser(t.db, { username: 'loans' });
  accountId = insertTestAccount(t.db, { name: 'Chequing' });
  const type = t.sqlite
    .prepare(`insert into warranty_item_types (name, is_subscription, kind, created_at) values ('Car loan', 0, 'loan', ?) returning id`)
    .get('2020-01-01T00:00:00.000Z') as { id: number };
  typeId = type.id;
});
afterEach(() => {
  t.cleanup();
  vi.restoreAllMocks();
});

/** A loan-kind warranty_items row, with full control over created_at (item existence) and
 *  balance_updated_at (the human anchor) -- the two dates debtOverTime's clauses key off. */
function seedItem(over: {
  name?: string;
  createdAt?: string;
  balanceCents?: number | null;
  balanceUpdatedAt?: string | null;
}): number {
  const createdAt = over.createdAt ?? '2020-01-01T00:00:00.000Z';
  const row = t.sqlite
    .prepare(
      `insert into warranty_items
         (name, purchase_date, is_lifetime, owner_user_id, type_id, current_balance_cents, balance_updated_at, created_at, updated_at)
       values (?, '2020-01-01', 0, ?, ?, ?, ?, ?, ?) returning id`,
    )
    .get(
      over.name ?? 'Loan',
      userId,
      typeId,
      over.balanceCents === undefined ? null : over.balanceCents,
      over.balanceUpdatedAt ?? null,
      createdAt,
      createdAt,
    ) as { id: number };
  return row.id;
}

/** Inserts a transaction and its linked loan_payments row, dated `createdAt` -- the column
 *  debtOverTime groups by. A negative `signedAmountCents` is a payment (a decrement, undone by
 *  adding applied_cents back); a positive one is a disbursement (an increment, undone by
 *  subtracting it), mirroring reverseLoanLinksForTransactions's own sign recovery. */
function link(itemId: number, opts: { signedAmountCents: number; appliedCents: number; createdAt: string }): void {
  const txn = t.sqlite
    .prepare(
      `insert into transactions
         (account_id, date, raw_description, normalized_merchant, amount_cents, is_transfer, created_by, created_at, updated_at)
       values (?, ?, 'Payment', 'PAYMENT', ?, 0, ?, ?, ?) returning id`,
    )
    .get(accountId, opts.createdAt.slice(0, 10), opts.signedAmountCents, userId, opts.createdAt, opts.createdAt) as { id: number };
  t.sqlite
    .prepare(`insert into loan_payments (txn_id, item_id, amount_cents, applied_cents, source, created_at) values (?, ?, ?, ?, 'manual', ?)`)
    .run(txn.id, itemId, Math.abs(opts.signedAmountCents), opts.appliedCents, opts.createdAt);
}

/** A direct balance edit -- both fields move together, the same pairing MUST-11.7/11.8 hold
 *  in the write path this test file does not otherwise exercise. */
function updateBalance(itemId: number, balanceCents: number, at: string): void {
  t.sqlite.prepare(`update warranty_items set current_balance_cents = ?, balance_updated_at = ? where id = ?`).run(balanceCents, at, itemId);
}

/** A bare transaction row, with no loan_payments row of its own -- for tests that link it
 *  through the real write path (assignTransactionToLoan) rather than seeding the link row
 *  directly, so the write path's own dating and clamping behavior is what's under test. */
function insertTxn(opts: { signedAmountCents: number; date: string }): number {
  const row = t.sqlite
    .prepare(
      `insert into transactions
         (account_id, date, raw_description, normalized_merchant, amount_cents, is_transfer, created_by, created_at, updated_at)
       values (?, ?, 'Payment', 'PAYMENT', ?, 0, ?, ?, ?) returning id`,
    )
    .get(accountId, opts.date, opts.signedAmountCents, userId, `${opts.date}T00:00:00.000Z`, `${opts.date}T00:00:00.000Z`) as { id: number };
  return row.id;
}

function balanceOf(itemId: number): number | null {
  return (t.sqlite.prepare('select current_balance_cents as b from warranty_items where id = ?').get(itemId) as { b: number | null }).b;
}

/** better-sqlite3 exposes no counter, so count prepares through the driver's own hook. */
let prepared = 0;
beforeEach(() => {
  prepared = 0;
  const original = t.sqlite.prepare.bind(t.sqlite);
  vi.spyOn(t.sqlite, 'prepare').mockImplementation(((sqlText: string) => {
    prepared += 1;
    return original(sqlText);
  }) as typeof t.sqlite.prepare);
});
function queryCount(): number {
  return prepared;
}

describe('MUST-15.7: the reconstruction, clause by clause', () => {
  it('a month before the item existed contributes 0', () => {
    seedItem({ name: 'New loan', createdAt: '2026-04-01T00:00:00.000Z', balanceCents: 100_000, balanceUpdatedAt: '2026-04-01T00:00:00.000Z' });
    const series = debtOverTime(6, { endMonth: '2026-08', today: '2026-08-18' });
    expect(series.find((p) => p.month === '2026-03')!.owedCents).toBe(0);
  });

  it('a month before balance_updated_at makes the whole point null', () => {
    // anchor set 2026-06-10; the balance before that was discarded.
    seedItem({ name: 'Loan', createdAt: '2024-01-01T00:00:00.000Z', balanceCents: 1_000_000, balanceUpdatedAt: '2026-06-10T00:00:00.000Z' });
    const series = debtOverTime(6, { endMonth: '2026-08', today: '2026-08-18' });
    expect(series.find((p) => p.month === '2026-05')!.owedCents).toBeNull();
    expect(series.find((p) => p.month === '2026-06')!.owedCents).not.toBeNull();
  });

  it('a month after the anchor equals the balance plus the payments made since', () => {
    const itemId = seedItem({ name: 'Loan', createdAt: '2024-01-01T00:00:00.000Z', balanceCents: 1_955_000, balanceUpdatedAt: '2026-06-10T00:00:00.000Z' });
    link(itemId, { signedAmountCents: -45_000, appliedCents: 45_000, createdAt: '2026-07-15T00:00:00.000Z' });
    link(itemId, { signedAmountCents: -45_000, appliedCents: 45_000, createdAt: '2026-08-15T00:00:00.000Z' });
    const series = debtOverTime(6, { endMonth: '2026-08', today: '2026-08-18' });
    expect(series.find((p) => p.month === '2026-06')!.owedCents).toBe(1_955_000 + 45_000 + 45_000);
    expect(series.find((p) => p.month === '2026-08')!.owedCents).toBe(1_955_000);
  });

  it('two loans where one is unknown makes the whole point null, not a partial total', () => {
    const itemId = seedItem({ name: 'Loan', createdAt: '2024-01-01T00:00:00.000Z', balanceCents: 1_955_000, balanceUpdatedAt: '2026-06-10T00:00:00.000Z' });
    link(itemId, { signedAmountCents: -45_000, appliedCents: 45_000, createdAt: '2026-07-15T00:00:00.000Z' });
    link(itemId, { signedAmountCents: -45_000, appliedCents: 45_000, createdAt: '2026-08-15T00:00:00.000Z' });
    // Second loan anchored in 2026-07.
    seedItem({ name: 'Second loan', createdAt: '2024-01-01T00:00:00.000Z', balanceCents: 455_000, balanceUpdatedAt: '2026-07-10T00:00:00.000Z' });
    const series = debtOverTime(6, { endMonth: '2026-08', today: '2026-08-18' });
    expect(series.find((p) => p.month === '2026-06')!.owedCents).toBeNull();
    expect(series.find((p) => p.month === '2026-07')!.owedCents).toBe(2_455_000);
  });

  it('a loan with no balance being tracked contributes 0 rather than unknown', () => {
    seedItem({ name: 'Untracked', createdAt: '2020-01-01T00:00:00.000Z', balanceCents: null, balanceUpdatedAt: null });
    const series = debtOverTime(3, { endMonth: '2026-08', today: '2026-08-18' });
    expect(series.every((p) => p.owedCents !== null)).toBe(true);
  });

  it('a direct balance edit today truncates the series — the older months become null', () => {
    const itemId = seedItem({ name: 'Loan', createdAt: '2024-01-01T00:00:00.000Z', balanceCents: 1_955_000, balanceUpdatedAt: '2026-06-10T00:00:00.000Z' });
    updateBalance(itemId, 1_000_000, '2026-08-18T00:00:00.000Z');
    const series = debtOverTime(6, { endMonth: '2026-08', today: '2026-08-18' });
    expect(series.slice(0, 5).every((p) => p.owedCents === null)).toBe(true);
    expect(series.at(-1)!.owedCents).toBe(1_000_000);
  });

  it('a disbursement after the anchor is undone by SUBTRACTING it back, not added like a payment', () => {
    // Task 10's fix-round sign trap: applied_cents is unsigned, so a positive (disbursement)
    // link must not be summed as if it were a payment when walking backwards.
    const itemId = seedItem({ name: 'Loan', createdAt: '2024-01-01T00:00:00.000Z', balanceCents: 1_000_000, balanceUpdatedAt: '2026-06-10T00:00:00.000Z' });
    link(itemId, { signedAmountCents: 200_000, appliedCents: 200_000, createdAt: '2026-08-01T00:00:00.000Z' });
    const series = debtOverTime(3, { endMonth: '2026-08', today: '2026-08-18' });
    expect(series.find((p) => p.month === '2026-07')!.owedCents).toBe(800_000);
    expect(series.find((p) => p.month === '2026-08')!.owedCents).toBe(1_000_000);
  });

  it('MUST-15.8: the whole series is computed from exactly TWO queries', () => {
    seedItem({ name: 'Loan', createdAt: '2024-01-01T00:00:00.000Z', balanceCents: 1_955_000, balanceUpdatedAt: '2026-06-10T00:00:00.000Z' });
    const before = queryCount();
    debtOverTime(24, { endMonth: '2026-08', today: '2026-08-18' });
    expect(queryCount() - before).toBe(2);
  });

  it('with no loans at all, every point is null', () => {
    const series = debtOverTime(3, { endMonth: '2026-08', today: '2026-08-18' });
    expect(series.every((p) => p.owedCents === null)).toBe(true);
    expect(series.map((p) => p.month)).toEqual(['2026-06', '2026-07', '2026-08']);
  });
});

describe('Task 10 carry (a): the documented drift after a clamped unassign', () => {
  it('the exact probe: 10,000 +60,000 disb June -> 70,000; -70,000 payment July -> 0; unassign disb clamps -- pre-June reconstructs 70,000, not the true 10,000, while the CURRENT month stays exact', () => {
    const itemId = seedItem({ name: 'Drift loan', createdAt: '2024-01-01T00:00:00.000Z', balanceCents: 10_000, balanceUpdatedAt: '2024-01-01T00:00:00.000Z' });

    const disbTxn = insertTxn({ signedAmountCents: 60_000, date: '2026-06-15' });
    expect(assignTransactionToLoan({ txnId: disbTxn, itemId, at: new Date('2026-06-15T00:00:00.000Z') })).toEqual({
      linked: true,
      appliedCents: 60_000,
    });
    expect(balanceOf(itemId)).toBe(70_000);

    const paymentTxn = insertTxn({ signedAmountCents: -70_000, date: '2026-07-15' });
    expect(assignTransactionToLoan({ txnId: paymentTxn, itemId, at: new Date('2026-07-15T00:00:00.000Z') })).toEqual({
      linked: true,
      appliedCents: 70_000,
    });
    expect(balanceOf(itemId)).toBe(0);

    // The clamp: naively this restore asks for 0 - 60,000 = -60,000. It clamps at zero instead
    // of crashing (NEW-1 fix-round) -- and the June link row is deleted along with it, so its
    // effect leaves no trace for debtOverTime's backward walk to re-add.
    expect(unassignTransactionFromLoan({ txnId: disbTxn, itemId })).toBe(true);
    expect(balanceOf(itemId)).toBe(0);

    const series = debtOverTime(6, { endMonth: '2026-08', today: '2026-08-18' });
    // Documented drift, not a bug to fix here: the deleted June row can no longer be added back
    // on the walk backwards, so every month before the clamped event reconstructs as if the
    // disbursement had never happened at all -- 70,000 (the July payment's own undo, with
    // nothing left to cancel it), not the true pre-disbursement balance of 10,000.
    expect(series.find((p) => p.month === '2026-04')!.owedCents).toBe(70_000);
    expect(series.find((p) => p.month === '2026-05')!.owedCents).toBe(70_000);
    // The CURRENT month is exact: it anchors on current_balance_cents directly, which the
    // clamp kept honestly at zero rather than fabricating a negative number.
    expect(series.find((p) => p.month === '2026-08')!.owedCents).toBe(0);
  });
});

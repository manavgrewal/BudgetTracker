import { describe, it, expect, vi, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { createSeededTestDb, insertTestAccount, insertTestUser, type TestDb } from '../helpers/db';
import { normalizeMerchant } from '@/lib/categorize/normalize';
import { nowIso } from '@/lib/clock';
import { createWarrantyItem, getWarrantyItem } from '@/lib/warranty/items';
import { createItemType } from '@/lib/warranty/types';

let currentUser = { id: 1, name: 'Alice', username: 'alice', role: 'admin' as const };
// v1.3.1: toggleable so the loan actions' cross-origin-first test can flip it, same idiom as
// tests/app/update-actions.test.ts.
const sameOrigin = vi.hoisted(() => ({ value: true }));

vi.mock('@/lib/auth/session', () => ({
  requireUser: vi.fn(async () => currentUser),
}));

vi.mock('next/headers', () => ({
  headers: async () =>
    sameOrigin.value
      ? new Headers({ origin: 'http://nas.local:3000', host: 'nas.local:3000' })
      : new Headers({ origin: 'http://evil.example', host: 'nas.local:3000' }),
}));

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}));

import { CROSS_ORIGIN_ERROR } from '@/lib/auth/csrf';
import {
  assignToLoanAction,
  saveNoteAction,
  setAttributionAction,
  unassignFromLoanAction,
} from '@/app/(app)/transactions/actions';

let current: TestDb | null = null;
// v1.3.1: set by setup(), read by the loan fixture helpers below so they don't need every
// call site to thread userId/accountId through by hand.
let ctx: { userId: number; accountId: number } | null = null;

afterEach(() => {
  sameOrigin.value = true;
  current?.cleanup();
  current = null;
  ctx = null;
});

function formData(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

function setup() {
  current = createSeededTestDb();
  const userId = insertTestUser(current.db, { name: 'Alice', username: 'alice' });
  currentUser = { id: userId, name: 'Alice', username: 'alice', role: 'admin' };
  const accountId = insertTestAccount(current.db, { name: 'Joint Chequing' });
  ctx = { userId, accountId };
  const addTxn = (description = 'TIM HORTONS', amountCents = -500) => {
    const row = current!.db.get<{ id: number }>(sql`
      insert into transactions (account_id, date, raw_description, normalized_merchant, amount_cents, created_by, created_at, updated_at)
      values (${accountId}, '2026-03-02', ${description}, ${normalizeMerchant(description)}, ${amountCents}, ${userId}, ${nowIso()}, ${nowIso()})
      returning id`);
    return row.id;
  };
  return { db: current.db, sqlite: current.sqlite, userId, accountId, addTxn };
}

/** A loan-kind item, seeded directly through the data layer. */
function seedLoanItem(opts: { balanceCents?: number } = {}): number {
  const { userId } = ctx!;
  const loanType = createItemType(`Loan ${randomUUID()}`, 'loan');
  return createWarrantyItem({
    name: 'Car Loan',
    vendor: null,
    model: null,
    serial: null,
    purchaseDate: '2026-01-01',
    warrantyMonths: null,
    isLifetime: false,
    priceCents: null,
    ownerUserId: userId,
    transactionId: null,
    typeId: loanType.id,
    notes: null,
    principalCents: 3_000_000,
    interestRateBps: 549,
    currentBalanceCents: opts.balanceCents ?? 2_000_000,
    balanceUpdatedAt: nowIso(),
  });
}

/** A loan with the given balance, plus one negative (spend) transaction on the same account. */
function seedLoanAndSpend(balanceCents: number, amountCents: number): { itemId: number; txnId: number } {
  const { accountId, userId } = ctx!;
  const itemId = seedLoanItem({ balanceCents });
  const row = current!.db.get<{ id: number }>(sql`
    insert into transactions (account_id, date, raw_description, normalized_merchant, amount_cents, created_by, created_at, updated_at)
    values (${accountId}, '2026-03-02', 'HONDA FIN PAYMENT', ${normalizeMerchant('HONDA FIN PAYMENT')}, ${amountCents}, ${userId}, ${nowIso()}, ${nowIso()})
    returning id`);
  return { itemId, txnId: row.id };
}

function balanceOf(itemId: number): number | null {
  return getWarrantyItem(itemId)!.currentBalanceCents;
}

describe('setAttributionAction — missing input validation (finding 2)', () => {
  it('rejects a non-numeric attributedUserId instead of writing NaN', async () => {
    const { sqlite, addTxn } = setup();
    const id = addTxn();
    const result = await setAttributionAction({}, formData({ ids: String(id), attributedUserId: 'not-a-number' }));
    expect(result.error).toBeTruthy();
    const row = sqlite.prepare('select attributed_user_id as a from transactions where id = ?').get(id) as { a: number | null };
    expect(row.a).not.toBeNaN();
    // Untouched by the rejected write — still whatever it started as (null here).
    expect(row.a).toBeNull();
  });

  it('still accepts a real user id and an empty selection meaning household/unattributed', async () => {
    const { userId, sqlite, addTxn } = setup();
    const id = addTxn();
    const attributed = await setAttributionAction({}, formData({ ids: String(id), attributedUserId: String(userId) }));
    expect(attributed.message).toBeTruthy();
    expect((sqlite.prepare('select attributed_user_id as a from transactions where id = ?').get(id) as { a: number | null }).a).toBe(userId);

    const cleared = await setAttributionAction({}, formData({ ids: String(id), attributedUserId: '' }));
    expect(cleared.message).toBeTruthy();
    expect((sqlite.prepare('select attributed_user_id as a from transactions where id = ?').get(id) as { a: number | null }).a).toBeNull();
  });
});

describe('saveNoteAction — missing input validation (finding 2)', () => {
  it('returns an error for a non-numeric transactionId instead of a silent no-op success', async () => {
    setup();
    const result = await saveNoteAction({}, formData({ transactionId: 'nope', notes: 'hi' }));
    expect(result.error).toBeTruthy();
  });

  it('returns an error when the transaction does not exist instead of claiming success', async () => {
    setup();
    const result = await saveNoteAction({}, formData({ transactionId: '999999', notes: 'hi' }));
    expect(result.error).toBeTruthy();
  });

  it('saves the note for a real transaction', async () => {
    const { sqlite, addTxn } = setup();
    const id = addTxn();
    const result = await saveNoteAction({}, formData({ transactionId: String(id), notes: 'split with Bob' }));
    expect(result.message).toBeTruthy();
    const row = sqlite.prepare('select notes from transactions where id = ?').get(id) as { notes: string | null };
    expect(row.notes).toBe('split with Bob');
  });
});

describe('MUST-14.8 … MUST-14.11: assign and unassign', () => {
  it('links and decrements; a second assign to the same loan is a reported no-op', async () => {
    setup();
    const { itemId, txnId } = seedLoanAndSpend(2_000_000, -45_000);
    expect((await assignToLoanAction(formData({ transactionId: String(txnId), itemId: String(itemId) }))).message).toBe('Assigned.');
    expect(balanceOf(itemId)).toBe(1_955_000);
    expect((await assignToLoanAction(formData({ transactionId: String(txnId), itemId: String(itemId) }))).message).toBe(
      'That transaction is already linked to this loan.',
    );
    expect(balanceOf(itemId)).toBe(1_955_000);
  });

  it('MUST-14.10: a second LOAN on the same transaction succeeds and warns', async () => {
    setup();
    const { itemId: car, txnId } = seedLoanAndSpend(2_000_000, -45_000);
    const boat = seedLoanItem({ balanceCents: 500_000 });
    await assignToLoanAction(formData({ transactionId: String(txnId), itemId: String(car) }));
    const result = await assignToLoanAction(formData({ transactionId: String(txnId), itemId: String(boat) }));
    expect(result.message).toBe('Assigned. Note that this transaction is now linked to more than its own amount.');
    expect(result.error).toBeUndefined();
  });

  it('unassign restores exactly, and a nonexistent id is an error, not a 500', async () => {
    setup();
    const { itemId, txnId } = seedLoanAndSpend(2_000_000, -45_000);
    await assignToLoanAction(formData({ transactionId: String(txnId), itemId: String(itemId) }));
    await unassignFromLoanAction(formData({ transactionId: String(txnId), itemId: String(itemId) }));
    expect(balanceOf(itemId)).toBe(2_000_000);
    expect((await assignToLoanAction(formData({ transactionId: '999999', itemId: String(itemId) }))).error).toBe(
      'That transaction no longer exists.',
    );
  });

  it('both reject a cross-origin request first', async () => {
    setup();
    sameOrigin.value = false;
    expect((await assignToLoanAction(formData({ transactionId: '1', itemId: '1' }))).error).toBe(CROSS_ORIGIN_ERROR);
    expect((await unassignFromLoanAction(formData({ transactionId: '1', itemId: '1' }))).error).toBe(CROSS_ORIGIN_ERROR);
  });
});

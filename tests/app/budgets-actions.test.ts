import { describe, it, expect, vi, afterEach } from 'vitest';
import { createSeededTestDb, categoryIdByName, insertTestUser, type TestDb } from '../helpers/db';
import { resolveBudget, upsertBudget } from '@/lib/budgets';

let currentUser: { id: number; name: string; username: string; role: 'admin' | 'member' } = {
  id: 1,
  name: 'Alice',
  username: 'alice',
  role: 'member',
};
let mockHeaders = new Headers({ origin: 'http://nas.local:3000', host: 'nas.local:3000' });

vi.mock('@/lib/auth/session', () => ({
  requireUser: vi.fn(async () => currentUser),
}));

vi.mock('next/headers', () => ({
  headers: async () => mockHeaders,
}));

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}));

import { copyPreviousMonthAction, setLimitAction } from '@/app/(app)/budgets/actions';

const SAME_ORIGIN = new Headers({ origin: 'http://nas.local:3000', host: 'nas.local:3000' });
const CROSS_ORIGIN = new Headers({ origin: 'http://evil.local', host: 'nas.local:3000' });

let current: TestDb | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
  mockHeaders = SAME_ORIGIN;
});

function formData(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

function setup() {
  current = createSeededTestDb();
  const alice = insertTestUser(current.db, { name: 'Alice', username: 'alice', role: 'member' });
  const bob = insertTestUser(current.db, { name: 'Bob', username: 'bob', role: 'member' });
  const admin = insertTestUser(current.db, { name: 'Admin', username: 'admin', role: 'admin' });
  const groceries = categoryIdByName(current.db, 'Groceries');
  currentUser = { id: alice, name: 'Alice', username: 'alice', role: 'member' };
  mockHeaders = SAME_ORIGIN;
  return { db: current.db, sqlite: current.sqlite, alice, bob, admin, groceries };
}

describe('setLimitAction — review finding 6', () => {
  it('rejects a cross-origin submission before touching the database', async () => {
    const { groceries } = setup();
    mockHeaders = CROSS_ORIGIN;
    const result = await setLimitAction(
      {},
      formData({ scope: 'household', month: '2026-03', categoryId: String(groceries), userId: '', amount: '50.00' }),
    );
    expect(result.error).toMatch(/cross-origin/i);
    expect(resolveBudget('household', null, groceries, '2026-03')).toBeNull();
  });

  it("rejects a member editing another member's personal budget", async () => {
    const { bob, groceries } = setup();
    const result = await setLimitAction(
      {},
      formData({ scope: 'personal', month: '2026-03', categoryId: String(groceries), userId: String(bob), amount: '50.00' }),
    );
    expect(result.error).toMatch(/your own/i);
    expect(resolveBudget('personal', bob, groceries, '2026-03')).toBeNull();
  });

  it("lets an admin override and edit another member's personal budget", async () => {
    const { admin, bob, groceries } = setup();
    currentUser = { id: admin, name: 'Admin', username: 'admin', role: 'admin' };
    const result = await setLimitAction(
      {},
      formData({ scope: 'personal', month: '2026-03', categoryId: String(groceries), userId: String(bob), amount: '50.00' }),
    );
    expect(result.message).toBeTruthy();
    expect(resolveBudget('personal', bob, groceries, '2026-03')).toBe(5000);
  });

  it('happy path: a member sets their own personal budget and a household budget', async () => {
    const { alice, groceries } = setup();
    const own = await setLimitAction(
      {},
      formData({ scope: 'personal', month: '2026-03', categoryId: String(groceries), userId: '', amount: '25.00' }),
    );
    expect(own.message).toBeTruthy();
    expect(resolveBudget('personal', alice, groceries, '2026-03')).toBe(2500);

    const household = await setLimitAction(
      {},
      formData({ scope: 'household', month: '2026-03', categoryId: String(groceries), userId: '', amount: '100.00' }),
    );
    expect(household.message).toBeTruthy();
    expect(resolveBudget('household', null, groceries, '2026-03')).toBe(10000);
  });

  it('a blank amount clears the budget from the viewed month forward', async () => {
    const { groceries } = setup();
    upsertBudget({ scope: 'household', userId: null, categoryId: groceries, month: '2026-01', amountCents: 8000 });
    const result = await setLimitAction(
      {},
      formData({ scope: 'household', month: '2026-03', categoryId: String(groceries), userId: '', amount: '' }),
    );
    expect(result.message).toMatch(/cleared/i);
    expect(resolveBudget('household', null, groceries, '2026-03')).toBeNull();
    expect(resolveBudget('household', null, groceries, '2026-02')).toBe(8000);
  });
});

describe('copyPreviousMonthAction — review finding 6', () => {
  it('rejects a cross-origin submission before touching the database', async () => {
    const { sqlite, groceries } = setup();
    upsertBudget({ scope: 'household', userId: null, categoryId: groceries, month: '2026-02', amountCents: 8000 });
    mockHeaders = CROSS_ORIGIN;
    const result = await copyPreviousMonthAction({}, formData({ scope: 'household', month: '2026-03', userId: '' }));
    expect(result.error).toMatch(/cross-origin/i);
    // No new row written at the viewed month — only the pre-existing 2026-02 row exists.
    expect((sqlite.prepare('select count(*) as c from budgets where effective_month = ?').get('2026-03') as { c: number }).c).toBe(0);
  });

  it("rejects a member copying another member's personal budgets", async () => {
    const { sqlite, bob, groceries } = setup();
    upsertBudget({ scope: 'personal', userId: bob, categoryId: groceries, month: '2026-02', amountCents: 8000 });
    const result = await copyPreviousMonthAction({}, formData({ scope: 'personal', month: '2026-03', userId: String(bob) }));
    expect(result.error).toMatch(/your own/i);
    expect((sqlite.prepare('select count(*) as c from budgets where effective_month = ?').get('2026-03') as { c: number }).c).toBe(0);
  });

  it("lets an admin override and copy another member's personal budgets", async () => {
    const { admin, bob, groceries } = setup();
    upsertBudget({ scope: 'personal', userId: bob, categoryId: groceries, month: '2026-02', amountCents: 8000 });
    currentUser = { id: admin, name: 'Admin', username: 'admin', role: 'admin' };
    const result = await copyPreviousMonthAction({}, formData({ scope: 'personal', month: '2026-03', userId: String(bob) }));
    expect(result.message).toMatch(/copied 1/i);
    expect(resolveBudget('personal', bob, groceries, '2026-03')).toBe(8000);
  });

  it('happy path: a member copies their own personal budgets and the household budgets', async () => {
    const { alice, groceries } = setup();
    upsertBudget({ scope: 'personal', userId: alice, categoryId: groceries, month: '2026-02', amountCents: 3000 });
    upsertBudget({ scope: 'household', userId: null, categoryId: groceries, month: '2026-02', amountCents: 8000 });

    const own = await copyPreviousMonthAction({}, formData({ scope: 'personal', month: '2026-03', userId: '' }));
    expect(own.message).toMatch(/copied 1/i);
    expect(resolveBudget('personal', alice, groceries, '2026-03')).toBe(3000);

    const household = await copyPreviousMonthAction({}, formData({ scope: 'household', month: '2026-03', userId: '' }));
    expect(household.message).toMatch(/copied 1/i);
    expect(resolveBudget('household', null, groceries, '2026-03')).toBe(8000);
  });
});

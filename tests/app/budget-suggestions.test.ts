import { describe, it, expect, vi, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createSeededTestDb, categoryIdByName, insertTestAccount, insertTestUser, type TestDb } from '../helpers/db';
import { resolveBudget, upsertBudget } from '@/lib/budgets';
import { nowIso } from '@/lib/clock';

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

import { applyAllSuggestionsAction, applySuggestionAction } from '@/app/(app)/budgets/actions';

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

/** Six flat months of spend for a category, ending the month before TARGET. */
const TARGET = '2026-08';
const WINDOW_MONTHS = ['2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07'];

function setup() {
  current = createSeededTestDb();
  const alice = insertTestUser(current.db, { name: 'Alice', username: 'alice', role: 'member' });
  const bob = insertTestUser(current.db, { name: 'Bob', username: 'bob', role: 'member' });
  currentUser = { id: alice, name: 'Alice', username: 'alice', role: 'member' };
  const joint = insertTestAccount(current.db, { name: 'Joint Chequing' });
  const spend = (over: { categoryId: number; amountCents: number; date: string; attributedUserId?: number | null }) => {
    current!.db.run(sql`
      insert into transactions (account_id, date, raw_description, normalized_merchant, amount_cents, category_id, categorization_source, is_transfer, attributed_user_id, created_by, created_at, updated_at)
      values (${joint}, ${over.date}, 'X', 'X', ${over.amountCents}, ${over.categoryId}, 'manual', 0, ${over.attributedUserId ?? null}, ${alice}, ${nowIso()}, ${nowIso()})`);
  };
  const flatSix = (categoryId: number, cents: number, attributedUserId?: number) => {
    for (const month of WINDOW_MONTHS) spend({ categoryId, amountCents: -cents, date: `${month}-10`, attributedUserId });
  };
  return { db: current.db, alice, bob, spend, flatSix };
}

describe('MUST-7.4: the amount is never a form field', () => {
  it('writes the recomputed amount and ignores an amount a crafted request adds', async () => {
    const { db, flatSix } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    flatSix(groceries, 60000);

    const state = await applySuggestionAction(
      {},
      formData({ scope: 'household', userId: '', month: TARGET, categoryId: String(groceries), amount: '999999' }),
    );

    expect(state.error).toBeUndefined();
    expect(resolveBudget('household', null, groceries, TARGET)).toBe(60000);
  });
});

describe('MUST-7.5: a suggestion that is no longer available writes nothing', () => {
  it('returns the reload error for a category with no computable suggestion', async () => {
    const { db, flatSix } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    // Kids is top-level, has no children and has no spend, so its series is all zeros and
    // suggestBudget returns 'no-spend'.
    const kids = categoryIdByName(db, 'Kids');
    flatSix(groceries, 60000);

    const state = await applySuggestionAction(
      {},
      formData({ scope: 'household', userId: '', month: TARGET, categoryId: String(kids) }),
    );

    expect(state.error).toBe('That suggestion is no longer available. Reload the page.');
    expect(resolveBudget('household', null, kids, TARGET)).toBeNull();
  });
});

describe('MUST-7.6: permissions match setLimitAction exactly', () => {
  it('refuses a member writing to another member personal scope, and allows an admin', async () => {
    const { db, bob, flatSix } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    flatSix(groceries, 60000, bob);

    const refused = await applySuggestionAction(
      {},
      formData({ scope: 'personal', userId: String(bob), month: TARGET, categoryId: String(groceries) }),
    );
    expect(refused.error).toBe('You can only edit your own personal budgets.');
    expect(resolveBudget('personal', bob, groceries, TARGET)).toBeNull();

    currentUser = { ...currentUser, role: 'admin' };
    const allowed = await applySuggestionAction(
      {},
      formData({ scope: 'personal', userId: String(bob), month: TARGET, categoryId: String(groceries) }),
    );
    expect(allowed.error).toBeUndefined();
    expect(resolveBudget('personal', bob, groceries, TARGET)).toBe(60000);
  });
});

describe('MUST-7.7: applying at month M writes effective_month M and leaves earlier rows alone', () => {
  it('does not mutate a limit set in an earlier month', async () => {
    const { db, flatSix } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    flatSix(groceries, 60000);
    upsertBudget({ scope: 'household', userId: null, categoryId: groceries, month: '2026-01', amountCents: 12345 });

    await applySuggestionAction({}, formData({ scope: 'household', userId: '', month: TARGET, categoryId: String(groceries) }));

    expect(resolveBudget('household', null, groceries, '2026-01')).toBe(12345);
    expect(resolveBudget('household', null, groceries, '2026-07')).toBe(12345);
    expect(resolveBudget('household', null, groceries, TARGET)).toBe(60000);
  });
});

describe('MUST-7.8: apply-all never overwrites a typed limit', () => {
  it('skips every category with a resolved limit and names both counts', async () => {
    const { db, flatSix } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    const restaurants = categoryIdByName(db, 'Restaurants');
    const food = categoryIdByName(db, 'Food');
    flatSix(groceries, 60000);
    flatSix(restaurants, 30000);
    // Three rows end up with a suggestion: the two children and their rolled-up parent Food
    // at $900.00 a month. Only Restaurants already has a limit, so two are set and one is
    // skipped.
    upsertBudget({ scope: 'household', userId: null, categoryId: restaurants, month: '2026-06', amountCents: 11100 });

    const state = await applyAllSuggestionsAction({}, formData({ scope: 'household', userId: '', month: TARGET }));

    expect(state.message).toBe('Set 2 budgets from suggestions. Skipped 1 categories that already had a limit.');
    expect(resolveBudget('household', null, groceries, TARGET)).toBe(60000);
    expect(resolveBudget('household', null, food, TARGET)).toBe(90000);
    expect(resolveBudget('household', null, restaurants, TARGET)).toBe(11100);
  });

  it('applies to the parent and the child independently, because both are rows on the page', async () => {
    const { db, flatSix } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    const food = categoryIdByName(db, 'Food');
    flatSix(groceries, 60000);

    await applySuggestionAction({}, formData({ scope: 'household', userId: '', month: TARGET, categoryId: String(food) }));

    expect(resolveBudget('household', null, food, TARGET)).toBe(60000);
    expect(resolveBudget('household', null, groceries, TARGET)).toBeNull();
  });
});

describe('same-origin first', () => {
  it('rejects both actions on a cross-origin request before touching the database', async () => {
    const { db, flatSix } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    flatSix(groceries, 60000);
    mockHeaders = CROSS_ORIGIN;

    expect(
      (await applySuggestionAction({}, formData({ scope: 'household', userId: '', month: TARGET, categoryId: String(groceries) })))
        .error,
    ).toBe('Cross-origin request rejected');
    expect((await applyAllSuggestionsAction({}, formData({ scope: 'household', userId: '', month: TARGET }))).error).toBe(
      'Cross-origin request rejected',
    );
    expect(resolveBudget('household', null, groceries, TARGET)).toBeNull();
  });
});

describe('MUST-4.6: under three months of history there are no suggestions at all', () => {
  it('refuses every category on a two-month household', async () => {
    const { db, spend } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    spend({ categoryId: groceries, amountCents: -60000, date: '2026-06-10' });
    spend({ categoryId: groceries, amountCents: -60000, date: '2026-07-10' });

    const state = await applySuggestionAction(
      {},
      formData({ scope: 'household', userId: '', month: TARGET, categoryId: String(groceries) }),
    );
    expect(state.error).toBe('That suggestion is no longer available. Reload the page.');
  });
});

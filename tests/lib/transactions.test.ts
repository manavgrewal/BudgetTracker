import { describe, it, expect, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createSeededTestDb, categoryIdByName, insertTestAccount, insertTestUser, type TestDb } from '../helpers/db';
import {
  bulkSetAttribution,
  bulkSetCategory,
  bulkSetTransfer,
  countMatchingMerchant,
  createManualTransaction,
  displayNameOf,
  getTransaction,
  listReviewQueue,
  listTransactions,
  manualTransactionSchema,
  updateTransactionNotes,
} from '@/lib/transactions';
import { normalizeMerchant } from '@/lib/categorize/normalize';
import { listRules } from '@/lib/categorize/rules';
import { setTransactionDisplayName, upsertRenameRule } from '@/lib/categorize/engine';
import { nowIso } from '@/lib/clock';

let current: TestDb | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
});

function setup() {
  current = createSeededTestDb();
  const alice = insertTestUser(current.db, { name: 'Alice', username: 'alice' });
  const bob = insertTestUser(current.db, { name: 'Bob', username: 'bob' });
  const joint = insertTestAccount(current.db, { name: 'Joint Chequing' });
  const aliceVisa = insertTestAccount(current.db, { name: 'Alice Visa', type: 'credit', ownerUserId: alice });

  const add = (over: Partial<{ accountId: number; date: string; description: string; amountCents: number; categoryId: number | null; attributedUserId: number | null; source: string; isTransfer: boolean }> = {}) => {
    const description = over.description ?? 'TIM HORTONS';
    const row = current!.db.get<{ id: number }>(sql`
      insert into transactions (account_id, date, raw_description, normalized_merchant, amount_cents, category_id, categorization_source, is_transfer, attributed_user_id, created_by, created_at, updated_at)
      values (${over.accountId ?? joint}, ${over.date ?? '2026-03-02'}, ${description}, ${normalizeMerchant(description)},
              ${over.amountCents ?? -1000}, ${over.categoryId ?? null}, ${over.source ?? 'none'},
              ${over.isTransfer ? 1 : 0}, ${over.attributedUserId ?? null}, ${alice}, ${nowIso()}, ${nowIso()})
      returning id`);
    return row.id;
  };
  return { db: current.db, sqlite: current.sqlite, alice, bob, joint, aliceVisa, add };
}

describe('listTransactions', () => {
  it('paginates newest first and reports the total', () => {
    const { add } = setup();
    for (let i = 1; i <= 12; i += 1) add({ date: `2026-03-${String(i).padStart(2, '0')}`, description: `SHOP ${i}` });
    const page = listTransactions({ pageSize: 5, page: 1 });
    expect(page.total).toBe(12);
    expect(page.pageCount).toBe(3);
    expect(page.rows).toHaveLength(5);
    expect(page.rows[0].date).toBe('2026-03-12');
    expect(listTransactions({ pageSize: 5, page: 3 }).rows).toHaveLength(2);
  });

  it('joins the account, category and attributed user names', () => {
    const { db, alice, joint, add } = setup();
    const coffee = categoryIdByName(db, 'Coffee');
    const id = add({ categoryId: coffee, attributedUserId: alice, source: 'manual' });
    const row = listTransactions().rows.find((r) => r.id === id)!;
    expect(row).toMatchObject({
      accountId: joint,
      accountName: 'Joint Chequing',
      categoryId: coffee,
      categoryName: 'Coffee',
      attributedUserId: alice,
      attributedUserName: 'Alice',
      source: 'manual',
      normalizedMerchant: 'TIM HORTONS',
    });
  });

  it('filters by account, category, person, date range and text search', () => {
    const { db, alice, bob, joint, aliceVisa, add } = setup();
    const coffee = categoryIdByName(db, 'Coffee');
    const groceries = categoryIdByName(db, 'Groceries');
    const a = add({ accountId: joint, categoryId: coffee, attributedUserId: alice, date: '2026-03-01', description: 'TIM HORTONS' });
    const b = add({ accountId: aliceVisa, categoryId: groceries, attributedUserId: bob, date: '2026-04-15', description: 'LOBLAWS #1042' });

    expect(listTransactions({ accountId: joint }).rows.map((r) => r.id)).toEqual([a]);
    expect(listTransactions({ categoryId: groceries }).rows.map((r) => r.id)).toEqual([b]);
    expect(listTransactions({ attributedUserId: alice }).rows.map((r) => r.id)).toEqual([a]);
    expect(listTransactions({ from: '2026-04-01' }).rows.map((r) => r.id)).toEqual([b]);
    expect(listTransactions({ to: '2026-03-31' }).rows.map((r) => r.id)).toEqual([a]);
    expect(listTransactions({ search: 'loblaws' }).rows.map((r) => r.id)).toEqual([b]);
    expect(listTransactions({ search: 'hortons' }).rows.map((r) => r.id)).toEqual([a]);
  });

  it('filters uncategorized and unattributed as first-class values', () => {
    const { db, alice, add } = setup();
    const coffee = categoryIdByName(db, 'Coffee');
    const categorized = add({ categoryId: coffee, attributedUserId: alice });
    const bare = add({ description: 'SOME SHOP' });

    expect(listTransactions({ categoryId: 'uncategorized' }).rows.map((r) => r.id)).toEqual([bare]);
    expect(listTransactions({ uncategorizedOnly: true }).rows.map((r) => r.id)).toEqual([bare]);
    expect(listTransactions({ attributedUserId: 'unattributed' }).rows.map((r) => r.id)).toEqual([bare]);
    expect(listTransactions().total).toBe(2);
    expect(categorized).toBeGreaterThan(0);
  });

  it('can exclude transfers', () => {
    const { add } = setup();
    const normal = add({ description: 'TIM HORTONS' });
    const transfer = add({ description: 'PAYMENT - THANK YOU', isTransfer: true });
    expect(listTransactions().rows.map((r) => r.id).sort()).toEqual([normal, transfer].sort());
    expect(listTransactions({ includeTransfers: false }).rows.map((r) => r.id)).toEqual([normal]);
  });

  it('clamps the page size', () => {
    const { add } = setup();
    add();
    expect(listTransactions({ pageSize: 5000 }).pageSize).toBe(200);
    expect(listTransactions({ pageSize: 0 }).pageSize).toBe(50);
    expect(listTransactions({ page: -3 }).page).toBe(1);
  });
});

describe('createManualTransaction', () => {
  it('stores a NULL dedup hash and NULL import id', () => {
    const { sqlite, alice, joint } = setup();
    const id = createManualTransaction({
      accountId: joint,
      date: '2026-03-02',
      description: 'Farmers market',
      amountCents: -2500,
      categoryId: null,
      attributedUserId: alice,
      userId: alice,
    });
    const row = sqlite.prepare('select dedup_hash, import_id, created_by, attributed_user_id, normalized_merchant, categorization_source from transactions where id = ?').get(id) as Record<string, unknown>;
    expect(row).toMatchObject({ dedup_hash: null, import_id: null, created_by: alice, attributed_user_id: alice, normalized_merchant: 'FARMERS MARKET' });
  });

  it('lets two identical manual entries coexist', () => {
    const { alice, joint } = setup();
    const make = () =>
      createManualTransaction({ accountId: joint, date: '2026-03-02', description: 'Coffee', amountCents: -500, categoryId: null, attributedUserId: alice, userId: alice });
    const first = make();
    const second = make();
    expect(second).not.toBe(first);
    expect(listTransactions().total).toBe(2);
  });

  it('defaults attribution to the account owner when none is given', () => {
    const { sqlite, alice, aliceVisa, joint } = setup();
    const personal = createManualTransaction({ accountId: aliceVisa, date: '2026-03-02', description: 'Coffee', amountCents: -500, categoryId: null, attributedUserId: null, userId: alice });
    const shared = createManualTransaction({ accountId: joint, date: '2026-03-02', description: 'Coffee', amountCents: -500, categoryId: null, attributedUserId: null, userId: alice });
    expect((sqlite.prepare('select attributed_user_id as a from transactions where id = ?').get(personal) as { a: number | null }).a).toBe(alice);
    expect((sqlite.prepare('select attributed_user_id as a from transactions where id = ?').get(shared) as { a: number | null }).a).toBeNull();
  });

  it('runs the engine on the new row', () => {
    const { db, sqlite, alice, joint } = setup();
    const id = createManualTransaction({ accountId: joint, date: '2026-03-02', description: 'PAYMENT - THANK YOU', amountCents: 50000, categoryId: null, attributedUserId: null, userId: alice });
    expect((sqlite.prepare('select is_transfer from transactions where id = ?').get(id) as { is_transfer: number }).is_transfer).toBe(1);
    expect(db).toBeDefined();
  });

  it('treats an explicit category as a confirmation that trains Bayes and makes a rule', () => {
    const { db, sqlite, alice, joint } = setup();
    const coffee = categoryIdByName(db, 'Coffee');
    const id = createManualTransaction({ accountId: joint, date: '2026-03-02', description: 'Tim Hortons', amountCents: -485, categoryId: coffee, attributedUserId: alice, userId: alice });
    const row = sqlite.prepare('select category_id, categorization_source from transactions where id = ?').get(id) as { category_id: number; categorization_source: string };
    expect(row).toEqual({ category_id: coffee, categorization_source: 'manual' });
    expect(listRules('category').map((r) => r.pattern)).toEqual(['TIM HORTONS']);
  });

  it('validates its input with zod', () => {
    expect(manualTransactionSchema.safeParse({ accountId: 1, date: '2026-13-40', description: 'x', amountCents: -1, categoryId: null, attributedUserId: null }).success).toBe(false);
    expect(manualTransactionSchema.safeParse({ accountId: 1, date: '2026-03-02', description: '', amountCents: -1, categoryId: null, attributedUserId: null }).success).toBe(false);
    expect(manualTransactionSchema.safeParse({ accountId: 1, date: '2026-03-02', description: 'x', amountCents: 0, categoryId: null, attributedUserId: null }).success).toBe(true);
  });
});

describe('bulk actions', () => {
  it('sets attribution without touching created_by', () => {
    const { sqlite, alice, bob, add } = setup();
    const ids = [add(), add({ description: 'LOBLAWS' })];
    expect(bulkSetAttribution(ids, bob)).toBe(2);
    const rows = sqlite.prepare('select attributed_user_id, created_by from transactions').all() as { attributed_user_id: number; created_by: number }[];
    expect(rows.every((r) => r.attributed_user_id === bob)).toBe(true);
    expect(rows.every((r) => r.created_by === alice)).toBe(true);
    expect(bulkSetAttribution(ids, null)).toBe(2);
    expect((sqlite.prepare('select count(*) as c from transactions where attributed_user_id is null').get() as { c: number }).c).toBe(2);
  });

  it('bulk categorize confirms every row and can create rules', () => {
    const { db, sqlite, alice, add } = setup();
    const coffee = categoryIdByName(db, 'Coffee');
    const ids = [add({ description: 'TIM HORTONS' }), add({ description: 'STARBUCKS' })];
    expect(bulkSetCategory(ids, coffee, alice, true)).toBe(2);
    const rows = sqlite.prepare('select category_id, categorization_source from transactions').all() as { category_id: number; categorization_source: string }[];
    expect(rows.every((r) => r.category_id === coffee && r.categorization_source === 'manual')).toBe(true);
    expect(listRules('category').map((r) => r.pattern).sort()).toEqual(['STARBUCKS', 'TIM HORTONS']);
  });

  it('bulk categorize can skip rule creation', () => {
    const { db, alice, add } = setup();
    const coffee = categoryIdByName(db, 'Coffee');
    bulkSetCategory([add()], coffee, alice, false);
    expect(listRules('category')).toHaveLength(0);
  });

  it('bulk mark transfer teaches exact transfer rules', () => {
    const { sqlite, alice, add } = setup();
    const ids = [add({ description: 'E-TRANSFER SENT J DOE' })];
    expect(bulkSetTransfer(ids, true, alice)).toBe(1);
    expect((sqlite.prepare('select is_transfer from transactions where id = ?').get(ids[0]) as { is_transfer: number }).is_transfer).toBe(1);
    expect(listRules('transfer').map((r) => ({ pattern: r.pattern, matchType: r.matchType }))).toEqual([
      { pattern: 'E-TRANSFER SENT J DOE', matchType: 'exact' },
    ]);
  });

  it('bulk actions on an empty id list do nothing', () => {
    const { alice } = setup();
    expect(bulkSetAttribution([], null)).toBe(0);
    expect(bulkSetCategory([], 1, alice, true)).toBe(0);
    expect(bulkSetTransfer([], true, alice)).toBe(0);
  });
});

describe('review queue and merchant counting', () => {
  it('returns uncategorized and unconfirmed bayes rows oldest first', () => {
    const { db, add } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    const older = add({ date: '2026-03-01', description: 'SHOP A' });
    const bayesRow = add({ date: '2026-03-05', description: 'SHOP B', categoryId: groceries, source: 'bayes' });
    add({ date: '2026-03-06', description: 'SHOP C', categoryId: groceries, source: 'manual' });

    const queue = listReviewQueue();
    expect(queue.map((r) => r.id)).toEqual([older, bayesRow]);
    expect(queue[0].categoryName).toBeNull();
    expect(queue[1].source).toBe('bayes');
  });

  it('counts other transactions sharing a normalized merchant', () => {
    const { add } = setup();
    add({ description: 'POS PURCHASE TIM HORTONS #4821 TORONTO ON' });
    add({ description: 'POS PURCHASE TIM HORTONS #1099 OAKVILLE ON' });
    add({ description: 'LOBLAWS #1042 BURLINGTON ON' });
    expect(countMatchingMerchant('TIM HORTONS')).toBe(2);
    expect(countMatchingMerchant('LOBLAWS')).toBe(1);
    expect(countMatchingMerchant('NOBODY')).toBe(0);
  });
});

describe('display names (spec v1.4)', () => {
  it('falls back to the raw description until something sets a display name', () => {
    const { add } = setup();
    const id = add({ description: 'POS PURCHASE MCDONALDS #4821 TORONTO ON' });
    const row = getTransaction(id)!;
    expect(row).toMatchObject({ displayDescription: null, displaySource: null });
    expect(displayNameOf(row)).toBe('POS PURCHASE MCDONALDS #4821 TORONTO ON');
  });

  it('surfaces a rule-applied rename and a manual rename through the row', () => {
    const { alice, add } = setup();
    const ruled = add({ description: 'POS PURCHASE MCDONALDS #4821 TORONTO ON' });
    const manual = add({ description: 'POS PURCHASE MCDONALDS #1099 OAKVILLE ON' });

    upsertRenameRule({ pattern: 'MCDONALDS', matchType: 'exact', renameTo: "McDonald's", userId: alice });
    setTransactionDisplayName({ transactionId: manual, displayDescription: 'Lunch with Bob', userId: alice });

    expect(getTransaction(ruled)).toMatchObject({ displayDescription: "McDonald's", displaySource: 'rename' });
    expect(getTransaction(manual)).toMatchObject({ displayDescription: 'Lunch with Bob', displaySource: 'manual' });
    expect(displayNameOf(getTransaction(manual)!)).toBe('Lunch with Bob');
  });

  it('keeps the raw description available alongside the display name', () => {
    const { alice, add } = setup();
    const id = add({ description: 'SQ *BLUE BOTTLE COFFEE' });
    setTransactionDisplayName({ transactionId: id, displayDescription: 'Blue Bottle', userId: alice });
    const row = getTransaction(id)!;
    expect(row.rawDescription).toBe('SQ *BLUE BOTTLE COFFEE');
    expect(row.displayDescription).toBe('Blue Bottle');
  });

  it('search matches the display name as well as the raw text', () => {
    const { alice, add } = setup();
    const id = add({ description: 'SQ *BLUE BOTTLE COFFEE' });
    add({ description: 'LOBLAWS #1042 BURLINGTON ON' });
    setTransactionDisplayName({ transactionId: id, displayDescription: 'Morning ritual', userId: alice });

    expect(listTransactions({ search: 'morning' }).rows.map((r) => r.id)).toEqual([id]);
    expect(listTransactions({ search: 'blue bottle' }).rows.map((r) => r.id)).toEqual([id]);
    expect(listTransactions({ search: 'loblaws' }).rows.map((r) => r.id)).not.toContain(id);
  });
});

describe('notes and single reads', () => {
  it('reads one row and updates its note', () => {
    const { add } = setup();
    const id = add();
    expect(getTransaction(id)?.notes).toBeNull();
    updateTransactionNotes(id, 'split with Bob');
    expect(getTransaction(id)?.notes).toBe('split with Bob');
    updateTransactionNotes(id, null);
    expect(getTransaction(id)?.notes).toBeNull();
    expect(getTransaction(999999)).toBeNull();
  });
});

import { describe, it, expect, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createSeededTestDb, categoryIdByName, insertTestAccount, insertTestUser, type TestDb } from '../helpers/db';
import {
  UNATTRIBUTED_LABEL,
  cashflowTrend,
  categoryBreakdown,
  categoryMonthOverMonth,
  personSpendSplit,
  toCsv,
  topMerchants,
  transactionsCsv,
} from '@/lib/reports';
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
  const account = insertTestAccount(current.db, { name: 'Joint Chequing' });

  const add = (over: {
    categoryId: number | null;
    amountCents: number;
    date?: string;
    attributedUserId?: number | null;
    isTransfer?: boolean;
    merchant?: string;
  }) => {
    const merchant = over.merchant ?? 'TIM HORTONS';
    const row = current!.db.get<{ id: number }>(sql`
      insert into transactions (account_id, date, raw_description, normalized_merchant, amount_cents, category_id, categorization_source, is_transfer, attributed_user_id, created_by, created_at, updated_at)
      values (${account}, ${over.date ?? '2026-03-10'}, ${merchant}, ${merchant}, ${over.amountCents}, ${over.categoryId}, 'manual', ${over.isTransfer ? 1 : 0}, ${over.attributedUserId ?? null}, ${alice}, ${nowIso()}, ${nowIso()})
      returning id`);
    return row.id;
  };
  return { db: current.db, sqlite: current.sqlite, alice, bob, account, add };
}

const MARCH = { from: '2026-03-01', to: '2026-03-31' };

describe('categoryBreakdown', () => {
  it('nets refunds and excludes transfers', () => {
    const { db, add } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    add({ categoryId: groceries, amountCents: -12000 });
    add({ categoryId: groceries, amountCents: 2000 });
    add({ categoryId: groceries, amountCents: -99999, isTransfer: true });

    const rows = categoryBreakdown(MARCH);
    expect(rows.find((r) => r.categoryId === groceries)?.spentCents).toBe(10000);
  });

  it('includes an Uncategorized bucket with a null id', () => {
    const { add } = setup();
    add({ categoryId: null, amountCents: -4000 });
    const rows = categoryBreakdown(MARCH);
    expect(rows.find((r) => r.categoryId === null)).toMatchObject({ categoryName: 'Uncategorized', spentCents: 4000 });
  });

  it('excludes income categories by default and can include them', () => {
    const { db, add } = setup();
    const salary = categoryIdByName(db, 'Salary');
    const groceries = categoryIdByName(db, 'Groceries');
    add({ categoryId: salary, amountCents: 500000 });
    add({ categoryId: groceries, amountCents: -12000 });

    expect(categoryBreakdown(MARCH).some((r) => r.categoryId === salary)).toBe(false);
    const withIncome = categoryBreakdown({ ...MARCH, includeIncome: true });
    expect(withIncome.find((r) => r.categoryId === salary)?.spentCents).toBe(-500000);
  });

  it('rolls children into their parent when asked', () => {
    const { db, add } = setup();
    const food = categoryIdByName(db, 'Food');
    const groceries = categoryIdByName(db, 'Groceries');
    const coffee = categoryIdByName(db, 'Coffee');
    add({ categoryId: food, amountCents: -1000 });
    add({ categoryId: groceries, amountCents: -20000 });
    add({ categoryId: coffee, amountCents: -3000 });

    const flat = categoryBreakdown(MARCH);
    expect(flat.find((r) => r.categoryId === food)?.spentCents).toBe(1000);

    const rolled = categoryBreakdown({ ...MARCH, rollup: true });
    expect(rolled.find((r) => r.categoryId === food)?.spentCents).toBe(24000);
    expect(rolled.some((r) => r.categoryId === groceries)).toBe(false);
  });

  it('respects the date range and the person filter', () => {
    const { db, alice, bob, add } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    add({ categoryId: groceries, amountCents: -1000, date: '2026-02-28' });
    add({ categoryId: groceries, amountCents: -2000, date: '2026-03-01', attributedUserId: alice });
    add({ categoryId: groceries, amountCents: -3000, date: '2026-03-31', attributedUserId: bob });
    add({ categoryId: groceries, amountCents: -4000, date: '2026-04-01' });

    expect(categoryBreakdown(MARCH).find((r) => r.categoryId === groceries)?.spentCents).toBe(5000);
    expect(categoryBreakdown({ ...MARCH, attributedUserId: alice }).find((r) => r.categoryId === groceries)?.spentCents).toBe(2000);
  });

  it('sorts by spend, highest first', () => {
    const { db, add } = setup();
    add({ categoryId: categoryIdByName(db, 'Coffee'), amountCents: -1000 });
    add({ categoryId: categoryIdByName(db, 'Groceries'), amountCents: -9000 });
    const rows = categoryBreakdown(MARCH);
    expect(rows[0].categoryName).toBe('Groceries');
  });
});

describe('cashflowTrend', () => {
  it('separates income from spend and excludes transfers', () => {
    const { db, add } = setup();
    const salary = categoryIdByName(db, 'Salary');
    const groceries = categoryIdByName(db, 'Groceries');
    add({ categoryId: salary, amountCents: 500000, date: '2026-03-01' });
    add({ categoryId: groceries, amountCents: -120000, date: '2026-03-05' });
    add({ categoryId: null, amountCents: -30000, date: '2026-03-06' });
    add({ categoryId: null, amountCents: -900000, date: '2026-03-07', isTransfer: true });

    const trend = cashflowTrend(3, { endMonth: '2026-03' });
    expect(trend.map((r) => r.month)).toEqual(['2026-01', '2026-02', '2026-03']);
    const march = trend[2];
    expect(march.incomeCents).toBe(500000);
    expect(march.spendCents).toBe(150000);
    expect(march.netCents).toBe(350000);
  });

  it('never lets a refund inflate income', () => {
    const { db, add } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    add({ categoryId: groceries, amountCents: 5000, date: '2026-03-05' });
    const march = cashflowTrend(1, { endMonth: '2026-03' })[0];
    expect(march.incomeCents).toBe(0);
    expect(march.spendCents).toBe(-5000);
  });

  it('emits zero-filled months with no activity', () => {
    setup();
    const trend = cashflowTrend(12, { endMonth: '2026-03' });
    expect(trend).toHaveLength(12);
    expect(trend[0].month).toBe('2025-04');
    expect(trend.every((r) => r.incomeCents === 0 && r.spendCents === 0)).toBe(true);
  });

  it('can scope to one person', () => {
    const { db, alice, bob, add } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    add({ categoryId: groceries, amountCents: -10000, date: '2026-03-05', attributedUserId: alice });
    add({ categoryId: groceries, amountCents: -20000, date: '2026-03-06', attributedUserId: bob });
    add({ categoryId: groceries, amountCents: -30000, date: '2026-03-07', attributedUserId: null });

    expect(cashflowTrend(1, { endMonth: '2026-03' })[0].spendCents).toBe(60000);
    expect(cashflowTrend(1, { endMonth: '2026-03', attributedUserId: alice })[0].spendCents).toBe(10000);
    expect(cashflowTrend(1, { endMonth: '2026-03', attributedUserId: 'unattributed' })[0].spendCents).toBe(30000);
  });
});

describe('categoryMonthOverMonth', () => {
  it('returns one row per category with a value for every month in the range', () => {
    const { db, add } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    const coffee = categoryIdByName(db, 'Coffee');
    add({ categoryId: groceries, amountCents: -10000, date: '2026-01-05' });
    add({ categoryId: groceries, amountCents: -12000, date: '2026-02-05' });
    add({ categoryId: coffee, amountCents: -2000, date: '2026-02-05' });

    const result = categoryMonthOverMonth({ fromMonth: '2026-01', toMonth: '2026-03' });
    expect(result.months).toEqual(['2026-01', '2026-02', '2026-03']);
    const groceriesRow = result.rows.find((r) => r.categoryId === groceries)!;
    expect(groceriesRow.byMonth).toEqual({ '2026-01': 10000, '2026-02': 12000, '2026-03': 0 });
    expect(groceriesRow.totalCents).toBe(22000);
    expect(result.rows[0].categoryId).toBe(groceries); // biggest total first
    expect(result.rows.find((r) => r.categoryId === coffee)?.byMonth['2026-01']).toBe(0);
  });

  it('honours the limit', () => {
    const { db, add } = setup();
    add({ categoryId: categoryIdByName(db, 'Groceries'), amountCents: -10000, date: '2026-01-05' });
    add({ categoryId: categoryIdByName(db, 'Coffee'), amountCents: -2000, date: '2026-01-05' });
    add({ categoryId: categoryIdByName(db, 'Gas'), amountCents: -5000, date: '2026-01-05' });
    expect(categoryMonthOverMonth({ fromMonth: '2026-01', toMonth: '2026-01', limit: 2 }).rows).toHaveLength(2);
  });

  it('stays continuous across a year boundary', () => {
    const { db, add } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    add({ categoryId: groceries, amountCents: -5000, date: '2025-11-15' });
    add({ categoryId: groceries, amountCents: -6000, date: '2025-12-20' });
    add({ categoryId: groceries, amountCents: -7000, date: '2026-01-05' });
    add({ categoryId: groceries, amountCents: -8000, date: '2026-02-01' });

    const result = categoryMonthOverMonth({ fromMonth: '2025-11', toMonth: '2026-02' });
    expect(result.months).toEqual(['2025-11', '2025-12', '2026-01', '2026-02']);
    const row = result.rows.find((r) => r.categoryId === groceries)!;
    expect(row.byMonth).toEqual({ '2025-11': 5000, '2025-12': 6000, '2026-01': 7000, '2026-02': 8000 });
    expect(row.totalCents).toBe(26000);
  });
});

describe('personSpendSplit', () => {
  it('buckets by attribution and gives unattributed spend its own bucket', () => {
    const { db, alice, bob, add } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    add({ categoryId: groceries, amountCents: -10000, attributedUserId: alice });
    add({ categoryId: groceries, amountCents: -20000, attributedUserId: bob });
    add({ categoryId: groceries, amountCents: -30000, attributedUserId: null });
    add({ categoryId: null, amountCents: -5000, attributedUserId: null });

    const split = personSpendSplit(MARCH);
    expect(UNATTRIBUTED_LABEL).toBe('Household/unattributed');
    expect(split.find((r) => r.userId === alice)).toMatchObject({ label: 'Alice', spentCents: 10000 });
    expect(split.find((r) => r.userId === bob)).toMatchObject({ label: 'Bob', spentCents: 20000 });
    expect(split.find((r) => r.userId === null)).toMatchObject({ label: UNATTRIBUTED_LABEL, spentCents: 35000 });
  });

  it('always includes the unattributed bucket, even at zero', () => {
    const { db, alice, add } = setup();
    add({ categoryId: categoryIdByName(db, 'Groceries'), amountCents: -10000, attributedUserId: alice });
    expect(personSpendSplit(MARCH).find((r) => r.userId === null)).toMatchObject({ spentCents: 0 });
  });

  it('excludes income and transfers', () => {
    const { db, alice, add } = setup();
    add({ categoryId: categoryIdByName(db, 'Salary'), amountCents: 500000, attributedUserId: alice });
    add({ categoryId: categoryIdByName(db, 'Groceries'), amountCents: -900000, attributedUserId: alice, isTransfer: true });
    add({ categoryId: categoryIdByName(db, 'Groceries'), amountCents: -1000, attributedUserId: alice });
    expect(personSpendSplit(MARCH).find((r) => r.userId === alice)?.spentCents).toBe(1000);
  });
});

describe('topMerchants', () => {
  it('ranks merchants by net spend with a transaction count', () => {
    const { db, add } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    add({ categoryId: groceries, amountCents: -10000, merchant: 'LOBLAWS' });
    add({ categoryId: groceries, amountCents: -12000, merchant: 'LOBLAWS' });
    add({ categoryId: groceries, amountCents: 2000, merchant: 'LOBLAWS' });
    add({ categoryId: groceries, amountCents: -5000, merchant: 'METRO' });

    const rows = topMerchants({ ...MARCH, limit: 5 });
    expect(rows[0]).toMatchObject({ normalizedMerchant: 'LOBLAWS', spentCents: 20000, count: 3 });
    expect(rows[1]).toMatchObject({ normalizedMerchant: 'METRO', spentCents: 5000, count: 1 });
  });

  it('drops merchants whose net is zero or negative and honours the limit', () => {
    const { db, add } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    add({ categoryId: groceries, amountCents: 3000, merchant: 'REFUND ONLY' });
    add({ categoryId: groceries, amountCents: -1000, merchant: 'A' });
    add({ categoryId: groceries, amountCents: -2000, merchant: 'B' });
    const rows = topMerchants({ ...MARCH, limit: 1 });
    expect(rows).toHaveLength(1);
    expect(rows[0].normalizedMerchant).toBe('B');
  });
});

describe('csv export', () => {
  it('quotes commas, quotes and newlines per RFC 4180', () => {
    const csv = toCsv(
      [
        { a: 'plain', b: 'has,comma' },
        { a: 'has"quote', b: 'has\nnewline' },
      ],
      [
        { key: 'a', header: 'Column A' },
        { key: 'b', header: 'Column B' },
      ],
    );
    expect(csv).toBe('Column A,Column B\r\nplain,"has,comma"\r\n"has""quote","has\nnewline"\r\n');
  });

  it('renders null and undefined as empty cells', () => {
    const csv = toCsv([{ a: null, b: undefined, c: 0 }], [
      { key: 'a', header: 'A' },
      { key: 'b', header: 'B' },
      { key: 'c', header: 'C' },
    ]);
    expect(csv).toBe('A,B,C\r\n,,0\r\n');
  });

  it('quotes a single field containing a comma, a quote and a newline all at once', () => {
    const csv = toCsv(
      [{ a: 'safe', b: 'weird, "quoted"\nvalue' }],
      [
        { key: 'a', header: 'A' },
        { key: 'b', header: 'B' },
      ],
    );
    expect(csv).toBe('A,B\r\nsafe,"weird, ""quoted""\nvalue"\r\n');
  });

  it('exports the filtered transactions view with readable columns', () => {
    const { db, alice, add } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    add({ categoryId: groceries, amountCents: -12345, attributedUserId: alice, merchant: 'LOBLAWS', date: '2026-03-05' });
    add({ categoryId: null, amountCents: -500, merchant: 'UNKNOWN SHOP', date: '2026-03-06' });

    const csv = transactionsCsv({ from: '2026-03-01', to: '2026-03-31' });
    const lines = csv.trim().split('\r\n');
    expect(lines[0]).toBe('Date,Account,Description,Merchant,Amount,Category,Person,Transfer,Source,Notes');
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain('2026-03-06');
    expect(lines[1]).toContain('-5.00');
    expect(lines[1]).toContain('Uncategorized');
    expect(lines[2]).toContain('Alice');
    expect(lines[2]).toContain('-123.45');
  });
});

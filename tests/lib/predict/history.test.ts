import { describe, it, expect, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createSeededTestDb, categoryIdByName, insertTestAccount, insertTestUser, type TestDb } from '../../helpers/db';
import { budgetProgress, type BudgetRow } from '@/lib/budgets';
import { nowIso } from '@/lib/clock';
import { categorySeries, firstDataMonth, seasonalReference } from '@/lib/predict/history';

let current: TestDb | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
});

/** budgetProgress() nests children; the series is flat, so the comparison needs this. */
function flatten(rows: BudgetRow[], acc: BudgetRow[] = []): BudgetRow[] {
  for (const row of rows) {
    acc.push(row);
    if (row.children.length > 0) flatten(row.children, acc);
  }
  return acc;
}

function setup() {
  current = createSeededTestDb();
  const alice = insertTestUser(current.db, { name: 'Alice', username: 'alice' });
  const bob = insertTestUser(current.db, { name: 'Bob', username: 'bob' });
  const joint = insertTestAccount(current.db, { name: 'Joint Chequing' });
  const spend = (over: {
    categoryId: number | null;
    amountCents: number;
    date: string;
    attributedUserId?: number | null;
    isTransfer?: boolean;
  }) => {
    const row = current!.db.get<{ id: number }>(sql`
      insert into transactions (account_id, date, raw_description, normalized_merchant, amount_cents, category_id, categorization_source, is_transfer, attributed_user_id, created_by, created_at, updated_at)
      values (${joint}, ${over.date}, 'X', 'X', ${over.amountCents}, ${over.categoryId}, 'manual', ${over.isTransfer ? 1 : 0}, ${over.attributedUserId ?? null}, ${alice}, ${nowIso()}, ${nowIso()})
      returning id`);
    return row.id;
  };
  /** A new child of an EXISTING top-level parent. The seeded tree is two levels deep. */
  const child = (name: string, parentId: number, opts: { isIncome?: boolean; isArchived?: boolean } = {}) => {
    const row = current!.db.get<{ id: number }>(sql`
      insert into categories (name, parent_id, is_income, is_archived, sort_order)
      values (${name}, ${parentId}, ${opts.isIncome ? 1 : 0}, ${opts.isArchived ? 1 : 0}, 0)
      returning id`);
    return row.id;
  };
  return { db: current.db, alice, bob, joint, spend, child };
}

const WINDOW = ['2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07'];
const pick = <T extends { categoryId: number }>(rows: T[], categoryId: number) => rows.find((row) => row.categoryId === categoryId);

describe('MUST-4.4: a month with no spend contributes a zero, not a gap', () => {
  it('zero-fills every month in the window, for a child row and for its parent', () => {
    const { db, spend } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    const food = categoryIdByName(db, 'Food');
    spend({ categoryId: groceries, amountCents: -10000, date: '2026-02-10' });
    spend({ categoryId: groceries, amountCents: -20000, date: '2026-05-10' });

    const series = categorySeries({ months: WINDOW, scope: 'household', userId: null });
    expect(pick(series, groceries)?.monthlyCents).toEqual([10000, 0, 0, 20000, 0, 0]);
    expect(pick(series, food)?.monthlyCents).toEqual([10000, 0, 0, 20000, 0, 0]);
  });
});

describe('MUST-3.2: the series is budgetProgress, row for row', () => {
  it('matches flatten(budgetProgress()) exactly on the seeded tree, ids, order and cents', () => {
    const { db, spend, child } = setup();
    const food = categoryIdByName(db, 'Food');
    const groceries = categoryIdByName(db, 'Groceries');
    const gas = categoryIdByName(db, 'Gas');
    const kids = categoryIdByName(db, 'Kids');
    const gone = child('Corner Store', food, { isArchived: true });
    const rebate = child('Grocery rebate', food, { isIncome: true });

    spend({ categoryId: food, amountCents: -4000, date: '2026-07-01' }); // spend on the parent itself
    spend({ categoryId: groceries, amountCents: -30000, date: '2026-07-05' });
    spend({ categoryId: gone, amountCents: -5000, date: '2026-07-06' }); // archived child
    spend({ categoryId: rebate, amountCents: 9000, date: '2026-07-07' }); // income child
    spend({ categoryId: gas, amountCents: -6000, date: '2026-07-08' });
    spend({ categoryId: kids, amountCents: -1500, date: '2026-07-09' }); // top-level leaf

    const series = categorySeries({ months: ['2026-07'], scope: 'household', userId: null });
    const progress = flatten(budgetProgress('2026-07', 'household', null));

    expect(series.map((row) => [row.categoryId, row.monthlyCents[0]])).toEqual(
      progress.map((row) => [row.categoryId, row.spentCents]),
    );
  });

  it('rolls an archived child into its top-level parent and gives it no row of its own', () => {
    const { db, spend, child } = setup();
    const food = categoryIdByName(db, 'Food');
    const groceries = categoryIdByName(db, 'Groceries');
    const gone = child('Corner Store', food, { isArchived: true });
    spend({ categoryId: groceries, amountCents: -30000, date: '2026-07-05' });
    spend({ categoryId: gone, amountCents: -5000, date: '2026-07-06' });

    const series = categorySeries({ months: ['2026-07'], scope: 'household', userId: null });
    expect(pick(series, food)?.monthlyCents).toEqual([35000]);
    expect(pick(series, groceries)?.monthlyCents).toEqual([30000]);
    expect(pick(series, gone)).toBeUndefined();
  });

  it('drops an archived top-level category with no own spend, and its spending child, from series and progress alike', () => {
    const { db, spend, child } = setup();
    const kids = categoryIdByName(db, 'Kids');
    db.run(sql`update categories set is_archived = 1 where id = ${kids}`);
    const leftover = child('Kids leftover', kids);
    spend({ categoryId: leftover, amountCents: -5000, date: '2026-07-05' });

    const series = categorySeries({ months: ['2026-07'], scope: 'household', userId: null });
    const progress = flatten(budgetProgress('2026-07', 'household', null));
    expect(series.some((row) => row.categoryId === kids || row.categoryId === leftover)).toBe(false);
    expect(progress.some((row) => row.categoryId === kids || row.categoryId === leftover)).toBe(false);
  });

  it('surfaces an archived top-level category with its own spend, rolling in a live child that gets its own row', () => {
    const { db, spend, child } = setup();
    const kids = categoryIdByName(db, 'Kids');
    db.run(sql`update categories set is_archived = 1 where id = ${kids}`);
    const leftover = child('Kids leftover', kids);
    spend({ categoryId: kids, amountCents: -4000, date: '2026-07-05' });
    spend({ categoryId: leftover, amountCents: -3000, date: '2026-07-06' });

    const series = categorySeries({ months: ['2026-07'], scope: 'household', userId: null });
    const progress = flatten(budgetProgress('2026-07', 'household', null));
    expect(pick(series, kids)?.monthlyCents).toEqual([7000]);
    expect(pick(series, leftover)?.monthlyCents).toEqual([3000]);
    expect(progress.find((row) => row.categoryId === kids)?.spentCents).toBe(7000);
    expect(progress.find((row) => row.categoryId === leftover)?.spentCents).toBe(3000);
  });

  it('drops income categories and never lets an income child change a spend parent', () => {
    const { db, spend, child } = setup();
    const food = categoryIdByName(db, 'Food');
    const groceries = categoryIdByName(db, 'Groceries');
    const rebate = child('Grocery rebate', food, { isIncome: true });
    spend({ categoryId: groceries, amountCents: -30000, date: '2026-07-05' });
    spend({ categoryId: rebate, amountCents: 9000, date: '2026-07-06' });

    const series = categorySeries({ months: ['2026-07'], scope: 'household', userId: null });
    expect(pick(series, food)?.monthlyCents).toEqual([30000]);
    expect(series.some((row) => row.categoryId === rebate)).toBe(false);
  });

  it('gives every row budgetProgress draws an all-zero series when nothing was spent', () => {
    const { db } = setup();
    const series = categorySeries({ months: WINDOW, scope: 'household', userId: null });
    expect(pick(series, categoryIdByName(db, 'Food'))?.monthlyCents).toEqual([0, 0, 0, 0, 0, 0]);
    expect(pick(series, categoryIdByName(db, 'Groceries'))?.monthlyCents).toEqual([0, 0, 0, 0, 0, 0]);
    expect(pick(series, categoryIdByName(db, 'Kids'))?.monthlyCents).toEqual([0, 0, 0, 0, 0, 0]);
    // Income is gone entirely, at both levels.
    expect(series.some((row) => row.categoryName === 'Income' || row.categoryName === 'Salary')).toBe(false);
  });
});

describe('MUST-3.1: scope', () => {
  it('household counts every row and personal counts only the attributed ones', () => {
    const { db, alice, bob, spend } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    const food = categoryIdByName(db, 'Food');
    spend({ categoryId: groceries, amountCents: -10000, date: '2026-07-01', attributedUserId: alice });
    spend({ categoryId: groceries, amountCents: -20000, date: '2026-07-02', attributedUserId: bob });
    spend({ categoryId: groceries, amountCents: -5000, date: '2026-07-03' });

    const cents = (scope: 'household' | 'personal', userId: number | null, categoryId: number) =>
      pick(categorySeries({ months: ['2026-07'], scope, userId }), categoryId)?.monthlyCents;

    expect(cents('household', null, groceries)).toEqual([35000]);
    expect(cents('household', null, food)).toEqual([35000]);
    expect(cents('personal', alice, groceries)).toEqual([10000]);
    expect(cents('personal', bob, groceries)).toEqual([20000]);
  });

  it('MUST-7.2: personal is all zeros when nothing is attributed', () => {
    const { db, alice, spend } = setup();
    spend({ categoryId: categoryIdByName(db, 'Groceries'), amountCents: -10000, date: '2026-07-01' });
    const personal = categorySeries({ months: ['2026-07'], scope: 'personal', userId: alice });
    expect(personal.length).toBeGreaterThan(0);
    expect(personal.every((row) => row.monthlyCents.every((cents) => cents === 0))).toBe(true);
  });
});

describe('MUST-4.3: firstDataMonth', () => {
  it('is the month of the oldest non-transfer row, and null on an empty database', () => {
    const { db, spend } = setup();
    expect(firstDataMonth()).toBeNull();
    spend({ categoryId: null, amountCents: -100, date: '2020-01-05', isTransfer: true });
    spend({ categoryId: categoryIdByName(db, 'Groceries'), amountCents: -10000, date: '2026-03-09' });
    expect(firstDataMonth()).toBe('2026-03');
  });
});

describe('MUST-4.8: one grouped query per call', () => {
  /** Wraps better-sqlite3's prepare so the caller can count the statements drizzle issues. */
  function countingPrepare(): { statements: string[]; restore: () => void } {
    const statements: string[] = [];
    const sqlite = current!.sqlite as unknown as { prepare: (source: string) => unknown };
    const original = sqlite.prepare.bind(sqlite);
    sqlite.prepare = (source: string) => {
      statements.push(source);
      return original(source);
    };
    return { statements, restore: () => { sqlite.prepare = original; } };
  }

  it('reads transactions exactly once', () => {
    const { db, spend } = setup();
    spend({ categoryId: categoryIdByName(db, 'Groceries'), amountCents: -10000, date: '2026-07-01' });
    const { statements, restore } = countingPrepare();
    try {
      categorySeries({ months: WINDOW, scope: 'household', userId: null });
    } finally {
      restore();
    }
    expect(statements.filter((statement) => /\btransactions\b/.test(statement))).toHaveLength(1);
  });

  it('returns an empty list and runs no query at all for an empty window', () => {
    setup();
    const { statements, restore } = countingPrepare();
    try {
      expect(categorySeries({ months: [], scope: 'household', userId: null })).toEqual([]);
    } finally {
      restore();
    }
    expect(statements.filter((statement) => /\btransactions\b/.test(statement))).toHaveLength(0);
  });
});

describe('MUST-4.11: seasonalReference', () => {
  it('reads the 12 months ending at the reference month and reports that month separately', () => {
    const { db, spend } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    spend({ categoryId: groceries, amountCents: -60000, date: '2025-08-10' }); // month A
    spend({ categoryId: groceries, amountCents: -12000, date: '2024-09-10' }); // first month of the reference year
    spend({ categoryId: groceries, amountCents: -1000, date: '2024-08-10' }); // outside it

    const reference = seasonalReference({ targetMonth: '2026-08', scope: 'household', userId: null }).get(groceries);
    expect(reference?.twelveMonths).toHaveLength(12);
    expect(reference?.monthCents).toBe(60000);
    expect(reference?.twelveMonths[0]).toBe(12000);
    expect(reference?.twelveMonths[11]).toBe(60000);
  });
});

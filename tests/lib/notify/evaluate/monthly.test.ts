import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { categoryIdByName, createSeededTestDb, insertTestAccount, insertTestUser, type TestDb } from '../../../helpers/db';
import { upsertBudget } from '@/lib/budgets';
import { saveEmailTarget, saveSmtp, setPref } from '@/lib/notify/config';
import { resetOutboxPumpForTests } from '@/lib/notify/outbox';
import { resetNotifySenderForTests, setNotifySenderForTests } from '@/lib/notify/send';
import { evaluateMonthBoundary } from '@/lib/notify/evaluate/monthly';

let t: TestDb;
let accountId: number;
let creatorId: number;
const TZ = 'UTC';

beforeEach(() => {
  t = createSeededTestDb();
  accountId = insertTestAccount(t.db);
  creatorId = insertTestUser(t.db, { username: 'creator' });
  resetOutboxPumpForTests();
  setNotifySenderForTests(async () => {});
});

afterEach(() => {
  resetNotifySenderForTests();
  resetOutboxPumpForTests();
  t.cleanup();
});

function optedInUser(): number {
  const userId = insertTestUser(t.db, { username: `u${Math.random().toString(36).slice(2, 8)}` });
  saveSmtp({
    preset: 'brevo',
    host: 'h',
    port: 587,
    security: 'starttls',
    username: 'u',
    password: 'p',
    fromEmail: 'f@e.com',
    fromName: 'Budget Tracker',
    enabled: true,
  });
  saveEmailTarget({ userId, destination: 'sam@example.com', enabled: true });
  // Both month events are default-off (MUST-9.2); every test here wants them on.
  setPref(userId, 'predicted_vs_actual', 'email', true);
  setPref(userId, 'suggested_budget_refresh', 'email', true);
  return userId;
}

function spend(categoryId: number, cents: number, date: string): void {
  t.db.run(
    sql`insert into transactions
          (account_id, date, amount_cents, raw_description, normalized_merchant, category_id,
           attributed_user_id, is_transfer, dedup_hash, created_by, created_at, updated_at)
        values (${accountId}, ${date}, ${-cents}, ${'MERCHANT'}, ${'merchant'}, ${categoryId},
                null, 0, ${`h${Math.random()}`}, ${creatorId}, ${'2026-01-01T00:00:00.000Z'}, ${'2026-01-01T00:00:00.000Z'})`,
  );
}

/**
 * Six flat months of $600 groceries ending 2026-06, then a $713.40 July. Evaluated on the
 * first days of August: the reported month M is 2026-07, whose reference window is
 * 2026-01 .. 2026-06.
 *
 * Groceries is a CHILD of Food in the seed, so two rows carry this series: Groceries itself
 * and Food, which rolls it up. Both get a suggestion, and every count below says two.
 */
function seedHistory(): { groceries: number; food: number } {
  const groceries = categoryIdByName(t.db, 'Groceries');
  const food = categoryIdByName(t.db, 'Food');
  for (const month of ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06']) {
    spend(groceries, 60000, `${month}-10`);
  }
  spend(groceries, 71340, '2026-07-10');
  return { groceries, food };
}

function keys(): string[] {
  return (t.sqlite.prepare('select dedup_key from notification_outbox order by id').all() as { dedup_key: string }[]).map(
    (r) => r.dedup_key,
  );
}

describe('MUST-9.26 and MUST-9.31: the three-day window', () => {
  it('fires on day 1, 2 and 3 and not on day 4', () => {
    const userId = optedInUser();
    seedHistory();
    for (const day of ['01', '02', '03']) {
      resetOutboxPumpForTests();
      t.db.run(sql`delete from notification_outbox`);
      expect(evaluateMonthBoundary({ userId, now: new Date(`2026-08-${day}T09:00:00Z`), tz: TZ })).toBeGreaterThan(0);
    }
    t.db.run(sql`delete from notification_outbox`);
    expect(evaluateMonthBoundary({ userId, now: new Date('2026-08-04T09:00:00Z'), tz: TZ })).toBe(0);
    expect(keys()).toEqual([]);
  });

  it('MUST-9.29 and MUST-9.32: each fires exactly once across all three days', () => {
    const userId = optedInUser();
    seedHistory();
    let total = 0;
    for (const day of ['01', '02', '03']) {
      total += evaluateMonthBoundary({ userId, now: new Date(`2026-08-${day}T09:00:00Z`), tz: TZ });
    }
    expect(total).toBe(2);
    expect(keys().sort()).toEqual(['predvs:2026-07', 'suggest:2026-08']);
  });
});

describe('MUST-9.27: predicted is recomputed, not recalled', () => {
  it('compares July actual against the suggestion the six months before it point at', () => {
    const userId = optedInUser();
    seedHistory();
    setPref(userId, 'suggested_budget_refresh', 'email', false);

    expect(evaluateMonthBoundary({ userId, now: new Date('2026-08-01T09:00:00Z'), tz: TZ })).toBe(1);
    const body = (t.sqlite.prepare('select body from notification_outbox limit 1').get() as { body: string }).body;
    expect(body).toContain('$600.00 expected');
    expect(body).toContain('$713.40 actual');
    expect(body).toContain('recomputed');
    // Groceries and Food both carry the series, so both are lines and the total is doubled.
    expect(body).toContain('$226.80 over');
  });
});

describe('MUST-9.31: suggested_budget_refresh needs both thresholds cleared', () => {
  it('does not fire when every suggestion sits close to its resolved limit', () => {
    const userId = optedInUser();
    const { groceries, food } = seedHistory();
    setPref(userId, 'predicted_vs_actual', 'email', false);
    // The August window is 2026-02 .. 2026-07: five months at $600 and one at $713.40. Its
    // median is $600.00 and its trend is flat (the $113.40 move is under the 10 percent
    // threshold), so the August suggestion is $600.00 for Groceries AND for Food, which rolls
    // the same series up. BOTH need a limit, or the one without fires on its own.
    for (const categoryId of [groceries, food]) {
      upsertBudget({ scope: 'household', userId: null, categoryId, month: '2026-01', amountCents: 60000 });
    }
    expect(evaluateMonthBoundary({ userId, now: new Date('2026-08-01T09:00:00Z'), tz: TZ })).toBe(0);
    expect(keys()).toEqual([]);
  });

  it('fires when a category has a suggestion and no resolved limit at all', () => {
    const userId = optedInUser();
    seedHistory();
    setPref(userId, 'predicted_vs_actual', 'email', false);
    expect(evaluateMonthBoundary({ userId, now: new Date('2026-08-01T09:00:00Z'), tz: TZ })).toBe(1);
    expect(keys()).toEqual(['suggest:2026-08']);
    const subject = (t.sqlite.prepare('select subject from notification_outbox limit 1').get() as { subject: string }).subject;
    // Groceries and its parent Food, both with no limit set.
    expect(subject).toBe('New month: 2 suggested budgets changed');
  });

  it('MUST-9.33: the body says nothing has been changed, and nothing has', () => {
    const userId = optedInUser();
    seedHistory();
    setPref(userId, 'predicted_vs_actual', 'email', false);
    evaluateMonthBoundary({ userId, now: new Date('2026-08-01T09:00:00Z'), tz: TZ });
    const body = (t.sqlite.prepare('select body from notification_outbox limit 1').get() as { body: string }).body;
    expect(body).toContain('Nothing has been changed.');
    const written = t.sqlite.prepare('select count(*) as n from budgets').get() as { n: number };
    expect(written.n).toBe(0);
  });
});

describe('MUST-9.26: nothing to report means nothing sent', () => {
  it('is silent on a household with no computable suggestion', () => {
    const userId = optedInUser();
    expect(evaluateMonthBoundary({ userId, now: new Date('2026-08-01T09:00:00Z'), tz: TZ })).toBe(0);
    expect(keys()).toEqual([]);
  });
});

/**
 * Controller-ruled carry from Task 6's review: MUST-9.30's eight-line cap belongs to the
 * evaluator, not the renderer (renderEvent renders every row it is handed with no truncation
 * of its own). This pins that the cap is real: nine categories qualify for a line, and the
 * one with the smallest absolute difference between actual and expected is the one dropped.
 *
 * Four leaf/parent pairs (Groceries+Food, Gas+Transport, Clothing+Shopping, Pharmacy+Health)
 * each carry one series, so each pair contributes two rows with an IDENTICAL delta (the
 * parent rolls up its only spending child). That is eight rows at four distinct deltas: $90,
 * $70, $50 and $30. A ninth row, Kids (no children, spent on directly), carries a $10 delta,
 * the smallest of the nine. All nine have a flat $100/month history, so every suggestion is
 * exactly $100.00 and every difference is exactly the July overspend configured below.
 */
describe('MUST-9.30: the eight-line cap picks the largest absolute deltas', () => {
  it('drops the ninth category, whose delta is the smallest, and keeps the other eight', () => {
    const userId = optedInUser();
    setPref(userId, 'suggested_budget_refresh', 'email', false);

    const pairs: { leaf: string; julyCents: number }[] = [
      { leaf: 'Groceries', julyCents: 19000 }, // $90 over $100
      { leaf: 'Gas', julyCents: 17000 }, // $70 over
      { leaf: 'Clothing', julyCents: 15000 }, // $50 over
      { leaf: 'Pharmacy', julyCents: 13000 }, // $30 over
    ];
    for (const { leaf, julyCents } of pairs) {
      const categoryId = categoryIdByName(t.db, leaf);
      for (const month of ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06']) {
        spend(categoryId, 10000, `${month}-10`);
      }
      spend(categoryId, julyCents, '2026-07-10');
    }

    const kids = categoryIdByName(t.db, 'Kids');
    for (const month of ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06']) {
      spend(kids, 10000, `${month}-10`);
    }
    spend(kids, 11000, '2026-07-10'); // $10 over: the smallest of the nine

    expect(evaluateMonthBoundary({ userId, now: new Date('2026-08-01T09:00:00Z'), tz: TZ })).toBe(1);
    const body = (t.sqlite.prepare('select body from notification_outbox limit 1').get() as { body: string }).body;

    expect(body).toContain('$100.00 expected, $190.00 actual, $90.00 difference');
    expect(body).toContain('$100.00 expected, $170.00 actual, $70.00 difference');
    expect(body).toContain('$100.00 expected, $150.00 actual, $50.00 difference');
    expect(body).toContain('$100.00 expected, $130.00 actual, $30.00 difference');
    // Kids' $10.00 difference is the smallest of the nine and is the one line dropped.
    expect(body).not.toContain('$100.00 expected, $110.00 actual, $10.00 difference');

    const lineCount = (body.match(/ expected, /g) ?? []).length;
    expect(lineCount).toBe(8);
  });
});

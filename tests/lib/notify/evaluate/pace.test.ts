import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { categoryIdByName, createSeededTestDb, insertTestAccount, insertTestUser, type TestDb } from '../../../helpers/db';
import { upsertBudget } from '@/lib/budgets';
import { saveEmailTarget, saveSmtp, setPref } from '@/lib/notify/config';
import { resetOutboxPumpForTests } from '@/lib/notify/outbox';
import { resetNotifySenderForTests, setNotifySenderForTests } from '@/lib/notify/send';
import { evaluateBudgetPace } from '@/lib/notify/evaluate/pace';

let t: TestDb;
let accountId: number;
let creatorId: number;
const TZ = 'UTC';
/** The 12th of a 31-day month, so the projection multiplier is 31/12. */
const NOW = new Date('2026-08-12T12:00:00Z');

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

function emailUser(): number {
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
  return userId;
}

function spend(categoryId: number, cents: number, attributedUserId: number | null = null, date = '2026-08-05'): void {
  t.db.run(
    sql`insert into transactions
          (account_id, date, amount_cents, raw_description, normalized_merchant, category_id,
           attributed_user_id, is_transfer, dedup_hash, created_by, created_at, updated_at)
        values (${accountId}, ${date}, ${-cents}, ${'MERCHANT'}, ${'merchant'}, ${categoryId},
                ${attributedUserId}, 0, ${`h${Math.random()}`}, ${creatorId}, ${'2026-08-05T00:00:00.000Z'}, ${'2026-08-05T00:00:00.000Z'})`,
  );
}

function keys(): string[] {
  return (t.sqlite.prepare('select dedup_key from notification_outbox order by id').all() as { dedup_key: string }[]).map(
    (r) => r.dedup_key,
  );
}

describe('MUST-9.6: the four trigger conditions', () => {
  it('fires at a projected 110 percent and stays silent at 105', () => {
    const userId = emailUser();
    const groceries = categoryIdByName(t.db, 'Groceries');
    // 31/12 of the spend is the projection. A $600 limit needs $660 projected, so $255.49 spent.
    upsertBudget({ scope: 'household', userId: null, categoryId: groceries, month: '2026-08', amountCents: 60000 });

    spend(groceries, 24000); // projects to 62000, which is 103 percent
    expect(evaluateBudgetPace({ userId, now: NOW, tz: TZ })).toBe(0);

    spend(groceries, 2000); // 26000 total, projects to 67167, which is 111 percent
    expect(evaluateBudgetPace({ userId, now: NOW, tz: TZ })).toBe(1);
    expect(keys()).toEqual([`pace:h:${groceries}:2026-08`]);
  });

  it('does not fire before the seventh', () => {
    const userId = emailUser();
    const groceries = categoryIdByName(t.db, 'Groceries');
    upsertBudget({ scope: 'household', userId: null, categoryId: groceries, month: '2026-08', amountCents: 60000 });
    spend(groceries, 50000, null, '2026-08-01');
    expect(evaluateBudgetPace({ userId, now: new Date('2026-08-06T12:00:00Z'), tz: TZ })).toBe(0);
    expect(keys()).toEqual([]);
  });

  it('MUST-9.6 condition 3: stands down once the budget is already blown', () => {
    const userId = emailUser();
    const groceries = categoryIdByName(t.db, 'Groceries');
    upsertBudget({ scope: 'household', userId: null, categoryId: groceries, month: '2026-08', amountCents: 60000 });
    spend(groceries, 70000);
    expect(evaluateBudgetPace({ userId, now: NOW, tz: TZ })).toBe(0);
    expect(keys()).toEqual([]);
  });

  it('MUST-9.6 condition 2: a zero limit is budget_exceeded business, not a projection', () => {
    const userId = emailUser();
    const groceries = categoryIdByName(t.db, 'Groceries');
    upsertBudget({ scope: 'household', userId: null, categoryId: groceries, month: '2026-08', amountCents: 0 });
    spend(groceries, 100);
    expect(evaluateBudgetPace({ userId, now: NOW, tz: TZ })).toBe(0);
  });

  it('does not fire for a category with no limit at all', () => {
    const userId = emailUser();
    const groceries = categoryIdByName(t.db, 'Groceries');
    spend(groceries, 90000);
    expect(evaluateBudgetPace({ userId, now: NOW, tz: TZ })).toBe(0);
  });
});

describe('MUST-9.8: once per scope, per category, per month, ever', () => {
  it('stays silent across ten consecutive daily evaluations after the first', () => {
    const userId = emailUser();
    const groceries = categoryIdByName(t.db, 'Groceries');
    upsertBudget({ scope: 'household', userId: null, categoryId: groceries, month: '2026-08', amountCents: 60000 });
    spend(groceries, 26000);

    expect(evaluateBudgetPace({ userId, now: NOW, tz: TZ })).toBe(1);
    for (let day = 13; day <= 22; day += 1) {
      const at = new Date(`2026-08-${day}T12:00:00Z`);
      expect(evaluateBudgetPace({ userId, now: at, tz: TZ })).toBe(0);
    }
    expect(keys()).toEqual([`pace:h:${groceries}:2026-08`]);
  });
});

describe('MUST-9.35: household rows reach every enabled user, personal rows only their owner', () => {
  it('keys household and personal separately and delivers each to the right person', () => {
    const sam = emailUser();
    const alex = emailUser();
    const groceries = categoryIdByName(t.db, 'Groceries');
    upsertBudget({ scope: 'household', userId: null, categoryId: groceries, month: '2026-08', amountCents: 60000 });
    // Above the $260 spent so far, so MUST-9.6 condition 3 does not stand the personal row
    // down; the 31/12 projection of $671.67 still clears 110 percent of $300.
    upsertBudget({ scope: 'personal', userId: sam, categoryId: groceries, month: '2026-08', amountCents: 30000 });
    spend(groceries, 26000, sam);

    expect(evaluateBudgetPace({ userId: sam, now: NOW, tz: TZ })).toBe(2);
    expect(evaluateBudgetPace({ userId: alex, now: NOW, tz: TZ })).toBe(1);

    const rows = t.sqlite.prepare('select user_id, dedup_key from notification_outbox order by id').all() as {
      user_id: number;
      dedup_key: string;
    }[];
    expect(rows.filter((row) => row.dedup_key === `pace:p:${groceries}:2026-08`).map((row) => row.user_id)).toEqual([sam]);
    expect(rows.filter((row) => row.dedup_key === `pace:h:${groceries}:2026-08`).map((row) => row.user_id).sort()).toEqual(
      [sam, alex].sort(),
    );
  });
});

/**
 * MEDIUM fix (final-fix-wave item 3): PACE_MAX_PER_EVALUATION caps this detector the same way
 * the three anomaly detectors already cap themselves. Twelve leaf categories, each with a
 * $100.00 limit and a distinct spend so every overshoot is a distinct value, all qualify; only
 * the five worst should ever be enqueued.
 */
describe('MEDIUM fix: PACE_MAX_PER_EVALUATION caps the detector at its five largest overshoots', () => {
  it('12 qualifying categories produce exactly 5 messages, the 5 with the largest overshoot', () => {
    const userId = emailUser();
    // Twelve distinct leaf categories from the seed tree (Food x3, Transport x6, Shopping x3),
    // none sharing a parent budget, so only these 12 rows are pace candidates.
    const leaves = [
      'Groceries',
      'Restaurants',
      'Coffee',
      'Gas',
      'Car Payment',
      'Car Insurance',
      'Maintenance',
      'Transit',
      'Parking',
      'Clothing',
      'Electronics',
      'General',
    ];
    // Descending spend, 500 cents apart, so every projected overshoot is distinct: 10000 down
    // to 4500 in 12 steps. All 12 clear the 110 percent floor at day 12 of a 31-day month
    // (even the smallest, 4500, projects to 11625 against a 11000 floor).
    const spentByLeaf = new Map(leaves.map((name, index) => [name, 10000 - index * 500]));

    const ids = new Map(leaves.map((name) => [name, categoryIdByName(t.db, name)]));
    for (const name of leaves) {
      const categoryId = ids.get(name)!;
      upsertBudget({ scope: 'household', userId: null, categoryId, month: '2026-08', amountCents: 10000 });
      spend(categoryId, spentByLeaf.get(name)!);
    }

    expect(evaluateBudgetPace({ userId, now: NOW, tz: TZ })).toBe(5);

    // The 5 largest spends (and therefore the 5 largest overshoots) are the first 5 in the
    // descending list: Groceries, Restaurants, Coffee, Gas, Car Payment.
    const expectedFired = ['Groceries', 'Restaurants', 'Coffee', 'Gas', 'Car Payment'];
    const expectedSkipped = leaves.filter((name) => !expectedFired.includes(name));

    const fired = keys();
    for (const name of expectedFired) {
      expect(fired).toContain(`pace:h:${ids.get(name)}:2026-08`);
    }
    for (const name of expectedSkipped) {
      expect(fired).not.toContain(`pace:h:${ids.get(name)}:2026-08`);
    }
    expect(fired.length).toBe(5);
  });
});

describe('notify MUST-4.2: a user with the event switched off hears nothing', () => {
  it('enqueues no row when every channel is off for budget_pace', () => {
    const userId = emailUser();
    setPref(userId, 'budget_pace', 'email', false);
    setPref(userId, 'budget_pace', 'telegram', false);
    const groceries = categoryIdByName(t.db, 'Groceries');
    upsertBudget({ scope: 'household', userId: null, categoryId: groceries, month: '2026-08', amountCents: 60000 });
    spend(groceries, 26000);
    expect(evaluateBudgetPace({ userId, now: NOW, tz: TZ })).toBe(0);
    expect(keys()).toEqual([]);
  });
});

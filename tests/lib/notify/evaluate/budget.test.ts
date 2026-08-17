import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { categoryIdByName, createSeededTestDb, insertTestAccount, insertTestUser, type TestDb } from '../../../helpers/db';
import { upsertBudget } from '@/lib/budgets';
import { DEFAULT_USER_SETTINGS, saveEmailTarget, saveSmtp, saveUserSettings, setPref } from '@/lib/notify/config';
import { resetOutboxPumpForTests } from '@/lib/notify/outbox';
import { resetNotifySenderForTests, setNotifySenderForTests } from '@/lib/notify/send';
import { evaluateBudgets, resetBudgetFingerprintForTests } from '@/lib/notify/evaluate/budget';

let t: TestDb;
let accountId: number;
let creatorId: number;
const TZ = 'UTC';
const NOW = new Date('2026-08-17T12:00:00Z');

beforeEach(() => {
  t = createSeededTestDb();
  accountId = insertTestAccount(t.db);
  // A fixed FK target for transactions.created_by (NOT NULL) — independent of
  // notification attribution, which each test controls via emailUser()/spend().
  creatorId = insertTestUser(t.db, { username: 'creator' });
  resetOutboxPumpForTests();
  resetBudgetFingerprintForTests();
  setNotifySenderForTests(async () => {});
});

afterEach(() => {
  resetNotifySenderForTests();
  resetOutboxPumpForTests();
  resetBudgetFingerprintForTests();
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
  // budget_threshold is default-off (MUST-4.1); every test here wants it on.
  setPref(userId, 'budget_threshold', 'email', true);
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

describe('MUST-6.16: the thresholds', () => {
  it('is silent at 79%, fires the threshold at 80%, and fires exceeded past 100%', () => {
    const userId = emailUser();
    const groceries = categoryIdByName(t.db, 'Groceries');
    upsertBudget({ scope: 'household', userId: null, categoryId: groceries, month: '2026-08', amountCents: 50000 });

    spend(groceries, 39500); // 79%
    expect(evaluateBudgets({ now: NOW, tz: TZ })).toBe(0);

    resetBudgetFingerprintForTests();
    spend(groceries, 500); // 80%
    expect(evaluateBudgets({ now: NOW, tz: TZ })).toBe(1);
    expect(keys()).toEqual([`budget:h:${groceries}:2026-08:80`]);

    resetBudgetFingerprintForTests();
    spend(groceries, 15000); // 110%
    expect(evaluateBudgets({ now: NOW, tz: TZ })).toBe(1);
    expect(keys()).toContain(`budget:h:${groceries}:2026-08:100`);
  });

  it('MUST-6.17: a single import that jumps from under the threshold to over 100% fires both', () => {
    const userId = emailUser();
    const gas = categoryIdByName(t.db, 'Gas');
    upsertBudget({ scope: 'household', userId: null, categoryId: gas, month: '2026-08', amountCents: 10000 });
    spend(gas, 20000);
    expect(evaluateBudgets({ now: NOW, tz: TZ })).toBe(2);
    expect(keys().sort()).toEqual([`budget:h:${gas}:2026-08:100`, `budget:h:${gas}:2026-08:80`]);
  });

  it('does not re-fire the same category in the same month', () => {
    const userId = emailUser();
    const gas = categoryIdByName(t.db, 'Gas');
    upsertBudget({ scope: 'household', userId: null, categoryId: gas, month: '2026-08', amountCents: 10000 });
    spend(gas, 9000);
    expect(evaluateBudgets({ now: NOW, tz: TZ })).toBe(1);
    resetBudgetFingerprintForTests();
    spend(gas, 100);
    expect(evaluateBudgets({ now: NOW, tz: TZ })).toBe(0);
  });

  it('raising the threshold mid-month fires again at the new number', () => {
    const userId = emailUser();
    const gas = categoryIdByName(t.db, 'Gas');
    upsertBudget({ scope: 'household', userId: null, categoryId: gas, month: '2026-08', amountCents: 10000 });
    spend(gas, 9500);
    evaluateBudgets({ now: NOW, tz: TZ });
    expect(keys()).toEqual([`budget:h:${gas}:2026-08:80`]);
    saveUserSettings(userId, { ...DEFAULT_USER_SETTINGS, budgetThresholdPct: 90 });
    expect(evaluateBudgets({ now: NOW, tz: TZ })).toBe(1);
    expect(keys()).toContain(`budget:h:${gas}:2026-08:90`);
  });

  it('an unbudgeted category never fires', () => {
    emailUser();
    spend(categoryIdByName(t.db, 'Gas'), 999999);
    expect(evaluateBudgets({ now: NOW, tz: TZ })).toBe(0);
  });
});

describe('MUST-6.15: household and personal scopes are independent facts', () => {
  it('the same category can fire once for each scope', () => {
    const userId = emailUser();
    const coffee = categoryIdByName(t.db, 'Coffee');
    // Household budget is deliberately below the spend too, so BOTH scopes cross their
    // threshold AND their limit independently — the point of this test.
    upsertBudget({ scope: 'household', userId: null, categoryId: coffee, month: '2026-08', amountCents: 8000 });
    upsertBudget({ scope: 'personal', userId, categoryId: coffee, month: '2026-08', amountCents: 5000 });
    spend(coffee, 9000, userId);
    evaluateBudgets({ now: NOW, tz: TZ });
    expect(keys().sort()).toEqual(
      [`budget:h:${coffee}:2026-08:100`, `budget:h:${coffee}:2026-08:80`, `budget:p:${coffee}:2026-08:100`, `budget:p:${coffee}:2026-08:80`].sort(),
    );
  });

  it('a personal budget only reaches its own owner', () => {
    const mine = emailUser();
    const theirs = emailUser();
    const coffee = categoryIdByName(t.db, 'Coffee');
    upsertBudget({ scope: 'personal', userId: mine, categoryId: coffee, month: '2026-08', amountCents: 5000 });
    spend(coffee, 9000, mine);
    evaluateBudgets({ now: NOW, tz: TZ });
    const rows = t.sqlite.prepare('select distinct user_id from notification_outbox').all() as { user_id: number }[];
    expect(rows.map((r) => r.user_id)).toEqual([mine]);
    expect(theirs).toBeGreaterThan(0);
  });

  it('a household budget reaches every user with the event enabled', () => {
    const a = emailUser();
    const b = emailUser();
    const gas = categoryIdByName(t.db, 'Gas');
    upsertBudget({ scope: 'household', userId: null, categoryId: gas, month: '2026-08', amountCents: 10000 });
    spend(gas, 20000);
    evaluateBudgets({ now: NOW, tz: TZ });
    const owners = new Set(
      (t.sqlite.prepare('select user_id from notification_outbox').all() as { user_id: number }[]).map((r) => r.user_id),
    );
    expect([...owners].sort()).toEqual([a, b].sort());
  });
});

describe('MUST-6.18: the fingerprint guard', () => {
  it('skips a second tick when nothing has changed', () => {
    const userId = emailUser();
    const gas = categoryIdByName(t.db, 'Gas');
    upsertBudget({ scope: 'household', userId: null, categoryId: gas, month: '2026-08', amountCents: 10000 });
    spend(gas, 20000);
    expect(evaluateBudgets({ now: NOW, tz: TZ })).toBe(2);
    // Second tick with no data change: no work at all, and nothing new enqueued.
    expect(evaluateBudgets({ now: NOW, tz: TZ })).toBe(0);
    expect(keys()).toHaveLength(2);
  });

  it('does NOT skip after a re-categorisation (max(updated_at) moved)', () => {
    const userId = emailUser();
    const gas = categoryIdByName(t.db, 'Gas');
    const coffee = categoryIdByName(t.db, 'Coffee');
    upsertBudget({ scope: 'household', userId: null, categoryId: coffee, month: '2026-08', amountCents: 10000 });
    spend(gas, 20000);
    evaluateBudgets({ now: NOW, tz: TZ });
    expect(keys()).toEqual([]);
    t.db.run(sql`update transactions set category_id = ${coffee}, updated_at = ${'2026-08-17T11:59:00.000Z'}`);
    expect(evaluateBudgets({ now: NOW, tz: TZ })).toBe(2);
  });

  it('does NOT skip after a new user enables the event', () => {
    const a = emailUser();
    const gas = categoryIdByName(t.db, 'Gas');
    upsertBudget({ scope: 'household', userId: null, categoryId: gas, month: '2026-08', amountCents: 10000 });
    spend(gas, 20000);
    evaluateBudgets({ now: NOW, tz: TZ });
    const b = emailUser();
    expect(evaluateBudgets({ now: NOW, tz: TZ })).toBe(2);
    expect(b).toBeGreaterThan(a);
  });

  it('does NOT skip after a threshold change', () => {
    const userId = emailUser();
    const gas = categoryIdByName(t.db, 'Gas');
    upsertBudget({ scope: 'household', userId: null, categoryId: gas, month: '2026-08', amountCents: 10000 });
    spend(gas, 8500);
    evaluateBudgets({ now: NOW, tz: TZ });
    saveUserSettings(userId, { ...DEFAULT_USER_SETTINGS, budgetThresholdPct: 90 });
    expect(evaluateBudgets({ now: NOW, tz: TZ })).toBe(0); // 85% is below the new 90
    saveUserSettings(userId, { ...DEFAULT_USER_SETTINGS, budgetThresholdPct: 84 });
    expect(evaluateBudgets({ now: NOW, tz: TZ })).toBe(1);
  });
});

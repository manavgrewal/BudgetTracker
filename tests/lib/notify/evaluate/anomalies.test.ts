import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { categoryIdByName, createSeededTestDb, insertTestAccount, insertTestUser, type TestDb } from '../../../helpers/db';
import { saveEmailTarget, saveSmtp, setPref } from '@/lib/notify/config';
import { resetOutboxPumpForTests } from '@/lib/notify/outbox';
import { resetNotifySenderForTests, setNotifySenderForTests } from '@/lib/notify/send';
import { evaluateAnomalies, evaluateSubscriptionCreep, resetAnomalyFingerprintForTests } from '@/lib/notify/evaluate/anomalies';

let t: TestDb;
let accountId: number;
let creatorId: number;
const TZ = 'UTC';
const NOW = new Date('2026-08-18T12:00:00Z');

beforeEach(() => {
  t = createSeededTestDb();
  accountId = insertTestAccount(t.db, { name: 'Joint Chequing' });
  creatorId = insertTestUser(t.db, { username: 'creator' });
  resetOutboxPumpForTests();
  resetAnomalyFingerprintForTests();
  setNotifySenderForTests(async () => {});
});

afterEach(() => {
  resetNotifySenderForTests();
  resetOutboxPumpForTests();
  resetAnomalyFingerprintForTests();
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

function charge(over: { merchant: string; cents: number; date: string; categoryId?: number | null }): number {
  const row = t.db.get<{ id: number }>(
    sql`insert into transactions
          (account_id, date, amount_cents, raw_description, normalized_merchant, category_id,
           attributed_user_id, is_transfer, dedup_hash, created_by, created_at, updated_at)
        values (${accountId}, ${over.date}, ${-over.cents}, ${over.merchant}, ${over.merchant}, ${over.categoryId ?? null},
                null, 0, ${`h${Math.random()}`}, ${creatorId}, ${'2026-08-01T00:00:00.000Z'}, ${'2026-08-01T00:00:00.000Z'})
        returning id`,
  );
  return row.id;
}

function keys(): string[] {
  return (t.sqlite.prepare('select dedup_key from notification_outbox order by id').all() as { dedup_key: string }[]).map(
    (r) => r.dedup_key,
  );
}

/** 60+ days of household history, so MUST-9.10 condition 1 is satisfied. */
function seedHistory(): void {
  charge({ merchant: 'ANCHOR', cents: 100, date: '2026-01-01' });
}

/**
 * `count` same-merchant samples at $120, all outside the 14-day candidate window.
 *
 * The count matters: unusualVerdict takes the median of the OTHER rows for that merchant, so a
 * test that plants many outliers needs enough $120 rows to keep that median at $120.
 */
function seedMerchantBaseline(merchant: string, categoryId: number, count = 5): void {
  for (let index = 0; index < count; index += 1) {
    const day = String((index % 28) + 1).padStart(2, '0');
    const month = String((index % 5) + 2).padStart(2, '0');
    charge({ merchant, cents: 12000, date: `2026-${month}-${day}`, categoryId });
  }
}

describe('MUST-9.10: unusual_transaction end to end', () => {
  it('fires once for a charge three times the merchant baseline', () => {
    emailUser();
    seedHistory();
    const groceries = categoryIdByName(t.db, 'Groceries');
    seedMerchantBaseline('CANADIAN TIRE', groceries);
    const outlier = charge({ merchant: 'CANADIAN TIRE', cents: 41288, date: '2026-08-14', categoryId: groceries });

    expect(evaluateAnomalies({ now: NOW, tz: TZ })).toBe(1);
    expect(keys()).toEqual([`unusual:${outlier}`]);
  });

  it('R2: nothing fires at all on a household with under 60 days of history', () => {
    // evaluateAnomalies takes no user, so the user is set up for its side effect only.
    emailUser();
    const groceries = categoryIdByName(t.db, 'Groceries');
    for (const date of ['2026-08-01', '2026-08-02', '2026-08-03', '2026-08-04', '2026-08-05']) {
      charge({ merchant: 'CANADIAN TIRE', cents: 12000, date, categoryId: groceries });
    }
    charge({ merchant: 'CANADIAN TIRE', cents: 41288, date: '2026-08-14', categoryId: groceries });
    expect(evaluateAnomalies({ now: NOW, tz: TZ })).toBe(0);
    expect(keys()).toEqual([]);
  });

  it('MUST-9.13: the cap holds at five with twelve candidates, oldest first', () => {
    emailUser();
    seedHistory();
    const groceries = categoryIdByName(t.db, 'Groceries');
    // Twenty baseline rows against twelve outliers keeps the merchant median at $120.
    seedMerchantBaseline('BIG SHOP', groceries, 20);
    const ids: number[] = [];
    for (let day = 6; day <= 17; day += 1) {
      // Amounts differ by a cent each so the duplicate detector, which needs the EXACT same
      // amount, stays out of this test's count.
      ids.push(
        charge({ merchant: 'BIG SHOP', cents: 90000 + day, date: `2026-08-${String(day).padStart(2, '0')}`, categoryId: groceries }),
      );
    }
    expect(evaluateAnomalies({ now: NOW, tz: TZ })).toBe(5);
    expect(keys()).toEqual(ids.slice(0, 5).map((id) => `unusual:${id}`));
  });

  it('MUST-9.36: the same charge reaches every user with the event enabled', () => {
    const sam = emailUser();
    const alex = emailUser();
    seedHistory();
    const groceries = categoryIdByName(t.db, 'Groceries');
    seedMerchantBaseline('CANADIAN TIRE', groceries);
    const outlier = charge({ merchant: 'CANADIAN TIRE', cents: 41288, date: '2026-08-14', categoryId: groceries });

    expect(evaluateAnomalies({ now: NOW, tz: TZ })).toBe(2);
    const rows = t.sqlite.prepare('select user_id from notification_outbox where dedup_key = ?').all(`unusual:${outlier}`) as {
      user_id: number;
    }[];
    expect(rows.map((row) => row.user_id).sort()).toEqual([sam, alex].sort());
  });
});

describe('MUST-10.4 to MUST-10.6: the tick fingerprint', () => {
  it('short-circuits a second evaluation with no data change', () => {
    emailUser();
    seedHistory();
    const groceries = categoryIdByName(t.db, 'Groceries');
    seedMerchantBaseline('CANADIAN TIRE', groceries);
    charge({ merchant: 'CANADIAN TIRE', cents: 41288, date: '2026-08-14', categoryId: groceries });

    expect(evaluateAnomalies({ now: NOW, tz: TZ })).toBe(1);
    expect(evaluateAnomalies({ now: NOW, tz: TZ })).toBe(0);
    expect(keys()).toHaveLength(1);
  });

  it('MUST-10.5: re-categorising an existing row changes the fingerprint', () => {
    emailUser();
    seedHistory();
    const groceries = categoryIdByName(t.db, 'Groceries');
    seedMerchantBaseline('CANADIAN TIRE', groceries);
    const outlier = charge({ merchant: 'CANADIAN TIRE', cents: 41288, date: '2026-08-14', categoryId: groceries });
    expect(evaluateAnomalies({ now: NOW, tz: TZ })).toBe(1);

    t.db.run(sql`update transactions set updated_at = '2026-08-18T13:00:00.000Z' where id = ${outlier}`);
    // The key changed, so the pass runs again; enqueue() is idempotent, so nothing new lands.
    expect(evaluateAnomalies({ now: NOW, tz: TZ })).toBe(0);
    expect(keys()).toHaveLength(1);
  });

  it('MUST-10.10 and AC8: zero participants means zero work and no burned fingerprint', () => {
    const userId = emailUser();
    setPref(userId, 'unusual_transaction', 'email', false);
    setPref(userId, 'unusual_transaction', 'telegram', false);
    setPref(userId, 'duplicate_charge', 'email', false);
    setPref(userId, 'duplicate_charge', 'telegram', false);
    seedHistory();
    const groceries = categoryIdByName(t.db, 'Groceries');
    seedMerchantBaseline('CANADIAN TIRE', groceries);
    charge({ merchant: 'CANADIAN TIRE', cents: 41288, date: '2026-08-14', categoryId: groceries });

    for (let tick = 0; tick < 12; tick += 1) expect(evaluateAnomalies({ now: NOW, tz: TZ })).toBe(0);
    expect(keys()).toEqual([]);
  });
});

describe('MUST-9.20 to MUST-9.24: duplicate_charge end to end', () => {
  it('fires once per pair and says the wording MUST-14.10 requires', () => {
    emailUser();
    seedHistory();
    const first = charge({ merchant: 'BELL CANADA', cents: 8950, date: '2026-08-12' });
    const second = charge({ merchant: 'BELL CANADA', cents: 8950, date: '2026-08-13' });

    expect(evaluateAnomalies({ now: NOW, tz: TZ })).toBe(1);
    expect(keys()).toEqual([`dupe:${first}:${second}`]);
    const body = (t.sqlite.prepare('select body from notification_outbox limit 1').get() as { body: string }).body;
    expect(body).toContain('It may be a real second charge, or the bank may have reported one charge twice.');
  });
});

describe('MUST-9.15 to MUST-9.19: subscription_creep on the daily slot', () => {
  it('fires once for a monthly subscription whose price went up', () => {
    const userId = emailUser();
    seedHistory();
    charge({ merchant: 'NETFLIX', cents: 1649, date: '2026-05-14' });
    charge({ merchant: 'NETFLIX', cents: 1649, date: '2026-06-14' });
    charge({ merchant: 'NETFLIX', cents: 1649, date: '2026-07-14' });
    const risen = charge({ merchant: 'NETFLIX', cents: 2099, date: '2026-08-14' });

    expect(evaluateSubscriptionCreep({ userId, now: NOW, tz: TZ })).toBe(1);
    expect(keys()).toEqual([`creep:${risen}`]);
    expect(evaluateSubscriptionCreep({ userId, now: NOW, tz: TZ })).toBe(0);
  });

  it('is silent for a merchant with no recurring rhythm', () => {
    const userId = emailUser();
    seedHistory();
    charge({ merchant: 'CAFE', cents: 500, date: '2026-08-11' });
    charge({ merchant: 'CAFE', cents: 500, date: '2026-08-12' });
    charge({ merchant: 'CAFE', cents: 500, date: '2026-08-13' });
    charge({ merchant: 'CAFE', cents: 900, date: '2026-08-14' });
    expect(evaluateSubscriptionCreep({ userId, now: NOW, tz: TZ })).toBe(0);
  });

  it('is silent for a user with the event switched off', () => {
    const userId = emailUser();
    setPref(userId, 'subscription_creep', 'email', false);
    setPref(userId, 'subscription_creep', 'telegram', false);
    seedHistory();
    charge({ merchant: 'NETFLIX', cents: 1649, date: '2026-05-14' });
    charge({ merchant: 'NETFLIX', cents: 1649, date: '2026-06-14' });
    charge({ merchant: 'NETFLIX', cents: 1649, date: '2026-07-14' });
    charge({ merchant: 'NETFLIX', cents: 2099, date: '2026-08-14' });
    expect(evaluateSubscriptionCreep({ userId, now: NOW, tz: TZ })).toBe(0);
  });
});

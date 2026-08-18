import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { categoryIdByName, createSeededTestDb, insertTestAccount, insertTestUser, type TestDb } from '../../../helpers/db';
import { addDaysIso, todayIso } from '@/lib/dates';
import { saveEmailTarget, saveSmtp, setPref } from '@/lib/notify/config';
import * as outboxModule from '@/lib/notify/outbox';
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

/**
 * Same shape as seedMerchantBaseline, but dated relative to `today` rather than to fixed 2026
 * calendar dates, so a floor-boundary test can plant a baseline that is guaranteed to be newer
 * than a deliberately-placed earliest-transaction anchor.
 */
function seedRecentBaseline(merchant: string, categoryId: number, today: string, count = 5): void {
  for (let index = 0; index < count; index += 1) {
    charge({ merchant, cents: 12000, date: addDaysIso(today, -(20 + index)), categoryId });
  }
}

/**
 * Wraps better-sqlite3's own prepare() -- the pattern of tests/lib/loans/matcher.test.ts and
 * tests/lib/predict/history.test.ts -- so a query-count assertion is a fact about what SQL
 * actually ran, not an inference from a return value. The return value alone cannot tell a
 * correctly-skipped evaluation apart from one that ran every query and happened to enqueue
 * nothing new: both report 0 fired.
 */
function countTransactionsQueries(run: () => void): number {
  const original = t.sqlite.prepare.bind(t.sqlite);
  let count = 0;
  const spy = vi.spyOn(t.sqlite, 'prepare').mockImplementation(((source: string) => {
    if (/\btransactions\b/.test(source)) count += 1;
    return original(source);
  }) as typeof t.sqlite.prepare);
  try {
    run();
  } finally {
    spy.mockRestore();
  }
  return count;
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

describe('MUST-9.10 condition 1: the 60-day household-history floor', () => {
  it('is silent at exactly 59 days of history', () => {
    emailUser();
    const groceries = categoryIdByName(t.db, 'Groceries');
    const today = todayIso(NOW, TZ);
    charge({ merchant: 'ANCHOR', cents: 100, date: addDaysIso(today, -59) });
    seedRecentBaseline('CANADIAN TIRE', groceries, today);
    charge({ merchant: 'CANADIAN TIRE', cents: 41288, date: addDaysIso(today, -4), categoryId: groceries });
    expect(evaluateAnomalies({ now: NOW, tz: TZ })).toBe(0);
  });

  it('fires at exactly 60 days of history', () => {
    emailUser();
    const groceries = categoryIdByName(t.db, 'Groceries');
    const today = todayIso(NOW, TZ);
    charge({ merchant: 'ANCHOR', cents: 100, date: addDaysIso(today, -60) });
    seedRecentBaseline('CANADIAN TIRE', groceries, today);
    const outlier = charge({ merchant: 'CANADIAN TIRE', cents: 41288, date: addDaysIso(today, -4), categoryId: groceries });
    expect(evaluateAnomalies({ now: NOW, tz: TZ })).toBe(1);
    expect(keys()).toEqual([`unusual:${outlier}`]);
  });
});

describe('MUST-9.13: the cap boundary', () => {
  it('fires all five when there are exactly five candidates', () => {
    emailUser();
    seedHistory();
    const groceries = categoryIdByName(t.db, 'Groceries');
    seedMerchantBaseline('BIG SHOP', groceries, 20);
    const ids: number[] = [];
    for (let day = 6; day <= 10; day += 1) {
      ids.push(
        charge({ merchant: 'BIG SHOP', cents: 90000 + day, date: `2026-08-${String(day).padStart(2, '0')}`, categoryId: groceries }),
      );
    }
    expect(evaluateAnomalies({ now: NOW, tz: TZ })).toBe(5);
    expect(keys()).toEqual(ids.map((id) => `unusual:${id}`));
  });

  it('fires all three when there are fewer than five candidates', () => {
    emailUser();
    seedHistory();
    const groceries = categoryIdByName(t.db, 'Groceries');
    seedMerchantBaseline('BIG SHOP', groceries, 20);
    const ids: number[] = [];
    for (let day = 6; day <= 8; day += 1) {
      ids.push(
        charge({ merchant: 'BIG SHOP', cents: 90000 + day, date: `2026-08-${String(day).padStart(2, '0')}`, categoryId: groceries }),
      );
    }
    expect(evaluateAnomalies({ now: NOW, tz: TZ })).toBe(3);
    expect(keys()).toEqual(ids.map((id) => `unusual:${id}`));
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

  it('a new transaction after a first evaluation fires on the next tick (count/maxId changed)', () => {
    emailUser();
    seedHistory();
    const groceries = categoryIdByName(t.db, 'Groceries');
    seedMerchantBaseline('CANADIAN TIRE', groceries);
    // Nothing unusual exists yet: this pass only establishes the fingerprint.
    expect(evaluateAnomalies({ now: NOW, tz: TZ })).toBe(0);

    const outlier = charge({ merchant: 'CANADIAN TIRE', cents: 41288, date: '2026-08-14', categoryId: groceries });
    // A genuinely new row moves both count and maxId, so this tick is not a repeat.
    expect(evaluateAnomalies({ now: NOW, tz: TZ })).toBe(1);
    expect(keys()).toEqual([`unusual:${outlier}`]);
  });

  it('MUST-10.5: re-categorising an existing row changes the fingerprint and flips the outcome from 0 to 1', () => {
    emailUser();
    seedHistory();
    const groceries = categoryIdByName(t.db, 'Groceries');
    // A category baseline of five, at a merchant DIFFERENT from the candidate below, so the
    // candidate has no merchant baseline of its own and can only qualify via the category.
    seedMerchantBaseline('CANADIAN TIRE', groceries);
    // Uncategorised: neither a merchant baseline (unique merchant) nor a category baseline
    // (no category at all) exists yet, so this cannot fire no matter how large it is.
    const candidate = charge({ merchant: 'NEW SHOP', cents: 41288, date: '2026-08-14', categoryId: null });
    expect(evaluateAnomalies({ now: NOW, tz: TZ })).toBe(0);

    // Re-categorising into groceries, which already has five same-category samples, unlocks
    // the category baseline. A mutant that ignores this update (a constant or otherwise broken
    // fingerprint) would incorrectly keep skipping and report 0 here instead of 1, which a bare
    // "returns 0 again" assertion could never distinguish from the correct skip-then-rerun.
    t.db.run(sql`update transactions set category_id = ${groceries}, updated_at = '2026-08-18T13:00:00.000Z' where id = ${candidate}`);
    expect(evaluateAnomalies({ now: NOW, tz: TZ })).toBe(1);
    expect(keys()).toEqual([`unusual:${candidate}`]);
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

  it('MUST-10.6: an error partway through the participant loop does not burn the fingerprint, so the next tick still evaluates', () => {
    const sam = emailUser();
    const alex = emailUser();
    seedHistory();
    const groceries = categoryIdByName(t.db, 'Groceries');
    seedMerchantBaseline('CANADIAN TIRE', groceries);
    charge({ merchant: 'CANADIAN TIRE', cents: 41288, date: '2026-08-14', categoryId: groceries });

    // sam has the lower user id and is processed first; alex's enqueue call is made to throw.
    expect(alex).toBeGreaterThan(sam);
    const realEnqueue = outboxModule.enqueue;
    let calls = 0;
    const spy = vi.spyOn(outboxModule, 'enqueue').mockImplementation((input) => {
      calls += 1;
      if (calls === 2) throw new Error('enqueue boom');
      return realEnqueue(input);
    });
    try {
      expect(() => evaluateAnomalies({ now: NOW, tz: TZ })).toThrow('enqueue boom');
    } finally {
      spy.mockRestore();
    }
    // Only sam's row landed before the throw killed the pass.
    expect(keys()).toHaveLength(1);

    // Nothing about the data changed between the two calls, but the fingerprint was never
    // recorded on the failed pass (MUST-10.6's post-loop placement, anomalies.ts's
    // `lastAnomalyKey = key` after the participant loop), so this tick re-evaluates instead of
    // short-circuiting, and alex finally receives the delivery the first pass never reached.
    expect(evaluateAnomalies({ now: NOW, tz: TZ })).toBe(1);
    expect(keys()).toHaveLength(2);
  });
});

describe('MUST-10.9 and AC8: statement counts prove the guard actually skips work', () => {
  it('an unchanged fingerprint performs exactly the one indexed count query and nothing else', () => {
    emailUser();
    seedHistory();
    const groceries = categoryIdByName(t.db, 'Groceries');
    seedMerchantBaseline('CANADIAN TIRE', groceries);
    charge({ merchant: 'CANADIAN TIRE', cents: 41288, date: '2026-08-14', categoryId: groceries });
    expect(evaluateAnomalies({ now: NOW, tz: TZ })).toBe(1);

    // MUST-10.9 promises this tick costs one indexed count query and nothing more: no slice
    // read, no baseline query. Counting actual prepared statements, rather than trusting the
    // return value, is what catches a mutant that deletes the short-circuit: that mutant also
    // happens to return 0 here (the finding is already enqueued) while still re-running every
    // query to get there.
    const transactionQueries = countTransactionsQueries(() => {
      expect(evaluateAnomalies({ now: NOW, tz: TZ })).toBe(0);
    });
    expect(transactionQueries).toBe(1);
  });

  it('AC8, verbatim: a zero-participant tick performs no transactions query at all', () => {
    const userId = emailUser();
    setPref(userId, 'unusual_transaction', 'email', false);
    setPref(userId, 'unusual_transaction', 'telegram', false);
    setPref(userId, 'duplicate_charge', 'email', false);
    setPref(userId, 'duplicate_charge', 'telegram', false);
    seedHistory();
    const groceries = categoryIdByName(t.db, 'Groceries');
    seedMerchantBaseline('CANADIAN TIRE', groceries);
    charge({ merchant: 'CANADIAN TIRE', cents: 41288, date: '2026-08-14', categoryId: groceries });

    // With no participant, the code returns before the fingerprint query is even built, so
    // not even the one-query cost of the guarded case applies here.
    const transactionQueries = countTransactionsQueries(() => {
      expect(evaluateAnomalies({ now: NOW, tz: TZ })).toBe(0);
    });
    expect(transactionQueries).toBe(0);
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

  it('caps at five duplicate pairs, oldest first, with seven candidate pairs', () => {
    emailUser();
    seedHistory();
    const ids: { first: number; second: number }[] = [];
    for (let index = 0; index < 7; index += 1) {
      const merchant = `DUPE MERCHANT ${index}`;
      const first = charge({ merchant, cents: 1500, date: '2026-08-12' });
      const second = charge({ merchant, cents: 1500, date: '2026-08-13' });
      ids.push({ first, second });
    }
    expect(evaluateAnomalies({ now: NOW, tz: TZ })).toBe(5);
    expect(keys()).toEqual(ids.slice(0, 5).map((pair) => `dupe:${pair.first}:${pair.second}`));
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

describe('evaluator-to-renderer wiring', () => {
  it('the rendered body carries the real account name and, on a category-baseline verdict, the real category name', () => {
    emailUser();
    seedHistory();
    const groceries = categoryIdByName(t.db, 'Groceries');
    seedMerchantBaseline('CANADIAN TIRE', groceries);
    // A one-off merchant with no baseline of its own, categorised into groceries: the verdict
    // can only come from the category baseline, which is the branch that names the category
    // rather than the merchant (render.ts's baselineKind === 'category' case).
    charge({ merchant: 'ONE OFF SHOP', cents: 41288, date: '2026-08-14', categoryId: groceries });
    expect(evaluateAnomalies({ now: NOW, tz: TZ })).toBe(1);
    const body = (t.sqlite.prepare('select body from notification_outbox limit 1').get() as { body: string }).body;
    expect(body).toContain('Joint Chequing');
    expect(body).toContain('Groceries');
  });
});

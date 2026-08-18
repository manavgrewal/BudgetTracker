import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { categoryIdByName, createSeededTestDb, insertTestAccount, insertTestUser, type TestDb } from '../../helpers/db';
import { upsertBudget } from '@/lib/budgets';
import { nowIso } from '@/lib/clock';
import { todayIso } from '@/lib/dates';
import { saveEmailTarget, saveSmtp, setPref } from '@/lib/notify/config';
import {
  backupFailedKey,
  budgetExceededKey,
  budgetThresholdKey,
  comingDueKey,
  newSigninKey,
  restoreOutcomeKey,
  staleImportKey,
  updateAvailableKey,
  weeklyDigestKey,
} from '@/lib/notify/events';
import { resetSlotSkipLogForTests, runScheduledEvaluation } from '@/lib/notify/evaluate';
import { resetAnomalyFingerprintForTests } from '@/lib/notify/evaluate/anomalies';
import { resetBudgetFingerprintForTests } from '@/lib/notify/evaluate/budget';
import { evaluateComingDue } from '@/lib/notify/evaluate/coming-due';
import { enqueue, OUTBOX_RETENTION_DAYS, purgeOldOutboxRows, pumpOutbox, resetOutboxPumpForTests } from '@/lib/notify/outbox';
import { resetNotifySenderForTests, setNotifySenderForTests } from '@/lib/notify/send';

/**
 * MUST-3.12's executable argument. Two things live here:
 *
 *   1. every dedup key shape of MUST-3.11, pinned directly against the key builders;
 *   2. a full simulated year of daily evaluations — plus one extension past retention —
 *      proving that the sweep (§3.10/MUST-3.14) can never resurrect an already-delivered
 *      event, for every event type the registry defines.
 *
 * The three IMMEDIATE events (backup_failed, new_signin, restore_outcome) are raised here
 * through the exact same enqueue()+dedup-key path raise.ts itself uses, rather than through
 * raise.ts's wrappers: raise.ts's own guard/wrapping behaviour is already covered by
 * tests/lib/notify/raise.test.ts, and calling its exported raisers here would additionally
 * fire kickOutbox()'s un-awaited pump against the pump this file drives explicitly.
 */

let t: TestDb;
const originalTz = process.env.TZ;
const DAY_MS = 24 * 60 * 60 * 1000;

beforeEach(() => {
  t = createSeededTestDb();
  // runScheduledEvaluation() resolves its own tz via readEnv(), unlike the individual
  // evaluators (which take tz as a parameter): pin it to UTC so a year of daily slots
  // never has to account for a DST transition.
  process.env.TZ = 'UTC';
  resetOutboxPumpForTests();
  resetBudgetFingerprintForTests();
  resetAnomalyFingerprintForTests();
  resetSlotSkipLogForTests();
  setNotifySenderForTests(async () => {});
});

afterEach(() => {
  process.env.TZ = originalTz;
  resetNotifySenderForTests();
  resetOutboxPumpForTests();
  resetBudgetFingerprintForTests();
  resetAnomalyFingerprintForTests();
  resetSlotSkipLogForTests();
  t.cleanup();
});

function emailUser(): number {
  const userId = insertTestUser(t.db, { role: 'admin', username: `u${Math.random().toString(36).slice(2, 8)}` });
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

function typeId(): number {
  const row = t.db.get<{ id: number }>(
    sql`insert into warranty_item_types (name, is_subscription, kind, created_at)
        values (${`warranty-${Math.random().toString(36).slice(2, 8)}`}, 0, 'warranty', ${'2026-01-01T00:00:00.000Z'})
        returning id`,
  );
  return row.id;
}

/** A single non-lifetime item with a fixed expiry date (warranty_items' CHECK constraints
 * require a paired warranty_months whenever expiry_date is set). */
function itemWithExpiry(ownerUserId: number, expiryDate: string): number {
  const row = t.db.get<{ id: number }>(
    sql`insert into warranty_items
          (name, vendor, purchase_date, warranty_months, is_lifetime, expiry_date, price_cents, owner_user_id, type_id, created_at, updated_at)
        values (${'Dishwasher'}, ${null}, ${'2024-01-01'}, ${12}, 0, ${expiryDate}, ${null},
                ${ownerUserId}, ${typeId()}, ${'2026-01-01T00:00:00.000Z'}, ${'2026-01-01T00:00:00.000Z'})
        returning id`,
  );
  return row.id;
}

function importAt(userId: number, createdAt: string): void {
  const accountId = insertTestAccount(t.db);
  t.db.run(
    sql`insert into imports (account_id, profile_id, filename, imported_by, rows_added, rows_duplicate, rows_error, created_at)
        values (${accountId}, null, ${'export.csv'}, ${userId}, 10, 0, 0, ${createdAt})`,
  );
}

function eventCounts(): Record<string, number> {
  const rows = t.sqlite
    .prepare(`select event_id, count(*) as n from notification_outbox group by event_id`)
    .all() as { event_id: string; n: number }[];
  const out: Record<string, number> = {};
  for (const row of rows) out[row.event_id] = row.n;
  return out;
}

describe('MUST-3.11: every dedup key matches its documented shape', () => {
  it('produces the exact key string for each event (spec §3.7 table)', () => {
    expect(comingDueKey(7, '2026-09-01')).toBe('due:7:2026-09-01');
    expect(budgetThresholdKey('household', 3, '2026-09', 80)).toBe('budget:h:3:2026-09:80');
    expect(budgetThresholdKey('personal', 3, '2026-09', 80)).toBe('budget:p:3:2026-09:80');
    expect(budgetExceededKey('household', 3, '2026-09')).toBe('budget:h:3:2026-09:100');
    expect(budgetExceededKey('personal', 3, '2026-09')).toBe('budget:p:3:2026-09:100');
    expect(backupFailedKey('2026-09-01')).toBe('backup-failed:2026-09-01');
    expect(weeklyDigestKey('2026-09-01')).toBe('digest:2026-09-01');
    expect(newSigninKey('2026-09-01T12:00:00.000Z')).toBe('signin:2026-09-01T12:00:00.000Z');
    expect(restoreOutcomeKey('2026-09-01T12:00:00.000Z')).toBe('restore:2026-09-01T12:00:00.000Z');
    expect(staleImportKey('2026-08-31')).toBe('stale:2026-08-31');
  });
});

describe('MUST-3.12: a year of daily evaluations against a fixed item set', () => {
  it(
    'fires every event exactly as many times as the fixed fixture allows over 364 simulated days, with the retention sweep running every night',
    async () => {
      const userId = emailUser();
      // budget_threshold, weekly_digest and stale_import default OFF (MUST-4.1); every
      // other event exercised below is already ON by default (MUST-4.1's default set).
      setPref(userId, 'budget_threshold', 'email', true);
      setPref(userId, 'weekly_digest', 'email', true);
      setPref(userId, 'stale_import', 'email', true);

      // --- the fixed item set ---

      // coming_due: one item, one fixed expiry date, comfortably inside the default
      // 14-day window from day 0 onward. MUST-3.11's key is `due:<itemId>:<expiryDate>`:
      // once fired, the item can never re-enter the window (its date never changes), so
      // it fires exactly once across the whole simulated year no matter how many times
      // the nightly sweep runs.
      itemWithExpiry(userId, '2026-01-10');

      // budget_threshold / budget_exceeded: one household budget and one transaction,
      // both dated in February 2026 and inserted up front — the row exists for every
      // day of the simulation, not only "on" its date. The spend crosses both 80% and
      // 100% in the same evaluation (MUST-6.17). MUST-6.18's fingerprint means only the
      // first day the simulation visits February re-evaluates at all; every other month
      // has no budget row for this category, so nothing fires there.
      const accountId = insertTestAccount(t.db);
      const creatorId = insertTestUser(t.db, { username: 'creator' });
      const groceries = categoryIdByName(t.db, 'Groceries');
      upsertBudget({ scope: 'household', userId: null, categoryId: groceries, month: '2026-02', amountCents: 10000 });
      t.db.run(
        sql`insert into transactions
              (account_id, date, amount_cents, raw_description, normalized_merchant, category_id,
               attributed_user_id, is_transfer, dedup_hash, created_by, created_at, updated_at)
            values (${accountId}, ${'2026-02-10'}, ${-20000}, ${'MERCHANT'}, ${'merchant'}, ${groceries},
                    ${null}, 0, ${'dedup-hash-1'}, ${creatorId}, ${'2026-02-10T00:00:00.000Z'}, ${'2026-02-10T00:00:00.000Z'})`,
      );

      // stale_import: one import, weeks before day 0, so the household is already stale
      // on day 0 and no later import ever resets the clock.
      importAt(userId, '2025-12-01T00:00:00.000Z');

      // --- the simulated year: 364 days = exactly 52 Mondays, starting on a Monday ---
      const START = new Date('2026-01-05T12:00:00Z'); // a Monday, noon UTC
      const TOTAL_DAYS = 364;

      for (let day = 0; day < TOTAL_DAYS; day += 1) {
        const now = new Date(START.getTime() + day * DAY_MS);

        // coming_due + stale_import (daily slot), weekly_digest (weekly slot),
        // budget_threshold/budget_exceeded (every tick, fingerprint-guarded).
        runScheduledEvaluation(now);

        // The three IMMEDIATE events (§6.6), each raised exactly once during the year,
        // through the same enqueue()+dedup-key path raise.ts itself uses.
        if (day === 50) {
          enqueue({
            userId,
            eventId: 'backup_failed',
            dedupKey: backupFailedKey(todayIso(now, 'UTC')),
            subject: 'The nightly backup failed',
            body: 'body',
            at: now,
          });
        }
        if (day === 60) {
          enqueue({
            userId,
            eventId: 'new_signin',
            dedupKey: newSigninKey(nowIso(now)),
            subject: 'New sign-in',
            body: 'body',
            at: now,
          });
        }
        if (day === 70) {
          enqueue({
            userId,
            eventId: 'restore_outcome',
            dedupKey: restoreOutcomeKey(nowIso(now)),
            subject: 'Restore succeeded',
            body: 'body',
            at: now,
          });
        }

        await pumpOutbox(now);
        // MUST-3.14: the sixth purge, run every simulated night exactly as
        // runMaintenanceSweep() runs it in production.
        purgeOldOutboxRows(now);
      }

      expect(eventCounts()).toEqual({
        coming_due: 1,
        budget_threshold: 1,
        budget_exceeded: 1,
        stale_import: 52,
        weekly_digest: 52,
        backup_failed: 1,
        new_signin: 1,
        restore_outcome: 1,
      });
    },
    30_000,
  );
});

describe('MUST-3.12 (extended): pruning a sent coming_due row does not resurrect it', () => {
  it(
    'does not re-fire once its sent row ages out past OUTBOX_RETENTION_DAYS, because the expiry date has left the query window',
    async () => {
      expect(OUTBOX_RETENTION_DAYS).toBe(400);
      const userId = emailUser();
      itemWithExpiry(userId, '2026-01-10');

      const START = new Date('2026-01-05T12:00:00Z');
      const TOTAL_DAYS = 430; // 30 days past the 400-day retention window
      let totalFired = 0;

      for (let day = 0; day < TOTAL_DAYS; day += 1) {
        const now = new Date(START.getTime() + day * DAY_MS);
        totalFired += evaluateComingDue({ userId, now, tz: 'UTC' });
        await pumpOutbox(now);
        purgeOldOutboxRows(now);
      }

      // Fired exactly once, on day 0 — never again, including after its sent row was
      // pruned (around day 401) and 29 more daily evaluations ran with the row gone.
      expect(totalFired).toBe(1);
      const remaining = t.sqlite
        .prepare(`select count(*) as n from notification_outbox where event_id = 'coming_due'`)
        .get() as { n: number };
      expect(remaining.n).toBe(0);
    },
    30_000,
  );
});

describe('MUST-6.3: update:<version> and the one condition under which it regenerates', () => {
  it('fires once per version, and again only after the 400-day sweep removes the row', () => {
    const key = updateAvailableKey('1.4.0');
    const userId = insertTestUser(t.db, { username: 'dedup-admin', role: 'admin' });
    // A configured channel, so an enqueue actually produces a row (notify MUST-4.2).
    saveSmtp({
      preset: 'brevo', host: 'h', port: 587, security: 'starttls', username: 'u',
      password: 'p', fromEmail: 'f@e.com', fromName: 'Budget Tracker', enabled: true,
    });
    saveEmailTarget({ userId, destination: 'a@b.com', enabled: true });
    const first = enqueue({ userId, eventId: 'update_available', dedupKey: key, subject: 's', body: 'b', at: new Date('2026-08-18T00:00:00Z') });
    expect(first.inserted.length).toBeGreaterThan(0);
    const second = enqueue({ userId, eventId: 'update_available', dedupKey: key, subject: 's', body: 'b', at: new Date('2026-08-19T00:00:00Z') });
    expect(second.inserted).toEqual([]);
    // A newer version is a new key and enqueues again.
    const newer = enqueue({ userId, eventId: 'update_available', dedupKey: updateAvailableKey('1.5.0'), subject: 's', body: 'b', at: new Date('2026-08-20T00:00:00Z') });
    expect(newer.inserted.length).toBeGreaterThan(0);
    // ...and after the retention sweep removes the 1.4.0 row, one more reminder is CORRECT.
    t.sqlite.prepare(`delete from notification_outbox where dedup_key = ?`).run(key);
    const afterPrune = enqueue({ userId, eventId: 'update_available', dedupKey: key, subject: 's', body: 'b', at: new Date('2027-10-01T00:00:00Z') });
    expect(afterPrune.inserted.length).toBeGreaterThan(0);
  });
});

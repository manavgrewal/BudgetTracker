import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTestDb, insertTestUser, type TestDb } from '../../../helpers/db';
import { nowIso } from '@/lib/clock';
import { weeklyDigestKey } from '@/lib/notify/events';
import * as digestModule from '@/lib/notify/evaluate/digest';
import { runScheduledEvaluation, resetSlotSkipLogForTests } from '@/lib/notify/evaluate';

let t: TestDb;
const originalTz = process.env.TZ;

beforeEach(() => {
  t = createTestDb();
  process.env.TZ = 'UTC';
  resetSlotSkipLogForTests();
});

afterEach(() => {
  process.env.TZ = originalTz;
  resetSlotSkipLogForTests();
  t.cleanup();
});

describe('slot-skip logging is deduped by (kind, userId, slotDate)', () => {
  it('logs a skipped slot once, not once per tick, and again only when the slot date changes', () => {
    insertTestUser(t.db);
    // dailyHour defaults to 8; at 22:00 UTC hoursSince = 14 > DAILY_MAX_CATCHUP_HOURS (12),
    // so the daily slot is outside its catch-up window on both calendar days below.
    const day1 = new Date('2026-08-17T22:00:00Z');
    const day2 = new Date('2026-08-18T22:00:00Z');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      runScheduledEvaluation(day1);
      runScheduledEvaluation(day1);
      const dailyLines = () => logSpy.mock.calls.filter((args) => typeof args[0] === 'string' && args[0].includes('(daily)'));
      expect(dailyLines()).toHaveLength(1);
      expect(dailyLines()[0][0]).toContain('2026-08-17');

      runScheduledEvaluation(day2);
      expect(dailyLines()).toHaveLength(2);
      expect(dailyLines()[1][0]).toContain('2026-08-18');
    } finally {
      logSpy.mockRestore();
    }
  });
});

describe('the weekly digest existence pre-check', () => {
  // 2026-08-17 is a Monday (slots.ts's mondayOfIsoWeek uses it as KNOWN_MONDAY); digestWeekday
  // defaults to 1 (Monday) and digestHour to 8, so 09:00 UTC on this date is inside the
  // weekly slot's catch-up window with slotDate '2026-08-17'.
  const now = new Date('2026-08-17T09:00:00Z');
  const slotDate = '2026-08-17';

  it('skips recomputing the digest when a row already exists for this user and slot', () => {
    const userId = insertTestUser(t.db);
    const at = nowIso(now);
    // Bypass enqueue()/isEventEnabled entirely — the pre-check only cares whether a row
    // already exists for (user_id, dedup_key), on ANY channel.
    t.db.run(sql`
      insert into notification_outbox (user_id, channel, event_id, dedup_key, subject, body, status, attempts, next_attempt_at, created_at)
      values (${userId}, 'email', 'weekly_digest', ${weeklyDigestKey(slotDate)}, 's', 'b', 'sent', 1, ${at}, ${at})
    `);

    const spy = vi.spyOn(digestModule, 'evaluateWeeklyDigest');
    try {
      runScheduledEvaluation(now);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('still recomputes when no digest row exists yet for this slot', () => {
    const userId = insertTestUser(t.db);
    const spy = vi.spyOn(digestModule, 'evaluateWeeklyDigest').mockReturnValue(0);
    try {
      runScheduledEvaluation(now);
      expect(spy).toHaveBeenCalledWith({ userId, slotDate, now });
    } finally {
      spy.mockRestore();
    }
  });
});

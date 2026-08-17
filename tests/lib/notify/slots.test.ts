import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { localHour } from '@/lib/dates';
import {
  DAILY_MAX_CATCHUP_HOURS,
  WEEKLY_MAX_CATCHUP_HOURS,
  dailySlot,
  mondayOfIsoWeek,
  weeklySlot,
} from '@/lib/notify/evaluate/slots';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const TZ = 'UTC';

/** A UTC instant on 2026-08-17, which is a Monday. */
function at(day: string, hour: number, minute = 0): Date {
  return new Date(`${day}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00Z`);
}

describe('MUST-2.1: slots.ts is pure', () => {
  it('imports no @/db, no @/lib/env and no node builtin', () => {
    const source = fs.readFileSync(path.join(root, 'src/lib/notify/evaluate/slots.ts'), 'utf8');
    expect(source).not.toMatch(/from\s+['"]@\/db/);
    expect(source).not.toMatch(/from\s+['"]@\/lib\/env['"]/);
    expect(source).not.toMatch(/from\s+['"]node:/);
  });
});

describe('MUST-6.6 / MUST-6.7: the daily slot at hour 8', () => {
  it('pins the catch-up windows', () => {
    expect(DAILY_MAX_CATCHUP_HOURS).toBe(12);
    expect(WEEKLY_MAX_CATCHUP_HOURS).toBe(48);
  });

  // §17.1's prose says "25 h stale" here; MUST-6.6's own formula gives 24 + (7 - 8) = 23.
  // The formula is normative and 23 is still far outside the 12-hour window, so the
  // outcome the spec asserts — SKIPPED — is unchanged.
  it('07:59 resolves to yesterday, 23 hours stale, and is SKIPPED', () => {
    const slot = dailySlot(at('2026-08-17', 7, 59), 8, TZ);
    expect(slot.slotDate).toBe('2026-08-16');
    expect(slot.hoursSince).toBe(23);
    expect(slot.fires).toBe(false);
  });

  it('08:00 resolves to today, 0 hours, and fires', () => {
    expect(dailySlot(at('2026-08-17', 8), 8, TZ)).toEqual({ slotDate: '2026-08-17', hoursSince: 0, fires: true });
  });

  it('19:00 is today, 11 hours, and fires', () => {
    expect(dailySlot(at('2026-08-17', 19), 8, TZ)).toEqual({ slotDate: '2026-08-17', hoursSince: 11, fires: true });
  });

  it('20:01 is 12 hours and still fires (the boundary is inclusive)', () => {
    expect(dailySlot(at('2026-08-17', 20, 1), 8, TZ)).toEqual({ slotDate: '2026-08-17', hoursSince: 12, fires: true });
  });

  it('21:00 is 13 hours and is SKIPPED', () => {
    expect(dailySlot(at('2026-08-17', 21), 8, TZ)).toEqual({ slotDate: '2026-08-17', hoursSince: 13, fires: false });
  });

  it('MUST-6.7: a container booting at 09:30 after missing 08:00 does fire', () => {
    expect(dailySlot(at('2026-08-17', 9, 30), 8, TZ).fires).toBe(true);
  });

  it('works for a midnight slot without going negative', () => {
    expect(dailySlot(at('2026-08-17', 0, 5), 0, TZ)).toEqual({ slotDate: '2026-08-17', hoursSince: 0, fires: true });
    expect(dailySlot(at('2026-08-17', 23), 0, TZ)).toEqual({ slotDate: '2026-08-17', hoursSince: 23, fires: false });
  });

  it('respects the timezone it is given', () => {
    // 2026-08-17T12:00:00Z is 08:00 in Toronto.
    expect(dailySlot(new Date('2026-08-17T12:00:00Z'), 8, 'America/Toronto')).toEqual({
      slotDate: '2026-08-17',
      hoursSince: 0,
      fires: true,
    });
  });
});

describe('MUST-6.8: DST transition days in America/Toronto are deliberately NOT corrected for', () => {
  // 2026-03-08 is the spring-forward day: clocks jump from 01:59:59 straight to 03:00:00,
  // skipping the 02:00 hour entirely. The transition instant is 07:00 UTC (02:00 EST /
  // UTC-5 becomes 03:00 EDT / UTC-4, both of which equal 07:00 UTC).
  it('spring-forward: local hour 2 never happens — it jumps 1 -> 3 across the instant', () => {
    expect(localHour(new Date('2026-03-08T06:59:00Z'), 'America/Toronto')).toBe(1);
    expect(localHour(new Date('2026-03-08T07:00:00Z'), 'America/Toronto')).toBe(3);
  });

  it('spring-forward: dailySlot at hour 8, evaluated at 07:00 local, still uses the naive 24 + (currentHour - hour) formula', () => {
    // 07:00 EDT (post-jump) = 11:00 UTC. currentHour(7) < hour(8), so d = 1: yesterday's
    // slot hasn't been caught up on yet. hoursSince = 24 + (7 - 8) = 23, exactly what a
    // non-transition day would compute — MUST-6.8 is that this is NOT adjusted for the
    // skipped hour (the true elapsed wall-clock time is only 22 hours here).
    expect(dailySlot(new Date('2026-03-08T11:00:00Z'), 8, 'America/Toronto')).toEqual({
      slotDate: '2026-03-07',
      hoursSince: 23,
      fires: false,
    });
  });

  // 2026-11-01 is the fall-back day: clocks fall from 01:59:59 EDT back to 01:00:00 EST, so
  // the local hour 1 (and every minute within it) happens twice. The transition instant is
  // 06:00 UTC (02:00 EDT / UTC-4 becomes 01:00 EST / UTC-5, both equal 06:00 UTC).
  it('fall-back: local hour 1 repeats — the same wall-clock hour reads twice, one real hour apart', () => {
    expect(localHour(new Date('2026-11-01T05:30:00Z'), 'America/Toronto')).toBe(1); // 01:30 EDT, first pass
    expect(localHour(new Date('2026-11-01T06:30:00Z'), 'America/Toronto')).toBe(1); // 01:30 EST, the repeat
  });

  it('fall-back: dailySlot at hour 8, evaluated at 07:00 local, computes the identical 23 hours despite an extra real hour having passed', () => {
    // 07:00 EST (post-fall-back) = 12:00 UTC. Same d = 1, same hoursSince = 24 + (7 - 8) =
    // 23 as the spring-forward case and as any ordinary day — the formula is pinned as
    // wall-clock-only, even though the true elapsed wall-clock time is actually 24 hours
    // here (the repeated hour added one back). Both DST days land on the same number by
    // construction; that is the documented policy, not a coincidence.
    expect(dailySlot(new Date('2026-11-01T12:00:00Z'), 8, 'America/Toronto')).toEqual({
      slotDate: '2026-10-31',
      hoursSince: 23,
      fires: false,
    });
  });
});

describe('MUST-6.6 / MUST-6.7: the weekly slot, W = 1 (Monday) at H = 8', () => {
  it('Monday 07:00 resolves to the previous Monday, 167 hours, SKIPPED', () => {
    expect(weeklySlot(at('2026-08-17', 7), 1, 8, TZ)).toEqual({ slotDate: '2026-08-10', hoursSince: 167, fires: false });
  });

  it('Monday 09:00 is today, 1 hour, fires', () => {
    expect(weeklySlot(at('2026-08-17', 9), 1, 8, TZ)).toEqual({ slotDate: '2026-08-17', hoursSince: 1, fires: true });
  });

  it('Wednesday 09:00 is Monday, 49 hours, SKIPPED', () => {
    expect(weeklySlot(at('2026-08-19', 9), 1, 8, TZ)).toEqual({ slotDate: '2026-08-17', hoursSince: 49, fires: false });
  });

  it('Wednesday 07:00 is Monday, 47 hours, and fires', () => {
    expect(weeklySlot(at('2026-08-19', 7), 1, 8, TZ)).toEqual({ slotDate: '2026-08-17', hoursSince: 47, fires: true });
  });

  it('a Sunday slot (W = 0) resolves correctly from a Saturday', () => {
    // 2026-08-22 is a Saturday; the last Sunday slot was 2026-08-16 at 08:00.
    expect(weeklySlot(at('2026-08-22', 9), 0, 8, TZ)).toEqual({ slotDate: '2026-08-16', hoursSince: 145, fires: false });
  });
});

describe('mondayOfIsoWeek', () => {
  it('maps every day of a week onto its Monday', () => {
    expect(mondayOfIsoWeek('2026-08-17')).toBe('2026-08-17'); // Monday
    expect(mondayOfIsoWeek('2026-08-19')).toBe('2026-08-17'); // Wednesday
    expect(mondayOfIsoWeek('2026-08-23')).toBe('2026-08-17'); // Sunday
    expect(mondayOfIsoWeek('2026-08-24')).toBe('2026-08-24'); // next Monday
  });

  it('crosses a month boundary as pure string math', () => {
    expect(mondayOfIsoWeek('2026-09-02')).toBe('2026-08-31');
  });
});

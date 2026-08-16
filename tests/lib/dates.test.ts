import { describe, it, expect } from 'vitest';
import {
  DATE_FORMATS,
  addDaysIso,
  addMonths,
  addMonthsClamped,
  currentMonth,
  daysBetweenIso,
  isDateFormat,
  isIsoDate,
  isMonthKey,
  monthEnd,
  monthOf,
  monthRange,
  monthStart,
  monthsBetween,
  parseDateString,
  resolveEffectiveMonth,
  todayIso,
  wholeMonthsUntil,
} from '@/lib/dates';

describe('parseDateString', () => {
  it('parses every supported format', () => {
    expect(parseDateString('03/14/2026', 'MM/DD/YYYY')).toBe('2026-03-14');
    expect(parseDateString('14/03/2026', 'DD/MM/YYYY')).toBe('2026-03-14');
    expect(parseDateString('2026-03-14', 'YYYY-MM-DD')).toBe('2026-03-14');
    expect(parseDateString('2026/03/14', 'YYYY/MM/DD')).toBe('2026-03-14');
    expect(parseDateString('03/14/26', 'MM/DD/YY')).toBe('2026-03-14');
    expect(parseDateString('14-Mar-2026', 'DD-MMM-YYYY')).toBe('2026-03-14');
    expect(parseDateString('Mar 14, 2026', 'MMM DD, YYYY')).toBe('2026-03-14');
  });

  it('tolerates padding and single-digit components', () => {
    expect(parseDateString(' 3/4/2026 ', 'MM/DD/YYYY')).toBe('2026-03-04');
    expect(parseDateString('2026-3-4', 'YYYY-MM-DD')).toBe('2026-03-04');
  });

  it('rejects impossible calendar dates instead of rolling them over', () => {
    expect(parseDateString('02/30/2026', 'MM/DD/YYYY')).toBeNull();
    expect(parseDateString('13/01/2026', 'MM/DD/YYYY')).toBeNull();
    expect(parseDateString('00/01/2026', 'MM/DD/YYYY')).toBeNull();
  });

  it('accepts a real leap day and rejects a fake one', () => {
    expect(parseDateString('02/29/2024', 'MM/DD/YYYY')).toBe('2024-02-29');
    expect(parseDateString('02/29/2026', 'MM/DD/YYYY')).toBeNull();
  });

  it('returns null for blank, garbage, or unknown formats', () => {
    expect(parseDateString('', 'MM/DD/YYYY')).toBeNull();
    expect(parseDateString('not a date', 'MM/DD/YYYY')).toBeNull();
    expect(parseDateString('2026-03-14', 'NOPE/FORMAT')).toBeNull();
  });

  it('never mutates its input into a different timezone day', () => {
    // The parser is pure string math; no Date construction in local time.
    expect(parseDateString('01/01/2026', 'MM/DD/YYYY')).toBe('2026-01-01');
    expect(parseDateString('12/31/2026', 'MM/DD/YYYY')).toBe('2026-12-31');
  });

  it('exposes the format list used by the mapping wizard', () => {
    expect(DATE_FORMATS).toContain('MM/DD/YYYY');
    expect(DATE_FORMATS).toHaveLength(7);
    expect(isDateFormat('MM/DD/YYYY')).toBe(true);
    expect(isDateFormat('MM-DD-YYYY')).toBe(false);
  });
});

describe('month arithmetic', () => {
  it('validates shapes', () => {
    expect(isIsoDate('2026-03-14')).toBe(true);
    expect(isIsoDate('2026-13-01')).toBe(false);
    expect(isIsoDate('2026-3-1')).toBe(false);
    expect(isMonthKey('2026-03')).toBe(true);
    expect(isMonthKey('2026-3')).toBe(false);
    expect(isMonthKey('2026-13')).toBe(false);
  });

  it('extracts, bounds and shifts months', () => {
    expect(monthOf('2026-03-14')).toBe('2026-03');
    expect(monthStart('2026-03')).toBe('2026-03-01');
    expect(monthEnd('2026-03')).toBe('2026-03-31');
    expect(monthEnd('2026-02')).toBe('2026-02-28');
    expect(monthEnd('2024-02')).toBe('2024-02-29');
    expect(monthEnd('2026-04')).toBe('2026-04-30');
    expect(addMonths('2026-03', 1)).toBe('2026-04');
    expect(addMonths('2026-12', 1)).toBe('2027-01');
    expect(addMonths('2026-01', -1)).toBe('2025-12');
    expect(addMonths('2026-01', -13)).toBe('2024-12');
    expect(addMonths('2026-03', 0)).toBe('2026-03');
  });

  it('counts months between keys', () => {
    expect(monthsBetween('2026-01', '2026-01')).toBe(0);
    expect(monthsBetween('2026-01', '2026-04')).toBe(3);
    expect(monthsBetween('2026-04', '2026-01')).toBe(-3);
    expect(monthsBetween('2025-11', '2026-02')).toBe(3);
  });

  it('builds inclusive month ranges', () => {
    expect(monthRange('2026-01', '2026-04')).toEqual(['2026-01', '2026-02', '2026-03', '2026-04']);
    expect(monthRange('2026-01', '2026-01')).toEqual(['2026-01']);
    expect(monthRange('2026-04', '2026-01')).toEqual([]);
  });

  it('computes whole months until a target date with a floor of 1', () => {
    expect(wholeMonthsUntil('2026-08-15', '2026-12-01')).toBe(4);
    expect(wholeMonthsUntil('2026-08-15', '2026-09-01')).toBe(1);
    expect(wholeMonthsUntil('2026-08-15', '2026-08-31')).toBe(1);
    expect(wholeMonthsUntil('2026-08-15', '2026-01-01')).toBe(1);
  });
});

describe('timezone-aware today', () => {
  it('uses the configured zone, not the process zone', () => {
    // 2026-03-15T02:30Z is still 2026-03-14 in Toronto (UTC-4 in March).
    const instant = new Date('2026-03-15T02:30:00.000Z');
    expect(todayIso(instant, 'America/Toronto')).toBe('2026-03-14');
    expect(todayIso(instant, 'UTC')).toBe('2026-03-15');
    expect(currentMonth(new Date('2026-04-01T02:30:00.000Z'), 'America/Toronto')).toBe('2026-03');
    expect(currentMonth(new Date('2026-04-01T02:30:00.000Z'), 'UTC')).toBe('2026-04');
  });
});

describe('resolveEffectiveMonth', () => {
  it('picks the newest candidate at or before the viewed month', () => {
    expect(resolveEffectiveMonth(['2026-01', '2026-05', '2026-03'], '2026-04')).toBe('2026-03');
    expect(resolveEffectiveMonth(['2026-01', '2026-04'], '2026-04')).toBe('2026-04');
  });

  it('returns null when every candidate is in the future', () => {
    expect(resolveEffectiveMonth(['2026-05', '2026-06'], '2026-04')).toBeNull();
    expect(resolveEffectiveMonth([], '2026-04')).toBeNull();
  });
});

describe('addMonthsClamped (spec §3.6)', () => {
  // The eight worked examples from the spec, verbatim.
  it.each([
    ['2026-01-31', 1, '2026-02-28'],
    ['2024-01-31', 1, '2024-02-29'],
    ['2024-02-29', 12, '2025-02-28'],
    ['2026-03-31', 1, '2026-04-30'],
    ['2026-08-31', 6, '2027-02-28'],
    ['2026-01-31', 12, '2027-01-31'],
    ['2026-08-16', 24, '2028-08-16'],
    ['2026-12-31', 1, '2027-01-31'],
  ])('%s + %i months = %s', (from, months, expected) => {
    expect(addMonthsClamped(from, months)).toBe(expected);
  });

  it('differs from Date.prototype.setMonth, which overflows (the regression this rule prevents)', () => {
    const overflowed = new Date(Date.UTC(2026, 0, 31));
    overflowed.setUTCMonth(overflowed.getUTCMonth() + 1);
    expect(overflowed.toISOString().slice(0, 10)).toBe('2026-03-03');
    expect(addMonthsClamped('2026-01-31', 1)).toBe('2026-02-28');
  });

  it('handles negative deltas (used for the 20-year suggestion floor)', () => {
    expect(addMonthsClamped('2026-08-16', -240)).toBe('2006-08-16');
    expect(addMonthsClamped('2026-01-15', -1)).toBe('2025-12-15');
  });

  it('never returns an invalid calendar date across 1–120 months from every day of 2024–2027', () => {
    for (let year = 2024; year <= 2027; year += 1) {
      for (let month = 1; month <= 12; month += 1) {
        for (let day = 1; day <= 31; day += 1) {
          const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
          if (!isIsoDate(iso)) continue;
          for (let months = 1; months <= 120; months += 1) {
            expect(isIsoDate(addMonthsClamped(iso, months)), `${iso} + ${months}`).toBe(true);
          }
        }
      }
    }
  });
});

describe('addDaysIso / daysBetweenIso', () => {
  it('crosses month, year and leap boundaries without a Date object', () => {
    expect(addDaysIso('2026-08-16', 60)).toBe('2026-10-15');
    expect(addDaysIso('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDaysIso('2024-02-28', 1)).toBe('2024-02-29');
    expect(addDaysIso('2026-02-28', 1)).toBe('2026-03-01');
    expect(addDaysIso('2026-01-01', -1)).toBe('2025-12-31');
    expect(addDaysIso('2026-08-16', 0)).toBe('2026-08-16');
  });

  it('round-trips against daysBetweenIso', () => {
    expect(daysBetweenIso('2026-08-16', '2026-10-15')).toBe(60);
    expect(daysBetweenIso('2026-08-16', '2026-08-16')).toBe(0);
    expect(daysBetweenIso('2026-08-16', '2026-08-15')).toBe(-1);
    expect(daysBetweenIso('2024-02-28', '2024-03-01')).toBe(2);
  });
});

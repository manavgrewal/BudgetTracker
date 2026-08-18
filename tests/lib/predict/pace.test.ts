import { describe, it, expect } from 'vitest';
import { monthEnd } from '@/lib/dates';
import { projectMonthEnd } from '@/lib/predict/pace';

describe('MUST-8.1 to MUST-8.3: the projection formula', () => {
  it('scales the month so far across the whole month', () => {
    expect(projectMonthEnd({ spentCents: 41000, dayOfMonth: 12, daysInMonth: 31 })).toBe(105917);
    expect(projectMonthEnd({ spentCents: 7000, dayOfMonth: 7, daysInMonth: 31 })).toBe(31000);
    expect(projectMonthEnd({ spentCents: 14000, dayOfMonth: 15, daysInMonth: 28 })).toBe(26133);
  });

  it('MUST-8.3: today counts as elapsed, so the last day projects to exactly what was spent', () => {
    expect(projectMonthEnd({ spentCents: 123456, dayOfMonth: 31, daysInMonth: 31 })).toBe(123456);
  });
});

describe('MUST-8.4 and MUST-8.5: the two guards', () => {
  it('returns null before the seventh, because three days times ten is a rumour', () => {
    expect(projectMonthEnd({ spentCents: 50000, dayOfMonth: 6, daysInMonth: 31 })).toBeNull();
    expect(projectMonthEnd({ spentCents: 50000, dayOfMonth: 1, daysInMonth: 31 })).toBeNull();
  });

  it('returns zero for a month that is net refunded so far, never a negative projection', () => {
    expect(projectMonthEnd({ spentCents: 0, dayOfMonth: 10, daysInMonth: 31 })).toBe(0);
    expect(projectMonthEnd({ spentCents: -4000, dayOfMonth: 10, daysInMonth: 31 })).toBe(0);
  });
});

describe('MUST-8.2: daysInMonth comes from monthEnd, so leap years are already right', () => {
  it('gives February 2028 twenty-nine days', () => {
    const daysInMonth = Number(monthEnd('2028-02').slice(8, 10));
    expect(daysInMonth).toBe(29);
    expect(projectMonthEnd({ spentCents: 29000, dayOfMonth: 29, daysInMonth })).toBe(29000);
  });
});

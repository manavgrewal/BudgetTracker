import { describe, it, expect } from 'vitest';
import { historyMonths, seasonalApplies } from '@/lib/predict/window';

describe('MUST-4.1 to MUST-4.5: historyMonths', () => {
  it('is the six full calendar months before the target, never the target itself', () => {
    expect(historyMonths({ targetMonth: '2026-08', firstDataMonth: '2025-01' })).toEqual([
      '2026-02',
      '2026-03',
      '2026-04',
      '2026-05',
      '2026-06',
      '2026-07',
    ]);
  });

  it('returns an empty list when the household has no transactions', () => {
    expect(historyMonths({ targetMonth: '2026-08', firstDataMonth: null })).toEqual([]);
  });

  it('MUST-4.3: clips to the household first data month', () => {
    expect(historyMonths({ targetMonth: '2026-08', firstDataMonth: '2026-05' })).toEqual(['2026-05', '2026-06', '2026-07']);
    expect(historyMonths({ targetMonth: '2026-08', firstDataMonth: '2026-07' })).toEqual(['2026-07']);
  });

  it('is empty for a target month the household has not reached', () => {
    expect(historyMonths({ targetMonth: '2026-09', firstDataMonth: '2026-09' })).toEqual([]);
  });

  it('crosses a year boundary', () => {
    expect(historyMonths({ targetMonth: '2026-01', firstDataMonth: '2020-01' })).toEqual([
      '2025-07',
      '2025-08',
      '2025-09',
      '2025-10',
      '2025-11',
      '2025-12',
    ]);
  });
});

describe('MUST-5.6 conditions 1 to 3: seasonalApplies', () => {
  it('is false without a first data month', () => {
    expect(seasonalApplies({ targetMonth: '2026-08', firstDataMonth: null })).toBe(false);
  });

  it('is false under the 15-month floor', () => {
    expect(seasonalApplies({ targetMonth: '2026-08', firstDataMonth: '2025-08' })).toBe(false);
  });

  it('is false when the 12 months ending at the reference month are not all covered', () => {
    // Reference month A is 2025-08. Its own 12-month window starts at 2024-09, so a household
    // that started in 2025-01 has no complete reference year even though it clears 15 months.
    expect(seasonalApplies({ targetMonth: '2026-08', firstDataMonth: '2025-01' })).toBe(false);
  });

  it('is true once the full reference year is inside the household history', () => {
    expect(seasonalApplies({ targetMonth: '2026-08', firstDataMonth: '2024-09' })).toBe(true);
    expect(seasonalApplies({ targetMonth: '2026-08', firstDataMonth: '2024-08' })).toBe(true);
  });
});

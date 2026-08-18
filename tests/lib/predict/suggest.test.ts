import { describe, it, expect } from 'vitest';
import { medianCents } from '@/lib/predict/stats';
import { seasonalFactor, suggestBudget, type SuggestionResult } from '@/lib/predict/suggest';

const flat = (cents: number, months = 6) => Array.from({ length: months }, () => cents);

function suggestionOf(result: SuggestionResult) {
  if (!('suggestion' in result)) throw new Error(`expected a suggestion, got ${result.reason}`);
  return result.suggestion;
}

describe('MUST-6.1 step 1: the minimum-history guard', () => {
  it('refuses under three months', () => {
    expect(suggestBudget({ monthlyCents: [], seasonal: null })).toEqual({ reason: 'not-enough-history' });
    expect(suggestBudget({ monthlyCents: flat(50000, 2), seasonal: null })).toEqual({ reason: 'not-enough-history' });
  });

  it('MUST-4.7: three observations are enough, even when one of them is zero', () => {
    // Three zero months and three spending months is six observations, not three. The guard is
    // on the WINDOW length, not on the months in which this category happened to spend.
    const result = suggestBudget({ monthlyCents: [0, 60000, 60000], seasonal: null });
    expect('suggestion' in result).toBe(true);
  });
});

describe('MUST-6.1 step 2: a non-positive median gets no budget', () => {
  it('refuses an all-zero series and a net-refunded one', () => {
    expect(suggestBudget({ monthlyCents: flat(0), seasonal: null })).toEqual({ reason: 'no-spend' });
    expect(suggestBudget({ monthlyCents: flat(-2500), seasonal: null })).toEqual({ reason: 'no-spend' });
  });
});

describe('MUST-6.1 step 3: half the observed trend, and nothing for flat or unknown', () => {
  it('adds half a rising move', () => {
    // median 55000, prior mean 50000, recent mean 60000, delta 10000, half is 5000.
    const series = [50000, 50000, 50000, 60000, 60000, 60000];
    expect(medianCents(series)).toBe(55000);
    expect(suggestionOf(suggestBudget({ monthlyCents: series, seasonal: null })).suggestedCents).toBe(60000);
  });

  it('subtracts half a falling move', () => {
    const series = [60000, 60000, 60000, 50000, 50000, 50000];
    expect(suggestionOf(suggestBudget({ monthlyCents: series, seasonal: null })).suggestedCents).toBe(50000);
  });

  it('leaves a flat series at its median', () => {
    expect(suggestionOf(suggestBudget({ monthlyCents: flat(47300), seasonal: null })).suggestedCents).toBe(47300);
  });

  it('leaves an unknown trend at its median, because three points are not a trend', () => {
    const result = suggestionOf(suggestBudget({ monthlyCents: [40000, 50000, 60000], seasonal: null }));
    expect(result.trend).toEqual({ direction: 'unknown', deltaCents: 0 });
    expect(result.suggestedCents).toBe(50000);
  });
});

describe('MUST-5.7 and MUST-6.1 step 4: the clamped seasonal factor', () => {
  it('is absent when the reference year has no positive mean (MUST-5.6 condition 4)', () => {
    expect(seasonalFactor({ monthCents: 5000, twelveMonths: Array.from({ length: 12 }, () => 0) })).toBeNull();
    expect(seasonalFactor({ monthCents: 5000, twelveMonths: Array.from({ length: 12 }, () => -100) })).toBeNull();
  });

  it('does not apply when the reference month was net refunded', () => {
    expect(seasonalFactor({ monthCents: -1, twelveMonths: Array.from({ length: 12 }, () => 10000) })).toBeNull();
  });

  it('passes an in-band ratio through as a rational, never as a float', () => {
    expect(seasonalFactor({ monthCents: 12000, twelveMonths: Array.from({ length: 12 }, () => 10000) })).toEqual({
      num: 12000,
      den: 10000,
    });
  });

  it('clamps at 0.5x and at 2.0x on the rational', () => {
    expect(seasonalFactor({ monthCents: 1000, twelveMonths: Array.from({ length: 12 }, () => 10000) })).toEqual({
      num: 50,
      den: 100,
    });
    expect(seasonalFactor({ monthCents: 90000, twelveMonths: Array.from({ length: 12 }, () => 10000) })).toEqual({
      num: 200,
      den: 100,
    });
  });

  it('scales the value and records that it happened', () => {
    const result = suggestionOf(suggestBudget({ monthlyCents: flat(40000), seasonal: { num: 150, den: 100 } }));
    expect(result.suggestedCents).toBe(60000);
    expect(result.seasonalApplied).toBe(true);
  });

  it('MUST-5.8: an absent factor is recorded as absent, not as a neutral 1.0', () => {
    expect(suggestionOf(suggestBudget({ monthlyCents: flat(40000), seasonal: null })).seasonalApplied).toBe(false);
  });
});

describe('MUST-6.1 step 5 and MUST-6.3: the cap binds against the median, not the trend', () => {
  it('holds a rising trend and a 2.0x season together to three times the median', () => {
    const series = [1000, 1000, 1000, 200000, 200000, 200000];
    const median = medianCents(series);
    expect(median).toBe(100500);
    const result = suggestionOf(suggestBudget({ monthlyCents: series, seasonal: { num: 200, den: 100 } }));
    expect(result.suggestedCents).toBe(301500);
    expect(result.suggestedCents).toBeLessThanOrEqual((median ?? 0) * 3 + 99);
  });
});

describe('MUST-6.1 step 6: the round up to the dollar', () => {
  it('never shows a budget of $746.03', () => {
    expect(suggestionOf(suggestBudget({ monthlyCents: flat(74603), seasonal: null })).suggestedCents).toBe(74700);
  });
});

describe('MUST-6.1 step 7: the floor', () => {
  it('refuses anything under $5', () => {
    expect(suggestBudget({ monthlyCents: flat(1), seasonal: null })).toEqual({ reason: 'below-floor' });
  });

  it('refuses rather than throwing when a falling trend drives the value below zero', () => {
    // median 100, prior mean 200033, recent mean 33, so step 3 gives 100 - 100000.
    const series = [100, 300000, 300000, 0, 0, 100];
    expect(medianCents(series)).toBe(100);
    expect(suggestBudget({ monthlyCents: series, seasonal: null })).toEqual({ reason: 'below-floor' });
  });
});

describe('MUST-6.7 and MUST-6.8: confidence is a label derived from two things', () => {
  it('reads off the number of months used', () => {
    expect(suggestionOf(suggestBudget({ monthlyCents: flat(50000, 3), seasonal: null })).confidence).toBe('low');
    expect(suggestionOf(suggestBudget({ monthlyCents: flat(50000, 4), seasonal: null })).confidence).toBe('low');
    expect(suggestionOf(suggestBudget({ monthlyCents: flat(50000, 5), seasonal: null })).confidence).toBe('medium');
    expect(suggestionOf(suggestBudget({ monthlyCents: flat(50000, 6), seasonal: null })).confidence).toBe('high');
  });

  it('drops one step when the spread is more than twice the median, and low stays low', () => {
    // median 50000, spread 150000, so high becomes medium.
    const six = [10000, 10000, 10000, 90000, 160000, 90000];
    expect(medianCents(six)).toBe(50000);
    expect(suggestionOf(suggestBudget({ monthlyCents: six, seasonal: null })).confidence).toBe('medium');
    // Five months, spread over twice the median, so medium becomes low.
    const five = [10000, 50000, 50000, 90000, 160000];
    expect(suggestionOf(suggestBudget({ monthlyCents: five, seasonal: null })).confidence).toBe('low');
    // Three months, already low, stays low.
    const three = [10000, 50000, 160000];
    expect(suggestionOf(suggestBudget({ monthlyCents: three, seasonal: null })).confidence).toBe('low');
  });
});

describe('AC6 and MUST-6.5: the property that has to hold over any series', () => {
  it('is null or a positive whole-dollar amount at most 3x median + 99, over 500 series', () => {
    let seed = 20260818;
    const next = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed;
    };
    for (let run = 0; run < 500; run += 1) {
      const length = 3 + (next() % 4);
      const monthlyCents = Array.from({ length }, () => (next() % 400000) - 100000);
      const seasonal = next() % 3 === 0 ? { num: 50 + (next() % 150), den: 100 } : null;
      const result = suggestBudget({ monthlyCents, seasonal });
      if (!('suggestion' in result)) continue;
      const { suggestedCents } = result.suggestion;
      const median = medianCents(monthlyCents) ?? 0;
      expect(suggestedCents).toBeGreaterThan(0);
      expect(suggestedCents % 100).toBe(0);
      expect(suggestedCents).toBeLessThanOrEqual(median * 3 + 99);
    }
  });
});

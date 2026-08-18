import {
  MIN_HISTORY_MONTHS,
  SEASONAL_CLAMP_MAX_PCT,
  SEASONAL_CLAMP_MIN_PCT,
  SUGGESTION_CAP_MULTIPLE,
  SUGGESTION_FLOOR_CENTS,
  TREND_DAMPING_DIVISOR,
} from '@/lib/predict/constants';
import { ceilToDollar, divRound, meanCents, medianCents, spreadCents, trendOf, type Trend } from '@/lib/predict/stats';

/**
 * The suggested budget, PURE (MUST-2.1). Seven ordered steps over a series of integer cents.
 */

export type Confidence = 'low' | 'medium' | 'high';

export interface Suggestion {
  suggestedCents: number;
  medianCents: number;
  meanCents: number;
  trend: Trend;
  monthsUsed: number;
  seasonalApplied: boolean;
  confidence: Confidence;
}

/** A Suggestion tagged with its category. The shape the Budgets page hands its client. */
export interface CategorySuggestion extends Suggestion {
  categoryId: number;
}

export type NoSuggestionReason =
  | 'not-enough-history' // window shorter than MIN_HISTORY_MONTHS
  | 'no-spend' // median at or below zero
  | 'below-floor'; // computed value under SUGGESTION_FLOOR_CENTS

export type SuggestionResult = { suggestion: Suggestion } | { reason: NoSuggestionReason };

/**
 * MUST-5.7: the same-month-last-year factor as a clamped rational, never a float. Returns
 * null when MUST-5.6 condition 4 fails (no positive reference mean) or when the reference
 * month was net refunded, because a category that was refunded that month last year says
 * nothing useful about this one.
 */
export function seasonalFactor(input: { monthCents: number; twelveMonths: number[] }): { num: number; den: number } | null {
  const den = meanCents(input.twelveMonths);
  if (den === null || den <= 0) return null;
  const num = input.monthCents;
  if (num < 0) return null;
  if (num * 100 < den * SEASONAL_CLAMP_MIN_PCT) return { num: SEASONAL_CLAMP_MIN_PCT, den: 100 };
  if (num * 100 > den * SEASONAL_CLAMP_MAX_PCT) return { num: SEASONAL_CLAMP_MAX_PCT, den: 100 };
  return { num, den };
}

/**
 * MUST-6.7: monthsUsed sets the level, then a spread of more than twice the median drops it
 * one step. MUST-6.8: this is a label the UI shows, never a filter.
 */
function confidenceOf(monthsUsed: number, median: number, spread: number): Confidence {
  const level: Confidence = monthsUsed >= 6 ? 'high' : monthsUsed === 5 ? 'medium' : 'low';
  if (spread <= 2 * median) return level;
  return level === 'high' ? 'medium' : 'low';
}

/** MUST-6.1: the seven steps, in exactly this order, each separately testable. */
export function suggestBudget(input: {
  monthlyCents: number[];
  seasonal: { num: number; den: number } | null;
}): SuggestionResult {
  const series = input.monthlyCents;

  // 1. Guard. Two months of data can produce a median, and that median means nothing.
  if (series.length < MIN_HISTORY_MONTHS) return { reason: 'not-enough-history' };

  // 2. Base. MUST-5.2: the median drives the suggestion because one $2,400 vet bill in six
  // months moves a mean by $400 a month and moves a median by nothing.
  const base = medianCents(series);
  if (base === null || base <= 0) return { reason: 'no-spend' };

  // 3. Trend. MUST-6.2: HALF the observed move. Six months of one household's data is a small
  // sample, and a budget that chases the last three months overshoots on both sides.
  const trend = trendOf(series);
  let value = base;
  if (trend.direction === 'rising' || trend.direction === 'falling') {
    value = base + divRound(trend.deltaCents, TREND_DAMPING_DIVISOR);
  }

  // 4. Seasonality, on the rational (MUST-3.5).
  if (input.seasonal !== null) value = divRound(value * input.seasonal.num, input.seasonal.den);

  // 5. Cap. MUST-6.3: applied to the MEDIAN, not to the post-trend value, so it cannot itself
  // be inflated by the thing it is bounding.
  value = Math.min(value, base * SUGGESTION_CAP_MULTIPLE);

  // 6. Round. ceilToDollar throws on a negative (MUST-3.4) and step 3 can drive the value
  // below zero on a hard falling trend. Step 7 would return 'below-floor' for any such value
  // anyway, so it is returned here rather than handed to a function whose contract forbids it.
  if (value <= 0) return { reason: 'below-floor' };
  value = ceilToDollar(value);

  // 7. Floor.
  if (value < SUGGESTION_FLOOR_CENTS) return { reason: 'below-floor' };

  return {
    suggestion: {
      suggestedCents: value,
      medianCents: base,
      meanCents: meanCents(series) ?? 0,
      trend,
      monthsUsed: series.length,
      seasonalApplied: input.seasonal !== null,
      confidence: confidenceOf(series.length, base, spreadCents(series) ?? 0),
    },
  };
}

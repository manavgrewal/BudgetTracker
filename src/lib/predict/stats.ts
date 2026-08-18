import { TREND_MIN_ABS_CENTS, TREND_MIN_PCT } from '@/lib/predict/constants';

/**
 * Median, mean, spread and trend over integer cents, PURE (MUST-2.1). Imported by the
 * Budgets client to format a suggestion label, so the Ruling P4 client-bundle constraint
 * applies: no @/db, no @/lib/env, no node builtin, no new Date().
 */

/**
 * Half away from zero. divRound(5, 2) === 3; divRound(-5, 2) === -3 (MUST-3.3).
 *
 * Implemented on absolute values with the sign applied once at the end, because
 * Math.round(-2.5) in JavaScript is -2: that would round a refund-heavy median toward zero
 * and a spend-heavy one away from it, inside the same function.
 *
 * The 2 * a + b form keeps the whole computation in integers (MUST-3.5). The largest
 * intermediate this release can produce is a month's cents times 31, doubled, which is far
 * inside Number.MAX_SAFE_INTEGER.
 */
export function divRound(numerator: number, denominator: number): number {
  if (denominator === 0) throw new Error('divRound: denominator must not be zero');
  const sign = (numerator < 0 ? -1 : 1) * (denominator < 0 ? -1 : 1);
  const a = Math.abs(numerator);
  const b = Math.abs(denominator);
  return sign * Math.floor((2 * a + b) / (2 * b));
}

/**
 * Rounds a non-negative cents value up to the next whole dollar (MUST-3.4). Applied exactly
 * once, as the last step of the suggestion, because nobody types a budget of $247.36.
 *
 * Throws on a negative input rather than guessing which direction "up" means there.
 */
export function ceilToDollar(cents: number): number {
  if (cents < 0) throw new Error('ceilToDollar: negative input');
  return Math.ceil(cents / 100) * 100;
}

/** MUST-5.1. The input array is copied before sorting and is never mutated. */
export function medianCents(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  if (sorted.length % 2 === 1) return sorted[mid];
  return divRound(sorted[mid - 1] + sorted[mid], 2);
}

/** MUST-5.3. Plain integer accumulation, matching sumCents() in src/lib/money.ts. */
export function meanCents(values: number[]): number | null {
  if (values.length === 0) return null;
  let sum = 0;
  for (const value of values) sum += value;
  return divRound(sum, values.length);
}

/** MUST-5.9. Feeds only the confidence label, never the suggested amount. */
export function spreadCents(values: number[]): number | null {
  if (values.length === 0) return null;
  return Math.max(...values) - Math.min(...values);
}

export type TrendDirection = 'rising' | 'falling' | 'flat' | 'unknown';

export interface Trend {
  direction: TrendDirection;
  deltaCents: number;
}

/**
 * MUST-5.4. Two halves of three months compared by mean, and that is the whole method.
 *
 * MUST-5.5: there is no linear regression, no exponential smoothing and no seasonal
 * decomposition. Six points cannot support one, and a slope fitted to six household months
 * would be presented with more authority than it has earned.
 *
 * The window is capped at six months by historyMonths() (MUST-4.5), so anything other than
 * exactly six values has no even split to compare and reports 'unknown'.
 */
export function trendOf(values: number[]): Trend {
  if (values.length !== 6) return { direction: 'unknown', deltaCents: 0 };
  const recent = meanCents(values.slice(3));
  const prior = meanCents(values.slice(0, 3));
  if (recent === null || prior === null) return { direction: 'unknown', deltaCents: 0 };
  const deltaCents = recent - prior;
  const threshold = Math.max(TREND_MIN_ABS_CENTS, divRound(Math.abs(prior) * TREND_MIN_PCT, 100));
  if (deltaCents >= threshold) return { direction: 'rising', deltaCents };
  if (deltaCents <= -threshold) return { direction: 'falling', deltaCents };
  return { direction: 'flat', deltaCents };
}

import { addMonths, monthRange, monthsBetween } from '@/lib/dates';
import { HISTORY_MONTHS, SEASONAL_MIN_MONTHS } from '@/lib/predict/constants';

/**
 * The history window and its month arithmetic, PURE (MUST-2.1). Month keys are 'YYYY-MM'
 * TEXT, so a lexical comparison is a chronological one and no Date is ever constructed.
 */

/**
 * MUST-4.1 / MUST-4.2 / MUST-4.5: the last HISTORY_MONTHS full calendar months ending
 * immediately before the target. The current, partial month is never in the window: a month
 * with eleven days in it is not a month, and including it would drag every median down at
 * the start of every month and up at the end of it.
 *
 * MUST-4.3 (the clip): the window is intersected with the months at or after the
 * household's first data month. Without it every median on a new install is zero, because
 * the window would be padded with months the household did not exist for.
 */
export function historyMonths(input: { targetMonth: string; firstDataMonth: string | null }): string[] {
  if (input.firstDataMonth === null) return [];
  const months = monthRange(addMonths(input.targetMonth, -HISTORY_MONTHS), addMonths(input.targetMonth, -1));
  return months.filter((month) => month >= input.firstDataMonth!);
}

/**
 * MUST-5.6 conditions 1, 2 and 3. Condition 4 (a strictly positive 12-month mean) is per
 * category and lives in seasonalFactor().
 *
 * Condition 3 requires the whole 12 months ending at A = target - 12 to be covered, which is
 * 23 months of history and therefore subsumes condition 1's 15. Both are checked because the
 * spec states all of them as binding, and because gating the seasonalReference() query on
 * this function is then at least as tight as MUST-4.11 requires.
 */
export function seasonalApplies(input: { targetMonth: string; firstDataMonth: string | null }): boolean {
  if (input.firstDataMonth === null) return false;
  if (monthsBetween(input.firstDataMonth, input.targetMonth) < SEASONAL_MIN_MONTHS) return false;
  const referenceMonth = addMonths(input.targetMonth, -12);
  if (referenceMonth < input.firstDataMonth) return false;
  return addMonths(referenceMonth, -11) >= input.firstDataMonth;
}

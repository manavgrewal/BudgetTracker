import { PACE_MIN_DAY_OF_MONTH } from '@/lib/predict/constants';
import { divRound } from '@/lib/predict/stats';

/**
 * The mid-month pace projection, PURE (MUST-2.1). Three integers in, one integer out.
 *
 * MUST-8.6: there is no day-of-week weighting, no weekend adjustment and no known-upcoming
 * recurring-charge term. A household that pays rent on the 1st sees a high projection on the
 * 7th and a truthful one by the 20th, and the UI says the projection assumes the rest of the
 * month looks like the part already spent. An explanation is cheaper than a model.
 */
export function projectMonthEnd(input: {
  spentCents: number;
  /** 1..31, the day in the app's TZ. */
  dayOfMonth: number;
  /** 28..31, from monthEnd(month). */
  daysInMonth: number;
}): number | null {
  // MUST-8.4: a null projection is never displayed and never notified.
  if (input.dayOfMonth < PACE_MIN_DAY_OF_MONTH) return null;
  // MUST-8.5: a net-refunded month is not projected into a negative month end, and can
  // therefore never trigger an overshoot.
  if (input.spentCents <= 0) return 0;
  // MUST-8.3: the divisor is the day number itself, not dayOfMonth - 1. A transaction dated
  // today is already in spentCents, so on the 10th there are ten days of spending. Off by one
  // here is a 10 percent error on the 10th.
  return divRound(input.spentCents * input.daysInMonth, input.dayOfMonth);
}

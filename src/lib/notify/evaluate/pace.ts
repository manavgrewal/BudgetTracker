import { budgetProgress, type BudgetRow } from '@/lib/budgets';
import { currentMonth, monthEnd, todayIso } from '@/lib/dates';
import { isEventEnabled } from '@/lib/notify/config';
import { CHANNELS, budgetPaceKey, type BudgetScopeKey } from '@/lib/notify/events';
import { enqueue } from '@/lib/notify/outbox';
import { renderEvent } from '@/lib/notify/render';
import { PACE_MAX_PER_EVALUATION, PACE_MIN_DAY_OF_MONTH, PACE_OVERSHOOT_MIN_PCT } from '@/lib/predict/constants';
import { projectMonthEnd } from '@/lib/predict/pace';

/**
 * MUST-10.8: no fingerprint. This runs at most once per user per day by construction, and its
 * dedup key makes a second run inside the catch-up window a no-op.
 *
 * budget.ts has an identical private flatten(). Spec section 2.2's file table is exhaustive
 * and does not list budget.ts, so the shared copy lives here and monthly.ts imports it.
 */
export function flattenBudgetRows(rows: BudgetRow[], acc: BudgetRow[] = []): BudgetRow[] {
  for (const row of rows) {
    acc.push(row);
    if (row.children.length > 0) flattenBudgetRows(row.children, acc);
  }
  return acc;
}

/** One row that cleared every fire condition except the per-evaluation cap. */
interface PaceCandidate {
  scope: BudgetScopeKey;
  row: BudgetRow;
  projectedCents: number;
  /** How far over the limit the projection lands. Sorting on this picks the worst overshoots. */
  overshootCents: number;
}

/**
 * MEDIUM fix (final-fix-wave item 3): the fire conditions only, with no enqueue. Split out so
 * evaluateBudgetPace can collect every qualifying row across both scopes before deciding which
 * ones to send, the same shape findUnusual/findDuplicates/creepVerdict already use for their own
 * MAX_PER_EVALUATION caps.
 */
function candidateFor(input: {
  scope: BudgetScopeKey;
  row: BudgetRow;
  dayOfMonth: number;
  daysInMonth: number;
}): PaceCandidate | null {
  const { row } = input;
  // Condition 2: a zero limit is budget_exceeded's business, not a projection's.
  if (row.limitCents === null || row.limitCents <= 0) return null;
  // Condition 3: a budget already blown is budget_exceeded's message. The two are mutually
  // exclusive by construction, not by ordering.
  if (row.spentCents > row.limitCents) return null;

  // MUST-8.7: spentCents is the number already on the progress bar, not a re-query.
  const projectedCents = projectMonthEnd({
    spentCents: row.spentCents,
    dayOfMonth: input.dayOfMonth,
    daysInMonth: input.daysInMonth,
  });
  if (projectedCents === null) return null;
  // Condition 4: a projected 3 percent overshoot on the 7th is noise; 10 percent is a number
  // worth acting on. Integer comparison, no float ratio (MUST-3.5).
  if (projectedCents * 100 < row.limitCents * PACE_OVERSHOOT_MIN_PCT) return null;

  return { scope: input.scope, row, projectedCents, overshootCents: projectedCents - row.limitCents };
}

function enqueuePaceCandidate(input: { userId: number; month: string; dayOfMonth: number; now: Date; candidate: PaceCandidate }): number {
  const { candidate } = input;
  const { subject, body } = renderEvent({
    event: 'budget_pace',
    scope: candidate.scope,
    categoryName: candidate.row.categoryName,
    month: input.month,
    // limitCents is non-null by construction: candidateFor() already refused a null one.
    limitCents: candidate.row.limitCents as number,
    spentCents: candidate.row.spentCents,
    dayOfMonth: input.dayOfMonth,
    projectedCents: candidate.projectedCents,
  });
  const result = enqueue({
    userId: input.userId,
    eventId: 'budget_pace',
    dedupKey: budgetPaceKey(candidate.scope, candidate.row.categoryId, input.month),
    subject,
    body,
    at: input.now,
  });
  return result.inserted.length > 0 ? 1 : 0;
}

/**
 * MUST-9.6: the user's daily slot, the CURRENT MONTH only, over the same two scopes
 * evaluateBudgets() walks. Household rows are delivered to every user with the event enabled
 * (this function is called once per user, so that happens across calls); personal rows are
 * evaluated per user and delivered only to that user.
 *
 * MEDIUM fix (final-fix-wave item 3): capped at PACE_MAX_PER_EVALUATION, largest overshoot
 * first, mirroring UNUSUAL_MAX_PER_EVALUATION / CREEP_MAX_PER_EVALUATION /
 * DUPLICATE_MAX_PER_EVALUATION. Without it, day 7 of a 31-day month fires the moment spend
 * reaches 24.8 percent of the limit, which roughly half of all budgeted categories clear on
 * the very first day the projection is allowed to run.
 */
export function evaluateBudgetPace(input: { userId: number; now: Date; tz: string }): number {
  if (!CHANNELS.some((channel) => isEventEnabled(input.userId, 'budget_pace', channel))) return 0;

  const today = todayIso(input.now, input.tz);
  const dayOfMonth = Number(today.slice(8, 10));
  // MUST-9.6 condition 1, checked before any query.
  if (dayOfMonth < PACE_MIN_DAY_OF_MONTH) return 0;

  const month = currentMonth(input.now, input.tz);
  // MUST-8.2: from monthEnd, so February is 29 days in 2028 without a leap-year rule here.
  const daysInMonth = Number(monthEnd(month).slice(8, 10));

  const scopes: { scope: BudgetScopeKey; rows: BudgetRow[] }[] = [
    { scope: 'household', rows: flattenBudgetRows(budgetProgress(month, 'household', null)) },
    { scope: 'personal', rows: flattenBudgetRows(budgetProgress(month, 'personal', input.userId)) },
  ];

  const candidates: PaceCandidate[] = [];
  for (const { scope, rows } of scopes) {
    for (const row of rows) {
      const candidate = candidateFor({ scope, row, dayOfMonth, daysInMonth });
      if (candidate !== null) candidates.push(candidate);
    }
  }
  candidates.sort((a, b) => b.overshootCents - a.overshootCents);

  let fired = 0;
  for (const candidate of candidates.slice(0, PACE_MAX_PER_EVALUATION)) {
    fired += enqueuePaceCandidate({ userId: input.userId, month, dayOfMonth, now: input.now, candidate });
  }
  return fired;
}

import { budgetProgress, type BudgetRow } from '@/lib/budgets';
import { currentMonth, monthEnd, todayIso } from '@/lib/dates';
import { isEventEnabled } from '@/lib/notify/config';
import { CHANNELS, budgetPaceKey, type BudgetScopeKey } from '@/lib/notify/events';
import { enqueue } from '@/lib/notify/outbox';
import { renderEvent } from '@/lib/notify/render';
import { PACE_MIN_DAY_OF_MONTH, PACE_OVERSHOOT_MIN_PCT } from '@/lib/predict/constants';
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

function fireFor(input: {
  userId: number;
  scope: BudgetScopeKey;
  row: BudgetRow;
  month: string;
  dayOfMonth: number;
  daysInMonth: number;
  now: Date;
}): number {
  const { row } = input;
  // Condition 2: a zero limit is budget_exceeded's business, not a projection's.
  if (row.limitCents === null || row.limitCents <= 0) return 0;
  // Condition 3: a budget already blown is budget_exceeded's message. The two are mutually
  // exclusive by construction, not by ordering.
  if (row.spentCents > row.limitCents) return 0;

  // MUST-8.7: spentCents is the number already on the progress bar, not a re-query.
  const projected = projectMonthEnd({
    spentCents: row.spentCents,
    dayOfMonth: input.dayOfMonth,
    daysInMonth: input.daysInMonth,
  });
  if (projected === null) return 0;
  // Condition 4: a projected 3 percent overshoot on the 7th is noise; 10 percent is a number
  // worth acting on. Integer comparison, no float ratio (MUST-3.5).
  if (projected * 100 < row.limitCents * PACE_OVERSHOOT_MIN_PCT) return 0;

  const { subject, body } = renderEvent({
    event: 'budget_pace',
    scope: input.scope,
    categoryName: row.categoryName,
    month: input.month,
    limitCents: row.limitCents,
    spentCents: row.spentCents,
    dayOfMonth: input.dayOfMonth,
    projectedCents: projected,
  });
  const result = enqueue({
    userId: input.userId,
    eventId: 'budget_pace',
    dedupKey: budgetPaceKey(input.scope, row.categoryId, input.month),
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

  let fired = 0;
  const scopes: { scope: BudgetScopeKey; rows: BudgetRow[] }[] = [
    { scope: 'household', rows: flattenBudgetRows(budgetProgress(month, 'household', null)) },
    { scope: 'personal', rows: flattenBudgetRows(budgetProgress(month, 'personal', input.userId)) },
  ];
  for (const { scope, rows } of scopes) {
    for (const row of rows) {
      fired += fireFor({ userId: input.userId, scope, row, month, dayOfMonth, daysInMonth, now: input.now });
    }
  }
  return fired;
}

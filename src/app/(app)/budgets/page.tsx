import { requireUser } from '@/lib/auth/session';
import { listUsers } from '@/lib/auth/users';
import { budgetProgress, budgetTotals, type BudgetRow } from '@/lib/budgets';
import { currentMonth, isMonthKey, monthEnd, todayIso } from '@/lib/dates';
import { readEnv } from '@/lib/env';
import { flattenBudgetRows } from '@/lib/notify/evaluate/pace';
import { isAllNoSpend, suggestionsFor, type ScopeSuggestions } from '@/lib/predict/history';
import { projectMonthEnd } from '@/lib/predict/pace';
import type { BudgetPredictions, CategorySuggestion, SectionPredictions } from '@/lib/predict/suggest';
import { BudgetsClient } from './budgets-client';

export const dynamic = 'force-dynamic';

/**
 * MUST-8.7 and MUST-16.4: the projection reuses budgetProgress()'s own spentCents, so it adds
 * no query and can never disagree with the progress bar beside it.
 */
export function sectionFrom(
  scoped: ScopeSuggestions,
  rows: BudgetRow[],
  dayOfMonth: number,
  daysInMonth: number,
): SectionPredictions {
  const suggestions: CategorySuggestion[] = [];
  for (const [categoryId, result] of scoped.byCategory) {
    if (!('suggestion' in result)) continue;
    suggestions.push({ categoryId, ...result.suggestion });
  }
  const projections: { categoryId: number; projectedCents: number }[] = [];
  for (const row of flattenBudgetRows(rows)) {
    // LOW cleanup: an archived row is read-only and carries no suggestion slot, so a pace
    // line there would sit with nothing beside it.
    if (row.isArchived) continue;
    if (row.limitCents === null) continue;
    const projectedCents = projectMonthEnd({ spentCents: row.spentCents, dayOfMonth, daysInMonth });
    if (projectedCents === null) continue;
    projections.push({ categoryId: row.categoryId, projectedCents });
  }
  return { suggestions, projections, noAttribution: false };
}

export default async function BudgetsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser();
  const params = await searchParams;
  const raw = Array.isArray(params.month) ? params.month[0] : params.month;
  const month = raw && isMonthKey(raw) ? raw : currentMonth();

  const household = budgetProgress(month, 'household', null);
  const people = listUsers().filter((u) => u.isActive);
  const personal = people.map((person) => ({
    userId: person.id,
    name: person.name,
    rows: budgetProgress(month, 'personal', person.id),
  }));

  const { tz } = readEnv();
  const today = todayIso(new Date(), tz);
  const dayOfMonth = Number(today.slice(8, 10));
  const daysInMonth = Number(monthEnd(month).slice(8, 10));

  // MUST-14.1: computed ONLY when the viewed month is the current month. A pace projection for
  // July, viewed in August, is not a projection.
  let predictions: BudgetPredictions | null = null;
  if (month === currentMonth(new Date(), tz)) {
    // MUST-16.3 budgets this page at 2 + 2P grouped aggregates, so each scope is read ONCE.
    const householdScope = suggestionsFor({ targetMonth: month, scope: 'household', userId: null });
    const householdAllNoSpend = isAllNoSpend(householdScope.byCategory);
    predictions = {
      monthsUsed: householdScope.months.length,
      dayOfMonth,
      household: sectionFrom(householdScope, household, dayOfMonth, daysInMonth),
      personal: personal.map((person) => {
        const personalScope = suggestionsFor({ targetMonth: month, scope: 'personal', userId: person.userId });
        return {
          userId: person.userId,
          predictions: {
            ...sectionFrom(personalScope, person.rows, dayOfMonth, daysInMonth),
            // MUST-15.2 and MUST-7.2: derived from the HISTORICAL series suggestionsFor()
            // already computed, not from this month's budgetProgress() snapshot. The current
            // month is excluded from that series by construction (historyMonths), so this
            // holds regardless of whether the person has posted anything yet this month.
            noAttribution: isAllNoSpend(personalScope.byCategory) && !householdAllNoSpend,
          },
        };
      }),
    };
  }

  return (
    <BudgetsClient
      month={month}
      currentUserId={user.id}
      currentUserIsAdmin={user.role === 'admin'}
      household={household}
      householdTotals={budgetTotals(household)}
      personal={personal}
      predictions={predictions}
    />
  );
}

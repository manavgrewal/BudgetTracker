import { requireUser } from '@/lib/auth/session';
import { listUsers } from '@/lib/auth/users';
import { listCategories } from '@/lib/categories';
import { debtOverTime, listLoans } from '@/lib/loans';
import { categoryBreakdown, categoryMonthOverMonth, personSpendSplit } from '@/lib/reports';
import { monthOf, todayIso } from '@/lib/dates';
import { resolveRange } from '@/lib/date-range';
import { readEnv } from '@/lib/env';
import { suggestionsFor } from '@/lib/predict/history';
import type { BaselineRow } from '@/lib/predict/suggest';
import { ReportsClient } from './reports-client';

export const dynamic = 'force-dynamic';

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireUser();
  const params = await searchParams;
  const one = (key: string) => {
    const value = params[key];
    return Array.isArray(value) ? value[0] : value;
  };

  // MUST-11.4: the server resolves today, in the configured TZ, and hands it down. The client
  // never computes a date from the browser clock.
  const today = todayIso(new Date(), readEnv().tz);
  const range = resolveRange({
    preset: one('range'),
    from: one('from'),
    to: one('to'),
    today,
    fallback: 'last_6_months',
  })!; // non-null: the fallback is non-null
  const from = range.from;
  const to = range.to;
  const personRaw = one('person');
  const person = personRaw === 'unattributed' ? 'unattributed' : personRaw && /^\d+$/.test(personRaw) ? Number(personRaw) : null;

  // MUST-14.8: this card's window is the last 6 FULL calendar months, always, whatever the
  // picker says. MUST-16.5: one query, not one per category.
  //
  // MUST-11.4: the month comes from the `today` Task 11 already resolved in the app's TZ, NOT
  // from a bare currentMonth(). Near a month boundary a container-local month would make this
  // card and the picker directly above it disagree about what month it is.
  const baseline = suggestionsFor({ targetMonth: monthOf(today), scope: 'household', userId: null });
  // MUST-14.7 and F19: TOP-LEVEL categories only. categorySeries mirrors budgetProgress, so it
  // also produces a row for each child; listing Food beside Groceries, whose medians overlap by
  // construction, would read as double counting on a card that has no indentation to explain it.
  const topLevelNames = new Map(
    listCategories({ includeArchived: true })
      .filter((category) => category.parentId === null)
      .map((category) => [category.id, category.name] as const),
  );
  const baselines: BaselineRow[] = [];
  for (const [categoryId, result] of baseline.byCategory) {
    if (!('suggestion' in result)) continue;
    const categoryName = topLevelNames.get(categoryId);
    if (categoryName === undefined) continue;
    baselines.push({ categoryId, categoryName, suggestion: result.suggestion });
  }
  baselines.sort((a, b) => b.suggestion.medianCents - a.suggestion.medianCents);

  return (
    <ReportsClient
      range={range}
      today={today}
      person={personRaw ?? ''}
      people={listUsers().map((u) => ({ id: u.id, name: u.name }))}
      breakdown={categoryBreakdown({ from, to, attributedUserId: person, rollup: true })}
      monthOverMonth={categoryMonthOverMonth({ fromMonth: from.slice(0, 7), toMonth: to.slice(0, 7), attributedUserId: person, limit: 10 })}
      split={personSpendSplit({ from, to })}
      debt={debtOverTime(24)}
      hasLoans={listLoans().some((loan) => loan.currentBalanceCents !== null)}
      baselines={baselines}
      baselineMonthsUsed={baseline.months.length}
    />
  );
}

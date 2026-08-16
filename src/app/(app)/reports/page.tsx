import { requireUser } from '@/lib/auth/session';
import { listUsers } from '@/lib/auth/users';
import { categoryBreakdown, categoryMonthOverMonth, personSpendSplit } from '@/lib/reports';
import { currentMonth, isIsoDate, monthEnd, monthStart, addMonths } from '@/lib/dates';
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

  const month = currentMonth();
  const from = one('from') && isIsoDate(one('from')!) ? one('from')! : monthStart(addMonths(month, -5));
  const to = one('to') && isIsoDate(one('to')!) ? one('to')! : monthEnd(month);
  const personRaw = one('person');
  const person = personRaw === 'unattributed' ? 'unattributed' : personRaw && /^\d+$/.test(personRaw) ? Number(personRaw) : null;

  return (
    <ReportsClient
      from={from}
      to={to}
      person={personRaw ?? ''}
      people={listUsers().map((u) => ({ id: u.id, name: u.name }))}
      breakdown={categoryBreakdown({ from, to, attributedUserId: person, rollup: true })}
      monthOverMonth={categoryMonthOverMonth({ fromMonth: from.slice(0, 7), toMonth: to.slice(0, 7), attributedUserId: person, limit: 10 })}
      split={personSpendSplit({ from, to })}
    />
  );
}

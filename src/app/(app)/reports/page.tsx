import { requireUser } from '@/lib/auth/session';
import { listUsers } from '@/lib/auth/users';
import { debtOverTime, listLoans } from '@/lib/loans';
import { categoryBreakdown, categoryMonthOverMonth, personSpendSplit } from '@/lib/reports';
import { todayIso } from '@/lib/dates';
import { resolveRange } from '@/lib/date-range';
import { readEnv } from '@/lib/env';
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
    />
  );
}

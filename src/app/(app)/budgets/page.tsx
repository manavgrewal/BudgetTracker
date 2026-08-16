import { requireUser } from '@/lib/auth/session';
import { listUsers } from '@/lib/auth/users';
import { budgetProgress, budgetTotals } from '@/lib/budgets';
import { currentMonth, isMonthKey } from '@/lib/dates';
import { BudgetsClient } from './budgets-client';

export const dynamic = 'force-dynamic';

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

  return (
    <BudgetsClient
      month={month}
      currentUserId={user.id}
      currentUserIsAdmin={user.role === 'admin'}
      household={household}
      householdTotals={budgetTotals(household)}
      personal={personal}
    />
  );
}

import Link from 'next/link';
import { requireUser } from '@/lib/auth/session';
import { listAccounts } from '@/lib/accounts';
import { listUsers } from '@/lib/auth/users';
import { budgetProgress, budgetTotals } from '@/lib/budgets';
import { reviewQueueCount } from '@/lib/categorize/engine';
import { currentMonth, monthEnd, monthStart, todayIso } from '@/lib/dates';
import { listGoals } from '@/lib/goals';
import { cashflowTrend, topMerchants } from '@/lib/reports';
import { expiringSoonItems } from '@/lib/warranty/search';
import { formatCents } from '@/lib/money';
import { BudgetProgressBar } from '@/components/BudgetProgressBar';
import { GoalCard } from '@/components/GoalCard';
import { CashflowChart } from '@/components/charts/CashflowChart';
import { ExpiringSoonCard, EXPIRING_WIDGET_LIMIT } from '@/components/warranty/ExpiringSoonCard';

export const dynamic = 'force-dynamic';

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser();
  const params = await searchParams;
  const raw = Array.isArray(params.person) ? params.person[0] : params.person;
  const scopeUserId = raw && /^\d+$/.test(raw) ? Number(raw) : null;

  const month = currentMonth();
  const rows = scopeUserId === null ? budgetProgress(month) : budgetProgress(month, 'personal', scopeUserId);
  const totals = budgetTotals(rows);
  const trend = cashflowTrend(12, { endMonth: month, attributedUserId: scopeUserId });
  const merchants = topMerchants({ from: monthStart(month), to: monthEnd(month), limit: 8, attributedUserId: scopeUserId });
  const goals = listGoals();
  const reviewCount = reviewQueueCount();
  const people = listUsers().filter((u) => u.isActive);
  // Nothing can be imported until at least one account exists, and a fresh
  // install has none — so say so here rather than letting the Import page
  // dead-end.
  const hasAccounts = listAccounts().length > 0;

  // MUST-10.6: the widget respects the dashboard's existing person switcher — Household
  // shows every item, a selected person shows only items they own.
  const today = todayIso();
  const expiring = expiringSoonItems(EXPIRING_WIDGET_LIMIT, scopeUserId, today);

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">Hello, {user.name}</h1>
        <nav className="flex flex-wrap gap-2 text-sm">
          <Link href="/dashboard" className={scopeUserId === null ? 'font-medium underline' : 'underline'}>Household</Link>
          {people.map((person) => (
            <Link key={person.id} href={`/dashboard?person=${person.id}`} className={scopeUserId === person.id ? 'font-medium underline' : 'underline'}>
              {person.name}
            </Link>
          ))}
        </nav>
      </div>

      {!hasAccounts ? (
        user.role === 'admin' ? (
          <Link href="/settings/accounts" className="w-fit rounded bg-sky-100 px-3 py-2 text-sm dark:bg-sky-950">
            Add your bank accounts to get started
          </Link>
        ) : (
          // Only admins can create accounts, so pointing a member at a page
          // that would bounce them straight back here helps nobody.
          <p className="w-fit rounded bg-sky-100 px-3 py-2 text-sm dark:bg-sky-950">
            No bank accounts yet — ask an admin to add them to get started.
          </p>
        )
      ) : null}

      {reviewCount > 0 ? (
        <Link href="/review" className="w-fit rounded bg-amber-100 px-3 py-2 text-sm dark:bg-amber-950">
          {reviewCount} transactions need review
        </Link>
      ) : null}

      <ExpiringSoonCard items={expiring} today={today} />

      <section className="flex flex-col gap-2">
        <h2 className="font-medium">
          {month} budgets — {formatCents(totals.totalSpentCents)} spent
        </h2>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          {formatCents(totals.budgetedSpentCents)} of {formatCents(totals.budgetedLimitCents)} budgeted
        </p>
        <table className="w-full text-left text-sm">
          <tbody>
            {rows
              .filter((row) => !row.isIncome && (row.limitCents !== null || row.spentCents !== 0))
              .map((row) => (
                <tr key={row.categoryId} className="border-b border-slate-100 dark:border-slate-900">
                  <td className="py-2">{row.categoryName}</td>
                  <td className="w-1/2"><BudgetProgressBar limitCents={row.limitCents} spentCents={row.spentCents} label={row.categoryName} /></td>
                  <td className="text-right tabular-nums">
                    {formatCents(row.spentCents)}{row.limitCents === null ? '' : ` / ${formatCents(row.limitCents)}`}
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="font-medium">12-month cashflow (transfers excluded)</h2>
        <CashflowChart data={trend} />
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="font-medium">Top merchants this month</h2>
        <ul className="text-sm">
          {merchants.map((merchant) => (
            <li key={merchant.normalizedMerchant} className="flex justify-between border-b border-slate-100 py-1 dark:border-slate-900">
              <span>{merchant.normalizedMerchant} ({merchant.count})</span>
              <span className="tabular-nums">{formatCents(merchant.spentCents)}</span>
            </li>
          ))}
        </ul>
      </section>

      {goals.length > 0 ? (
        <section className="flex flex-col gap-2">
          <h2 className="font-medium">Goals</h2>
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {goals.map((goal) => (
              <GoalCard key={goal.id} goal={goal} />
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

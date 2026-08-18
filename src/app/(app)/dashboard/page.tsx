import Link from 'next/link';
import { requireUser } from '@/lib/auth/session';
import { listAccounts } from '@/lib/accounts';
import { listUsers } from '@/lib/auth/users';
import { budgetProgress, budgetTotals } from '@/lib/budgets';
import { reviewQueueCount } from '@/lib/categorize/engine';
import { currentMonth, monthEnd, monthLabel, monthStart, todayIso } from '@/lib/dates';
import { listGoals } from '@/lib/goals';
import { listLoans, loansTotalOwedCents } from '@/lib/loans';
import { cashflowTrend, topMerchants } from '@/lib/reports';
import { expiringSoonItems } from '@/lib/warranty/search';
import { formatCents } from '@/lib/money';
import { BudgetProgressBar } from '@/components/BudgetProgressBar';
import { GoalCard } from '@/components/GoalCard';
import { LoansCard } from '@/components/LoansCard';
import { CashflowChart } from '@/components/charts/CashflowChart';
import { AlertIcon, ArrowRightIcon, InfoIcon } from '@/components/icons';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { PageHeader } from '@/components/ui/PageHeader';
import { StatTile } from '@/components/ui/StatTile';
import { TableWrap } from '@/components/ui/Table';
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

  // The trend already covers this month, so the headline income/net figures come
  // out of it rather than costing a second query.
  const thisMonth = trend.find((row) => row.month === month);
  const incomeCents = thisMonth?.incomeCents ?? 0;
  const netCents = thisMonth?.netCents ?? incomeCents - totals.totalSpentCents;

  const budgetRows = rows.filter((row) => !row.isIncome && (row.limitCents !== null || row.spentCents !== 0));
  const scopedPerson = scopeUserId === null ? null : people.find((person) => person.id === scopeUserId);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow={monthLabel(month)}
        title={`Hello, ${user.name}`}
        description={
          scopedPerson
            ? `${scopedPerson.name}'s share of the month.`
            : 'Everything the household spent and brought in this month.'
        }
        actions={
          <nav aria-label="Whose money to show" className="flex flex-wrap items-center gap-1 rounded-full border border-line bg-surface-2 p-1">
            <PersonPill href="/dashboard" label="Household" active={scopeUserId === null} />
            {people.map((person) => (
              <PersonPill
                key={person.id}
                href={`/dashboard?person=${person.id}`}
                label={person.name}
                active={scopeUserId === person.id}
              />
            ))}
          </nav>
        }
      />

      {!hasAccounts ? (
        user.role === 'admin' ? (
          <CalloutLink href="/settings/accounts" tone="info">
            Add your bank accounts to get started
          </CalloutLink>
        ) : (
          // Only admins can create accounts, so pointing a member at a page
          // that would bounce them straight back here helps nobody.
          <div
            role="status"
            className="flex items-center gap-2.5 rounded-md bg-info-soft px-3.5 py-3 text-sm text-info-soft-fg"
          >
            <InfoIcon className="h-4 w-4 shrink-0" />
            No bank accounts yet — ask an admin to add them to get started.
          </div>
        )
      ) : null}

      {reviewCount > 0 ? (
        <CalloutLink href="/review" tone="warning">
          {reviewCount} transactions need review
        </CalloutLink>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          className="sm:col-span-2"
          emphasis
          label="Spent this month"
          value={formatCents(totals.totalSpentCents)}
          hint={
            totals.budgetedLimitCents > 0
              ? `${formatCents(totals.budgetedSpentCents)} of ${formatCents(totals.budgetedLimitCents)} budgeted`
              : 'No category limits set yet'
          }
          footer={
            totals.budgetedLimitCents > 0 ? (
              <BudgetProgressBar
                limitCents={totals.budgetedLimitCents}
                spentCents={totals.budgetedSpentCents}
                label="Budgeted spend this month"
              />
            ) : null
          }
        />
        <StatTile label="Money in" value={formatCents(incomeCents)} tone="positive" hint="Transfers excluded" />
        <StatTile
          label="Net this month"
          value={formatCents(netCents, { showSign: true })}
          tone={netCents < 0 ? 'negative' : 'positive'}
          hint={netCents < 0 ? 'Spending outran income' : 'Kept, after everything went out'}
        />
      </div>

      <ExpiringSoonCard items={expiring} today={today} />

      {/* MUST-15.1: self-hiding. Rendered unconditionally; absent when there is nothing to say. */}
      <LoansCard loans={listLoans(today)} totalOwedCents={loansTotalOwedCents()} />

      <Card>
        <CardHeader
          title={`${monthLabel(month)} budgets`}
          description={
            totals.budgetedLimitCents > 0
              ? `${formatCents(totals.budgetedSpentCents)} of ${formatCents(totals.budgetedLimitCents)} budgeted · ${formatCents(totals.totalSpentCents)} spent in total`
              : `${formatCents(totals.totalSpentCents)} spent in total`
          }
          action={
            <Link href="/budgets" className="btn btn--ghost btn--sm text-accent-text hover:text-accent-text">
              Set limits
              <ArrowRightIcon className="h-4 w-4" />
            </Link>
          }
        />
        {budgetRows.length === 0 ? (
          <CardBody>
            <p className="rounded-md border border-dashed border-line-strong px-4 py-8 text-center text-sm text-muted">
              Nothing spent yet this month. Import a statement and the categories will fill in here.
            </p>
          </CardBody>
        ) : (
          <TableWrap bare className="border-t border-line">
            <thead>
              <tr>
                <th scope="col">Category</th>
                <th scope="col" className="w-1/2">
                  Progress
                </th>
                <th scope="col" className="text-right">
                  Spent
                </th>
              </tr>
            </thead>
            <tbody>
              {budgetRows.map((row) => (
                <tr key={row.categoryId}>
                  <td className="font-medium text-ink">{row.categoryName}</td>
                  <td>
                    <BudgetProgressBar limitCents={row.limitCents} spentCents={row.spentCents} label={row.categoryName} />
                  </td>
                  <td className="money text-right whitespace-nowrap">
                    {formatCents(row.spentCents)}
                    {row.limitCents === null ? null : (
                      <span className="text-subtle"> / {formatCents(row.limitCents)}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}
      </Card>

      <div className="grid gap-5 lg:grid-cols-5">
        <Card className="lg:col-span-3">
          <CardHeader title="12-month cashflow" description="Transfers excluded." />
          <CardBody>
            <CashflowChart data={trend} />
          </CardBody>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader title="Top merchants" description={`Where the money went in ${monthLabel(month)}.`} />
          {merchants.length === 0 ? (
            <CardBody>
              <p className="rounded-md border border-dashed border-line-strong px-4 py-8 text-center text-sm text-muted">
                No transactions this month yet.
              </p>
            </CardBody>
          ) : (
            <ul className="border-t border-line text-sm">
              {merchants.map((merchant) => (
                <li
                  key={merchant.normalizedMerchant}
                  className="flex items-baseline justify-between gap-4 border-b border-line px-5 py-2.5 last:border-b-0 sm:px-6"
                >
                  <span className="min-w-0 truncate text-ink">
                    {merchant.normalizedMerchant} <span className="text-subtle">({merchant.count})</span>
                  </span>
                  <span className="money shrink-0">{formatCents(merchant.spentCents)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {goals.length > 0 ? (
        <section className="flex flex-col gap-3">
          <h2 className="text-base font-semibold text-ink">Goals</h2>
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

function PersonPill({ href, label, active }: { href: string; label: string; active: boolean }) {
  return (
    <Link
      href={href}
      aria-current={active ? 'true' : undefined}
      className={`rounded-full px-3 py-1 text-sm transition-colors ${
        active ? 'bg-surface font-semibold text-ink shadow-flat' : 'font-medium text-muted hover:text-ink'
      }`}
    >
      {label}
    </Link>
  );
}

/** A banner that is also the way to act on what it says. */
function CalloutLink({
  href,
  tone,
  children,
}: {
  href: string;
  tone: 'info' | 'warning';
  children: React.ReactNode;
}) {
  const wrap =
    tone === 'warning' ? 'bg-warning-soft text-warning-soft-fg' : 'bg-info-soft text-info-soft-fg';
  const Icon = tone === 'warning' ? AlertIcon : InfoIcon;
  return (
    <Link
      href={href}
      className={`flex items-center gap-2.5 rounded-md px-3.5 py-3 text-sm font-medium transition-opacity hover:opacity-90 ${wrap}`}
    >
      <Icon className="h-4 w-4 shrink-0" />
      {children}
      <ArrowRightIcon className="ml-auto h-4 w-4 shrink-0" />
    </Link>
  );
}

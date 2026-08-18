'use client';

import { CategoryBarChart } from '@/components/charts/CategoryBarChart';
import { DebtTrendChart } from '@/components/charts/DebtTrendChart';
import { LoanIcon, ReportsIcon, TrendDownIcon, TrendFlatIcon, TrendUpIcon } from '@/components/icons';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Money } from '@/components/ui/Money';
import { PageHeader } from '@/components/ui/PageHeader';
import { AmountCell, TableWrap } from '@/components/ui/Table';
import { Field, selectClass } from '@/components/ui/form';
import { DateRangePicker } from '@/components/ui/DateRangePicker';
import { rangeParams, type ResolvedRange } from '@/lib/date-range';
import type { DebtPoint } from '@/lib/loans';
import { formatCents } from '@/lib/money';
import type { BaselineRow } from '@/lib/predict/suggest';
import type { CategoryBreakdownRow, CategoryMonthTrend, PersonSplitRow } from '@/lib/reports';

export function ReportsClient({
  range,
  today,
  person,
  people,
  breakdown,
  monthOverMonth,
  split,
  debt,
  hasLoans,
  baselines,
  baselineMonthsUsed,
}: {
  range: ResolvedRange;
  today: string;
  person: string;
  people: { id: number; name: string }[];
  breakdown: CategoryBreakdownRow[];
  monthOverMonth: { months: string[]; rows: CategoryMonthTrend[] };
  split: PersonSplitRow[];
  debt: DebtPoint[];
  hasLoans: boolean;
  baselines: BaselineRow[];
  baselineMonthsUsed: number;
}) {
  const exportHref = `/api/reports/export?${new URLSearchParams({
    ...rangeParams(range),
    ...(person ? { person } : {}),
  }).toString()}`;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow={range.label}
        title="Reports"
        description="Where the money went over a stretch of time, by category and by person."
        actions={
          <a href={exportHref} className="btn btn--secondary">
            Export CSV
          </a>
        }
      />

      <Card>
        <CardBody className="pt-5">
          <form method="get" className="flex flex-wrap items-end gap-3">
            <DateRangePicker value={range.preset} from={range.from} to={range.to} today={today} />
            <Field label="Person">
              <select name="person" defaultValue={person} className={selectClass}>
                <option value="">Everyone</option>
                <option value="unattributed">Household/unattributed</option>
                {people.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </Field>
            <button type="submit" className="btn btn--primary">Apply</button>
          </form>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Category baselines"
          description="Median and average over the last 6 full calendar months. This card does not follow the date filter above: a median needs equal-length months, and an arbitrary range does not have them."
        />
        <CardBody padded={false}>
          {baselineMonthsUsed < 3 || baselines.length === 0 ? (
            <EmptyState icon={ReportsIcon} title="Not enough history yet">
              Baselines appear after three full calendar months.
            </EmptyState>
          ) : (
            <TableWrap bare>
              <thead>
                <tr>
                  <th>Category</th>
                  <th className="text-right">Median</th>
                  <th className="text-right">Average</th>
                  <th>Trend</th>
                  <th className="text-right">Suggested</th>
                </tr>
              </thead>
              <tbody>
                {baselines.map((row) => (
                  <tr key={row.categoryId}>
                    <td>{row.categoryName}</td>
                    <AmountCell>
                      <Money cents={row.suggestion.medianCents} plain />
                    </AmountCell>
                    <AmountCell>
                      <Money cents={row.suggestion.meanCents} plain />
                    </AmountCell>
                    <td>
                      <span className="flex items-center gap-1.5 text-xs text-muted">
                        {row.suggestion.trend.direction === 'rising' ? <TrendUpIcon className="h-4 w-4" /> : null}
                        {row.suggestion.trend.direction === 'falling' ? <TrendDownIcon className="h-4 w-4" /> : null}
                        {row.suggestion.trend.direction === 'flat' ? <TrendFlatIcon className="h-4 w-4" /> : null}
                        {row.suggestion.trend.direction === 'unknown'
                          ? null
                          : `${row.suggestion.trend.direction === 'rising' ? 'Rising' : row.suggestion.trend.direction === 'falling' ? 'Falling' : 'Flat'} ${formatCents(Math.abs(row.suggestion.trend.deltaCents), { currency: true })}`}
                      </span>
                    </td>
                    <AmountCell>
                      <Money cents={row.suggestion.suggestedCents} plain />
                    </AmountCell>
                  </tr>
                ))}
              </tbody>
            </TableWrap>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Category breakdown" description="Net spend per category over the range." />
        {breakdown.length === 0 ? (
          <EmptyState icon={ReportsIcon} title="Nothing spent in this range">
            Widen the dates, or import the statements that cover them.
          </EmptyState>
        ) : (
          <CardBody>
            <CategoryBarChart data={breakdown} />
          </CardBody>
        )}
      </Card>

      <Card>
        <CardHeader title="Month over month" description="The same categories, month by month." />
        {monthOverMonth.rows.length === 0 ? (
          <EmptyState icon={ReportsIcon} title="No months to compare yet" />
        ) : (
          <TableWrap bare>
            <thead>
              <tr>
                <th scope="col">Category</th>
                {monthOverMonth.months.map((month) => (
                  <th scope="col" key={month} className="text-right">{month}</th>
                ))}
                <th scope="col" className="text-right">Total</th>
              </tr>
            </thead>
            <tbody>
              {monthOverMonth.rows.map((row) => (
                <tr key={row.categoryId}>
                  <td className="whitespace-nowrap font-medium text-ink">{row.categoryName}</td>
                  {monthOverMonth.months.map((month) => (
                    <td key={month} className="text-right text-muted">
                      {formatOrDash(row.byMonth[month] ?? 0)}
                    </td>
                  ))}
                  <td className="text-right font-semibold">
                    <Money cents={row.totalCents} plain />
                  </td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}
      </Card>

      <Card>
        <CardHeader title="Who spent it" description="Split by the person each transaction is attributed to." />
        {split.length === 0 ? (
          <EmptyState icon={ReportsIcon} title="Nothing to split yet" />
        ) : (
          <ul className="border-t border-line text-sm">
            {split.map((row) => (
              <li
                key={row.userId ?? 'unattributed'}
                className="flex items-center justify-between gap-4 border-b border-line px-5 py-2.5 last:border-b-0 sm:px-6"
              >
                <span>{row.label}</span>
                <Money cents={row.spentCents} plain />
              </li>
            ))}
          </ul>
        )}
      </Card>

      {!hasLoans ? null : (
        <Card>
          <CardHeader title="Debt over time" description="Total owed across every loan with a balance." />
          {/* Review fix-round: gated on "fewer than two" rather than "every point null" -- a
              single non-null point (the common first-run shape, one anchor amid 23 NULLs)
              draws no visible line either, so it belongs here rather than in a chart with
              nothing to show. This also retires what was otherwise a dead branch, since the
              current month is always non-null once the card renders at all. */}
          {debt.filter((point) => point.owedCents !== null).length < 2 ? (
            <EmptyState icon={LoanIcon} title="Not enough history yet">
              The chart appears after a month of tracked activity.
            </EmptyState>
          ) : (
            <CardBody className="flex flex-col gap-3">
              <DebtTrendChart data={debt} />
              {/* MUST-15.6: always visible, because a reader is entitled to know where a line comes from. */}
              <p className="text-sm text-muted">
                The line starts when you first recorded a balance for each loan, and is reconstructed by adding back the
                payments you have linked since.
              </p>
            </CardBody>
          )}
        </Card>
      )}
    </div>
  );
}

/** A zero in a month-over-month grid is noise; an em dash reads as "nothing here". */
function formatOrDash(cents: number): React.ReactNode {
  if (cents === 0) return <span className="text-subtle">—</span>;
  return <Money cents={cents} plain />;
}

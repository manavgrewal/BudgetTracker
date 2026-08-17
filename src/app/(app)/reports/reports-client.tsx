'use client';

import { CategoryBarChart } from '@/components/charts/CategoryBarChart';
import { ReportsIcon } from '@/components/icons';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Money } from '@/components/ui/Money';
import { PageHeader } from '@/components/ui/PageHeader';
import { TableWrap } from '@/components/ui/Table';
import { Field, inputClass, selectClass } from '@/components/ui/form';
import type { CategoryBreakdownRow, CategoryMonthTrend, PersonSplitRow } from '@/lib/reports';

export function ReportsClient({
  from,
  to,
  person,
  people,
  breakdown,
  monthOverMonth,
  split,
}: {
  from: string;
  to: string;
  person: string;
  people: { id: number; name: string }[];
  breakdown: CategoryBreakdownRow[];
  monthOverMonth: { months: string[]; rows: CategoryMonthTrend[] };
  split: PersonSplitRow[];
}) {
  const exportHref = `/api/reports/export?from=${from}&to=${to}${person ? `&person=${person}` : ''}`;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow={`${from} → ${to}`}
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
            <Field label="From">
              <input type="date" name="from" defaultValue={from} className={inputClass} />
            </Field>
            <Field label="To">
              <input type="date" name="to" defaultValue={to} className={inputClass} />
            </Field>
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
    </div>
  );
}

/** A zero in a month-over-month grid is noise; an em dash reads as "nothing here". */
function formatOrDash(cents: number): React.ReactNode {
  if (cents === 0) return <span className="text-subtle">—</span>;
  return <Money cents={cents} plain />;
}

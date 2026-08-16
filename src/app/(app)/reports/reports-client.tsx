'use client';

import { CategoryBarChart } from '@/components/charts/CategoryBarChart';
import { formatCents } from '@/lib/money';
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
    <div className="flex flex-col gap-8">
      <h1 className="text-xl font-semibold">Reports</h1>

      <form method="get" className="flex flex-wrap items-end gap-3 text-sm">
        <label className="flex flex-col gap-1">
          From
          <input type="date" name="from" defaultValue={from} className="rounded border px-2 py-1 dark:bg-slate-900" />
        </label>
        <label className="flex flex-col gap-1">
          To
          <input type="date" name="to" defaultValue={to} className="rounded border px-2 py-1 dark:bg-slate-900" />
        </label>
        <label className="flex flex-col gap-1">
          Person
          <select name="person" defaultValue={person} className="rounded border px-2 py-1 dark:bg-slate-900">
            <option value="">Everyone</option>
            <option value="unattributed">Household/unattributed</option>
            {people.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </label>
        <button type="submit" className="rounded bg-slate-900 px-3 py-2 text-white dark:bg-slate-100 dark:text-slate-900">Apply</button>
        <a href={exportHref} className="rounded border px-3 py-2 dark:border-slate-700">Export CSV</a>
      </form>

      <section className="flex flex-col gap-2">
        <h2 className="font-medium">Category breakdown</h2>
        <CategoryBarChart data={breakdown} />
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="font-medium">Month over month</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b dark:border-slate-800">
                <th className="py-2">Category</th>
                {monthOverMonth.months.map((month) => (
                  <th key={month} className="text-right">{month}</th>
                ))}
                <th className="text-right">Total</th>
              </tr>
            </thead>
            <tbody>
              {monthOverMonth.rows.map((row) => (
                <tr key={row.categoryId} className="border-b border-slate-100 dark:border-slate-900">
                  <td className="py-1">{row.categoryName}</td>
                  {monthOverMonth.months.map((month) => (
                    <td key={month} className="text-right tabular-nums">{formatCents(row.byMonth[month] ?? 0)}</td>
                  ))}
                  <td className="text-right font-medium tabular-nums">{formatCents(row.totalCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="font-medium">Who spent it</h2>
        <ul className="text-sm">
          {split.map((row) => (
            <li key={row.userId ?? 'unattributed'} className="flex justify-between border-b border-slate-100 py-1 dark:border-slate-900">
              <span>{row.label}</span>
              <span className="tabular-nums">{formatCents(row.spentCents)}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

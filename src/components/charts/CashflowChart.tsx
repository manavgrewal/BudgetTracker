'use client';

import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { MonthTrendRow } from '@/lib/reports';
import { AXIS_TICK, CHART_GRID, TOOLTIP_CURSOR, tooltipStyles } from './chart-theme';

export function CashflowChart({ data }: { data: MonthTrendRow[] }) {
  const series = data.map((row) => ({
    month: row.month,
    Income: row.incomeCents / 100,
    Spend: row.spendCents / 100,
  }));
  return (
    <div className="h-64 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={series} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid {...CHART_GRID} />
          <XAxis dataKey="month" {...AXIS_TICK} />
          <YAxis {...AXIS_TICK} width={56} />
          <Tooltip formatter={(value: number) => `$${value.toFixed(2)}`} cursor={TOOLTIP_CURSOR} {...tooltipStyles()} />
          <Legend wrapperStyle={{ fontSize: 12, color: 'var(--muted)', paddingTop: 8 }} />
          {/* Income and Spend are the money pair, so they take the money tokens —
              the same green and red an amount gets anywhere else in the app. */}
          <Bar dataKey="Income" fill="var(--positive-solid)" radius={[4, 4, 0, 0]} />
          <Bar dataKey="Spend" fill="var(--negative-solid)" radius={[4, 4, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

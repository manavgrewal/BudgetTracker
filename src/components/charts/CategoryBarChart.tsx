'use client';

import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { CategoryBreakdownRow } from '@/lib/reports';
import { AXIS_TICK, TOOLTIP_CURSOR, tooltipStyles } from './chart-theme';

export function CategoryBarChart({ data }: { data: CategoryBreakdownRow[] }) {
  const series = data.slice(0, 12).map((row) => ({ name: row.categoryName, Spend: row.spentCents / 100 }));
  return (
    <div className="h-80 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={series} layout="vertical" margin={{ left: 80, right: 12, top: 4 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" horizontal={false} />
          <XAxis type="number" {...AXIS_TICK} />
          <YAxis type="category" dataKey="name" width={100} {...AXIS_TICK} />
          <Tooltip formatter={(value: number) => `$${value.toFixed(2)}`} cursor={TOOLTIP_CURSOR} {...tooltipStyles()} />
          {/* A single-series breakdown carries no good/bad reading, so it takes
              the accent rather than the money-negative token. */}
          <Bar dataKey="Spend" fill="var(--accent)" radius={[0, 4, 4, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

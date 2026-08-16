'use client';

import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { CategoryBreakdownRow } from '@/lib/reports';

export function CategoryBarChart({ data }: { data: CategoryBreakdownRow[] }) {
  const series = data.slice(0, 12).map((row) => ({ name: row.categoryName, Spend: row.spentCents / 100 }));
  return (
    <div className="h-80 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={series} layout="vertical" margin={{ left: 80 }}>
          <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
          <XAxis type="number" fontSize={11} />
          <YAxis type="category" dataKey="name" fontSize={11} width={100} />
          <Tooltip formatter={(value: number) => `$${value.toFixed(2)}`} />
          <Bar dataKey="Spend" fill="#6366f1" />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

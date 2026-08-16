'use client';

import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { MonthTrendRow } from '@/lib/reports';

export function CashflowChart({ data }: { data: MonthTrendRow[] }) {
  const series = data.map((row) => ({
    month: row.month,
    Income: row.incomeCents / 100,
    Spend: row.spendCents / 100,
  }));
  return (
    <div className="h-64 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={series}>
          <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
          <XAxis dataKey="month" fontSize={11} />
          <YAxis fontSize={11} />
          <Tooltip formatter={(value: number) => `$${value.toFixed(2)}`} />
          <Legend />
          <Bar dataKey="Income" fill="#16a34a" />
          <Bar dataKey="Spend" fill="#f97316" />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

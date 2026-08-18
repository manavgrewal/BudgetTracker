'use client';

import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { DebtPoint } from '@/lib/loans';
import { AXIS_TICK, CHART_GRID, TOOLTIP_CURSOR, tooltipStyles } from './chart-theme';

/**
 * The codebase's first line chart, modelled on CashflowChart's skeleton: same h-64, same
 * cents-to-dollars mapping, same theme imports, so it follows the theme toggle with no JS.
 *
 * The single series is var(--negative-solid) -- this is money owed -- and connectNulls is
 * FALSE so a gap in the data reads as a gap (MUST-15.7). A line that bridged an unknown month
 * would be inventing the very thing the reconstruction refuses to invent.
 */
export function DebtTrendChart({ data }: { data: DebtPoint[] }) {
  const series = data.map((point) => ({
    month: point.month,
    Owed: point.owedCents === null ? null : point.owedCents / 100,
  }));
  return (
    <div className="h-64 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={series} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid {...CHART_GRID} />
          <XAxis dataKey="month" {...AXIS_TICK} />
          <YAxis {...AXIS_TICK} width={64} />
          <Tooltip formatter={(value: number) => `$${value.toFixed(2)}`} cursor={TOOLTIP_CURSOR} {...tooltipStyles()} />
          <Line type="monotone" dataKey="Owed" stroke="var(--negative-solid)" strokeWidth={2} dot={false} connectNulls={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

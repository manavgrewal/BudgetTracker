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
 *
 * Review fix-round: dot is a small token-styled marker rather than `false`. With
 * connectNulls false, any isolated non-null point -- a single point with NULL neighbours on
 * both sides -- is a zero-length segment, which a bare stroke renders as nothing at all. The
 * caller (reports-client.tsx) now keeps the fewer-than-two-points case out of this component
 * entirely, but two non-adjacent non-null points elsewhere in the series would still each be
 * an invisible segment without a dot to mark them.
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
          <Tooltip
            formatter={(value: number) => `$${value.toFixed(2)}`}
            // TOOLTIP_CURSOR's `fill` styles a BarChart's rectangle cursor; recharts' Curve
            // cursor (what a LineChart draws instead) hard-codes stroke #ccc unless one is
            // given explicitly, so the theme token is added here rather than in the shared
            // constant, which stays correct for the bar charts that already use it as-is.
            cursor={{ ...TOOLTIP_CURSOR, stroke: 'var(--line-strong)' }}
            {...tooltipStyles()}
          />
          <Line
            type="monotone"
            dataKey="Owed"
            stroke="var(--negative-solid)"
            strokeWidth={2}
            dot={{ r: 2, fill: 'var(--negative-solid)', strokeWidth: 0 }}
            connectNulls={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

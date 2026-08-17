/**
 * Shared Recharts theming.
 *
 * Every value is a CSS custom property rather than a literal, so the charts
 * follow the theme toggle live — SVG `fill`/`stroke` attributes resolve
 * `var(--…)` the same way any other CSS value does, which means no JS has to
 * read computed styles or re-render on a theme change.
 */

export const CHART_GRID = {
  strokeDasharray: '3 3',
  stroke: 'var(--line)',
  vertical: false,
} as const;

export const AXIS_TICK = {
  stroke: 'var(--line-strong)',
  tickLine: false,
  axisLine: false,
  tick: { fill: 'var(--subtle)', fontSize: 11 },
} as const;

export const TOOLTIP_CURSOR = { fill: 'var(--surface-2)', opacity: 0.7 } as const;

export function tooltipStyles() {
  return {
    contentStyle: {
      background: 'var(--surface)',
      border: '1px solid var(--line)',
      borderRadius: '0.75rem',
      boxShadow: 'var(--elev-pop)',
      fontSize: 12,
      color: 'var(--ink)',
    },
    labelStyle: { color: 'var(--muted)', fontWeight: 600, marginBottom: 2 },
    itemStyle: { color: 'var(--ink)' },
  };
}

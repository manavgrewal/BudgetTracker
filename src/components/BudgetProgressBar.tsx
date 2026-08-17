/**
 * The meter next to a category's spend. Colour is a warning system, not
 * decoration: under budget is the money-positive token, the last 20% is the
 * warning token, and over is the money-negative one — the same three colours
 * every other amount in the app uses.
 */
export function BudgetProgressBar({
  limitCents,
  spentCents,
  label,
}: {
  limitCents: number | null;
  spentCents: number;
  label?: string;
}) {
  if (limitCents === null) {
    return <span className="text-xs text-subtle">No budget</span>;
  }
  const pct = limitCents === 0 ? (spentCents > 0 ? 100 : 0) : Math.round((spentCents / limitCents) * 100);
  const over = pct > 100;
  const fill = over ? 'bg-negative-solid' : pct > 80 ? 'bg-warning-solid' : 'bg-positive-solid';
  return (
    <div
      role="progressbar"
      aria-label={label ?? 'Budget progress'}
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
      data-over-budget={over ? 'true' : 'false'}
      className="h-2 w-full overflow-hidden rounded-full bg-surface-3"
    >
      <div
        style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
        className={`h-full rounded-full transition-[width] duration-300 ease-out ${fill}`}
      />
    </div>
  );
}

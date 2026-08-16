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
    return <span className="text-xs text-slate-500 dark:text-slate-400">No budget</span>;
  }
  const pct = limitCents === 0 ? (spentCents > 0 ? 100 : 0) : Math.round((spentCents / limitCents) * 100);
  const over = pct > 100;
  return (
    <div
      role="progressbar"
      aria-label={label ?? 'Budget progress'}
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
      data-over-budget={over ? 'true' : 'false'}
      className="h-2 w-full overflow-hidden rounded bg-slate-200 dark:bg-slate-800"
    >
      <div
        style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
        className={`h-full ${over ? 'bg-red-500' : pct > 80 ? 'bg-amber-500' : 'bg-emerald-500'}`}
      />
    </div>
  );
}

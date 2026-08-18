/**
 * MUST-15.3: a SEPARATE component rather than a reuse of BudgetProgressBar, whose colour
 * mapping is a WARNING SYSTEM -- green under, amber past 80%, red over. Here more progress is
 * unambiguously good, and bending that component would mean a car loan 85% paid off rendering
 * amber. The track markup is copied; the tone logic is not, because the tone logic is the part
 * that is wrong for this use. The fill is bg-positive-solid throughout, with no warning band.
 */
export function LoanProgressBar({ fraction, label }: { fraction: number; label: string }) {
  const pct = Math.round(Math.min(1, Math.max(0, fraction)) * 100);
  return (
    <div
      role="progressbar"
      aria-label={`${label} paid off`}
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
      className="h-2 w-full overflow-hidden rounded-full bg-surface-3"
    >
      <div
        style={{ width: `${pct}%` }}
        className="h-full rounded-full bg-positive-solid transition-[width] duration-300 ease-out"
      />
    </div>
  );
}

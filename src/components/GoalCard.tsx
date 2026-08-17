import { formatCents } from '@/lib/money';
import type { GoalWithProgress } from '@/lib/goals';

export function GoalCard({ goal }: { goal: GoalWithProgress }) {
  const { pace } = goal;
  const pct = goal.targetCents === 0 ? 100 : Math.round((goal.savedCents / goal.targetCents) * 100);
  const clamped = Math.min(100, Math.max(0, pct));

  return (
    <article className="card flex flex-col gap-3 p-5">
      <header className="flex items-start justify-between gap-2">
        <h3 className="text-sm font-semibold text-ink">{goal.name}</h3>
        <span className="badge badge--slate">{goal.ownerName ?? 'Shared'}</span>
      </header>

      <p className="money-lg text-ink">
        {formatCents(goal.savedCents)}
        <span className="ml-1.5 text-sm font-normal text-muted">
          of {formatCents(goal.targetCents)} ({clamped}%)
        </span>
      </p>

      <div
        className="h-2 w-full overflow-hidden rounded-full bg-surface-3"
        role="progressbar"
        aria-label={`${goal.name} progress`}
        aria-valuenow={clamped}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          style={{ width: `${clamped}%` }}
          className={`h-full rounded-full transition-[width] duration-300 ease-out ${
            pace.met ? 'bg-positive-solid' : 'bg-accent'
          }`}
        />
      </div>

      <div className="flex flex-col gap-1 text-xs">
        {goal.targetDate ? <p className="text-subtle">Target date {goal.targetDate}</p> : null}

        {pace.overdue ? (
          <p className="font-semibold money-neg">
            Overdue — {formatCents(pace.requiredMonthlyCents ?? pace.remainingCents)} still to go
          </p>
        ) : pace.requiredMonthlyCents !== null ? (
          <p className="text-muted">Required monthly: {formatCents(pace.requiredMonthlyCents)}</p>
        ) : null}

        {pace.met ? (
          <p className="font-semibold money-pos">Goal reached</p>
        ) : pace.noPace ? (
          <p className="text-subtle">No pace yet — log a contribution to see a projection.</p>
        ) : (
          <p className="text-subtle">
            Averaging {formatCents(pace.avgMonthlyCents)}/month · projected finish {pace.projectedFinishMonth}
          </p>
        )}
      </div>
    </article>
  );
}

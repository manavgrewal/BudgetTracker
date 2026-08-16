import { formatCents } from '@/lib/money';
import type { GoalWithProgress } from '@/lib/goals';

export function GoalCard({ goal }: { goal: GoalWithProgress }) {
  const { pace } = goal;
  const pct = goal.targetCents === 0 ? 100 : Math.round((goal.savedCents / goal.targetCents) * 100);

  return (
    <article className="flex flex-col gap-2 rounded border border-slate-200 p-4 text-sm dark:border-slate-800">
      <header className="flex items-baseline justify-between gap-2">
        <h3 className="font-medium">{goal.name}</h3>
        <span className="rounded bg-slate-100 px-2 py-0.5 text-xs dark:bg-slate-800">{goal.ownerName ?? 'Shared'}</span>
      </header>

      <p className="tabular-nums">
        {formatCents(goal.savedCents)} of {formatCents(goal.targetCents)} ({Math.min(100, Math.max(0, pct))}%)
      </p>
      <div className="h-2 w-full overflow-hidden rounded bg-slate-200 dark:bg-slate-800">
        <div style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} className="h-full bg-emerald-500" />
      </div>

      {goal.targetDate ? <p className="text-xs text-slate-500">Target date {goal.targetDate}</p> : null}

      {pace.overdue ? (
        <p className="text-xs font-medium text-red-600 dark:text-red-400">
          Overdue — {formatCents(pace.requiredMonthlyCents ?? pace.remainingCents)} still to go
        </p>
      ) : pace.requiredMonthlyCents !== null ? (
        <p className="text-xs">Required monthly: {formatCents(pace.requiredMonthlyCents)}</p>
      ) : null}

      {pace.met ? (
        <p className="text-xs font-medium text-emerald-600 dark:text-emerald-400">Goal reached</p>
      ) : pace.noPace ? (
        <p className="text-xs text-slate-500">No pace yet — log a contribution to see a projection.</p>
      ) : (
        <p className="text-xs text-slate-500">
          Averaging {formatCents(pace.avgMonthlyCents)}/month · projected finish {pace.projectedFinishMonth}
        </p>
      )}
    </article>
  );
}

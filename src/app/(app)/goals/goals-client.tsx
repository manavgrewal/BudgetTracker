'use client';

import { useActionState } from 'react';
import { FormError } from '@/components/FormError';
import { GoalCard } from '@/components/GoalCard';
import { SubmitButton } from '@/components/SubmitButton';
import { formatCents } from '@/lib/money';
import type { ContributionRecord, GoalWithProgress } from '@/lib/goals';
import { addContributionAction, archiveGoalAction, createGoalAction, deleteContributionAction, type GoalActionState } from './actions';

const initial: GoalActionState = {};

export function GoalsClient({
  today,
  goals,
  people,
}: {
  today: string;
  goals: { goal: GoalWithProgress; contributions: ContributionRecord[] }[];
  people: { id: number; name: string }[];
}) {
  const [createState, create] = useActionState(createGoalAction, initial);
  const [contributeState, contribute] = useActionState(addContributionAction, initial);
  const [archiveState, archive] = useActionState(archiveGoalAction, initial);
  const [deleteState, remove] = useActionState(deleteContributionAction, initial);

  const notice = createState.message ?? contributeState.message ?? archiveState.message ?? deleteState.message;
  const error = createState.error ?? contributeState.error ?? archiveState.error ?? deleteState.error;

  return (
    <div className="flex flex-col gap-8">
      <h1 className="text-xl font-semibold">Goals</h1>
      <FormError message={error} />
      {notice ? <p className="text-sm text-green-700 dark:text-green-400">{notice}</p> : null}

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {goals.map(({ goal, contributions }) => (
          <div key={goal.id} className="flex flex-col gap-3">
            <GoalCard goal={goal} />
            <form action={contribute} className="flex flex-wrap items-end gap-2 text-xs">
              <input type="hidden" name="goalId" value={goal.id} />
              <input name="amount" placeholder="Amount" required className="w-24 rounded border px-2 py-1 dark:bg-slate-900" />
              <input type="date" name="date" defaultValue={today} required className="rounded border px-2 py-1 dark:bg-slate-900" />
              <input name="note" placeholder="Note" className="w-28 rounded border px-2 py-1 dark:bg-slate-900" />
              <SubmitButton className="px-2 py-1 text-xs">Add</SubmitButton>
            </form>
            {contributions.length > 0 ? (
              <details className="text-xs">
                <summary className="cursor-pointer">{contributions.length} contributions</summary>
                <ul className="mt-1 flex flex-col gap-1">
                  {contributions.map((contribution) => (
                    <li key={contribution.id} className="flex items-center justify-between gap-2">
                      <span>
                        {contribution.date} · {contribution.userName} · {formatCents(contribution.amountCents)}
                        {contribution.note ? ` · ${contribution.note}` : ''}
                      </span>
                      <form action={remove}>
                        <input type="hidden" name="goalId" value={goal.id} />
                        <input type="hidden" name="contributionId" value={contribution.id} />
                        <button type="submit" className="underline">remove</button>
                      </form>
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
            <form action={archive}>
              <input type="hidden" name="goalId" value={goal.id} />
              <input type="hidden" name="archived" value="1" />
              <button type="submit" className="w-fit text-xs underline">Archive</button>
            </form>
          </div>
        ))}
      </div>

      <form action={create} className="flex max-w-md flex-col gap-3 rounded border border-slate-200 p-3 text-sm dark:border-slate-800">
        <h2 className="font-medium">New goal</h2>
        <input name="name" placeholder="Name" required className="rounded border px-2 py-1 dark:bg-slate-900" />
        <input name="target" placeholder="Target amount, e.g. 5000" required className="rounded border px-2 py-1 dark:bg-slate-900" />
        <label className="flex flex-col gap-1">
          Target date (optional)
          <input type="date" name="targetDate" className="rounded border px-2 py-1 dark:bg-slate-900" />
        </label>
        <label className="flex flex-col gap-1">
          Owner
          <select name="owner" className="rounded border px-2 py-1 dark:bg-slate-900">
            <option value="shared">Shared</option>
            {people.map((person) => (
              <option key={person.id} value={person.id}>{person.name}</option>
            ))}
          </select>
        </label>
        <SubmitButton>Create goal</SubmitButton>
      </form>
    </div>
  );
}

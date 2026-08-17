'use client';

import { useActionState } from 'react';
import { FormError } from '@/components/FormError';
import { GoalCard } from '@/components/GoalCard';
import { SubmitButton } from '@/components/SubmitButton';
import { GoalsIcon } from '@/components/icons';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Money } from '@/components/ui/Money';
import { Notice } from '@/components/ui/Notice';
import { PageHeader } from '@/components/ui/PageHeader';
import { Field, inputClass, selectClass } from '@/components/ui/form';
import type { ContributionRecord, GoalWithProgress } from '@/lib/goals';
import { addContributionAction, archiveGoalAction, createGoalAction, deleteContributionAction, type GoalActionState } from './actions';

const initial: GoalActionState = {};

export function GoalsClient({
  today,
  goals,
  people,
  showArchived = false,
}: {
  today: string;
  goals: { goal: GoalWithProgress; contributions: ContributionRecord[] }[];
  people: { id: number; name: string }[];
  showArchived?: boolean;
}) {
  const [createState, create] = useActionState(createGoalAction, initial);
  const [contributeState, contribute] = useActionState(addContributionAction, initial);
  const [archiveState, archive] = useActionState(archiveGoalAction, initial);
  const [deleteState, remove] = useActionState(deleteContributionAction, initial);

  const notice = createState.message ?? contributeState.message ?? archiveState.message ?? deleteState.message;
  const error = createState.error ?? contributeState.error ?? archiveState.error ?? deleteState.error;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Goals"
        description="What the household is saving towards, and whether the pace gets there."
        actions={
          /* Archiving was previously one-way in the UI: archiveGoal(id, false) existed
             but nothing could reach it, so an archived goal was gone for good. */
          <a className="btn btn--secondary btn--sm" href={showArchived ? '/goals' : '/goals?archived=1'}>
            {showArchived ? 'Hide archived' : 'Show archived'}
          </a>
        }
      />
      <FormError message={error} />
      {notice ? <Notice tone="success">{notice}</Notice> : null}

      {goals.length === 0 ? (
        <Card>
          <EmptyState icon={GoalsIcon} title="No goals yet">
            A goal is a target amount and, if you want one, a date. Add the first one below and log contributions as you go.
          </EmptyState>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {goals.map(({ goal, contributions }) => (
            <GoalCard
              key={goal.id}
              goal={goal}
              footer={
                <>
                  {goal.archived ? <span className="badge badge--slate w-fit">Archived</span> : null}
                  <form action={contribute} className="flex flex-wrap items-center gap-1.5">
                    <input type="hidden" name="goalId" value={goal.id} />
                    <input
                      name="amount"
                      placeholder="Amount"
                      required
                      aria-label={`Contribution amount for ${goal.name}`}
                      className="field-control w-24 px-2 py-1 text-xs"
                    />
                    <input
                      type="date"
                      name="date"
                      defaultValue={today}
                      required
                      aria-label={`Contribution date for ${goal.name}`}
                      className="field-control w-auto px-2 py-1 text-xs"
                    />
                    <input
                      name="note"
                      placeholder="Note"
                      aria-label={`Contribution note for ${goal.name}`}
                      className="field-control w-24 px-2 py-1 text-xs"
                    />
                    <SubmitButton size="sm">Add</SubmitButton>
                  </form>

                  {contributions.length > 0 ? (
                    <details className="text-xs">
                      <summary className="cursor-pointer text-muted">{contributions.length} contributions</summary>
                      <ul className="mt-2 flex flex-col gap-1.5">
                        {contributions.map((contribution) => (
                          <li key={contribution.id} className="flex items-center justify-between gap-2">
                            <span className="min-w-0 truncate text-subtle">
                              <span className="tabnum">{contribution.date}</span> · {contribution.userName} ·{' '}
                              <Money cents={contribution.amountCents} plain className="text-ink" />
                              {contribution.note ? ` · ${contribution.note}` : ''}
                            </span>
                            <form action={remove}>
                              <input type="hidden" name="goalId" value={goal.id} />
                              <input type="hidden" name="contributionId" value={contribution.id} />
                              <button
                                type="submit"
                                aria-label={`Remove the ${contribution.date} contribution`}
                                className="btn btn--ghost btn--sm px-1.5 text-xs"
                              >
                                remove
                              </button>
                            </form>
                          </li>
                        ))}
                      </ul>
                    </details>
                  ) : null}

                  <form action={archive}>
                    <input type="hidden" name="goalId" value={goal.id} />
                    <input type="hidden" name="archived" value={goal.archived ? '0' : '1'} />
                    <button type="submit" className="btn btn--ghost btn--sm w-fit px-0 text-xs">
                      {goal.archived ? 'Restore' : 'Archive'}
                    </button>
                  </form>
                </>
              }
            />
          ))}
        </div>
      )}

      <Card className="max-w-md">
        <CardHeader title="New goal" description="Name it, give it a target, and it starts tracking pace on the first contribution." />
        <CardBody>
          <form action={create} className="flex flex-col gap-4">
            <Field label="Name">
              <input name="name" placeholder="Trip to Japan" required className={inputClass} />
            </Field>
            <Field label="Target amount">
              <input name="target" placeholder="5000" required className={inputClass} />
            </Field>
            <Field label="Target date (optional)">
              <input type="date" name="targetDate" className={inputClass} />
            </Field>
            <Field label="Owner">
              <select name="owner" className={selectClass}>
                <option value="shared">Shared</option>
                {people.map((person) => (
                  <option key={person.id} value={person.id}>{person.name}</option>
                ))}
              </select>
            </Field>
            <SubmitButton className="w-fit">Create goal</SubmitButton>
          </form>
        </CardBody>
      </Card>
    </div>
  );
}

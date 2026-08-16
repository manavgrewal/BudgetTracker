import { requireUser } from '@/lib/auth/session';
import { listUsers } from '@/lib/auth/users';
import { listContributions, listGoals } from '@/lib/goals';
import { todayIso } from '@/lib/dates';
import { GoalsClient } from './goals-client';

export const dynamic = 'force-dynamic';

export default async function GoalsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireUser();
  const params = await searchParams;
  const raw = Array.isArray(params.archived) ? params.archived[0] : params.archived;
  // ?archived=1 is a plain link, not client state: archiving reloads the page via
  // revalidatePath, so a useState toggle would reset itself on every action anyway.
  const showArchived = raw === '1';
  const goals = listGoals({ includeArchived: showArchived });
  return (
    <GoalsClient
      today={todayIso()}
      showArchived={showArchived}
      goals={goals.map((goal) => ({ goal, contributions: listContributions(goal.id) }))}
      people={listUsers().filter((u) => u.isActive).map((u) => ({ id: u.id, name: u.name }))}
    />
  );
}

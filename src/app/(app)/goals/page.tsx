import { requireUser } from '@/lib/auth/session';
import { listUsers } from '@/lib/auth/users';
import { listContributions, listGoals } from '@/lib/goals';
import { todayIso } from '@/lib/dates';
import { GoalsClient } from './goals-client';

export const dynamic = 'force-dynamic';

export default async function GoalsPage() {
  await requireUser();
  const goals = listGoals();
  return (
    <GoalsClient
      today={todayIso()}
      goals={goals.map((goal) => ({ goal, contributions: listContributions(goal.id) }))}
      people={listUsers().filter((u) => u.isActive).map((u) => ({ id: u.id, name: u.name }))}
    />
  );
}

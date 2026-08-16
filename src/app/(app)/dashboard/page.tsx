import { requireUser } from '@/lib/auth/session';

export default async function DashboardPage() {
  const user = await requireUser();
  return <h1 className="text-xl font-semibold">Welcome back, {user.name}</h1>;
}

import { requireAdmin } from '@/lib/auth/session';
import { listUsers } from '@/lib/auth/users';
import { UsersManager } from './users-manager';

export const dynamic = 'force-dynamic';

export default async function UsersPage() {
  await requireAdmin();
  return <UsersManager users={listUsers()} />;
}

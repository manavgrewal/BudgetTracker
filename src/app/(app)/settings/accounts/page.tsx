import { requireAdmin } from '@/lib/auth/session';
import { listAccounts } from '@/lib/accounts';
import { listUsers } from '@/lib/auth/users';
import { isSimplefinManaged } from '@/lib/simplefin/connection';
import { AccountsManager } from './accounts-manager';

export const dynamic = 'force-dynamic';

export default async function AccountsPage() {
  await requireAdmin();
  const accounts = listAccounts({ includeInactive: true }).map((account) => ({
    id: account.id,
    name: account.name,
    institution: account.institution,
    type: account.type,
    ownerUserId: account.ownerUserId,
    isActive: account.isActive,
    isSimplefinManaged: isSimplefinManaged(account.id),
  }));
  const people = listUsers().map((user) => ({ id: user.id, name: user.name, isActive: user.isActive }));
  return <AccountsManager accounts={accounts} people={people} />;
}

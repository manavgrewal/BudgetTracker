import { redirect } from 'next/navigation';
import { requireAdmin } from '@/lib/auth/session';
import { listAccounts } from '@/lib/accounts';
import { AccountsStep } from './accounts-step';

export const dynamic = 'force-dynamic';

/**
 * Second (optional) step of the first-run wizard — spec section 6:
 * "create admin -> seed categories -> optionally create accounts".
 * Reaching it again once accounts exist is pointless, so it hands the admin
 * to the dashboard instead of offering a duplicate-creating form.
 */
export default async function SetupAccountsPage() {
  const admin = await requireAdmin();
  if (listAccounts({ includeInactive: true }).length > 0) redirect('/dashboard');
  return <AccountsStep admin={{ id: admin.id, name: admin.name }} />;
}

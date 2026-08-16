import { requireAdmin } from '@/lib/auth/session';
import { listAccounts } from '@/lib/accounts';
import { DAILY_REQUEST_LIMIT, getConnection, listLinks, remainingRequestsToday } from '@/lib/simplefin/connection';
import { ConnectionsClient } from './connections-client';

export const dynamic = 'force-dynamic';

export default async function ConnectionsPage() {
  await requireAdmin();
  const connection = getConnection();
  return (
    <ConnectionsClient
      connection={connection}
      links={listLinks()}
      accounts={listAccounts().map((a) => ({ id: a.id, name: a.name }))}
      remainingRequests={connection ? remainingRequestsToday() : DAILY_REQUEST_LIMIT}
      dailyLimit={DAILY_REQUEST_LIMIT}
    />
  );
}

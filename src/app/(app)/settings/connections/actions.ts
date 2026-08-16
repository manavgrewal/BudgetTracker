'use server';

import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { isSameOrigin } from '@/lib/auth/csrf';
import { requireAdmin } from '@/lib/auth/session';
import { getAccount } from '@/lib/accounts';
import { deleteConnection, listLinks } from '@/lib/simplefin/connection';

export interface ConnectionsState {
  error?: string;
  message?: string;
}

const CROSS_ORIGIN_ERROR = 'Cross-origin request rejected';

export async function forgetConnectionAction(): Promise<ConnectionsState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };

  await requireAdmin();

  // Capture the affected account names BEFORE deleting: deleteConnection()
  // also clears every account link (they revert to CSV-managed), so this is
  // the last point the mapping is still readable.
  const affectedNames = listLinks()
    .map((link) => getAccount(link.accountId)?.name)
    .filter((name): name is string => Boolean(name));

  deleteConnection();
  revalidatePath('/settings/connections');
  revalidatePath('/import');

  return {
    message:
      affectedNames.length > 0
        ? `Connection removed. ${affectedNames.join(', ')} ${affectedNames.length === 1 ? 'reverts' : 'revert'} to CSV import.`
        : 'Connection removed. The stored access URL was deleted.',
  };
}

'use server';

import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { isSameOrigin } from '@/lib/auth/csrf';
import { requireAdmin } from '@/lib/auth/session';
import { pruneBackups, runNightlyJob, setBackupRetention } from '@/lib/backup';

export interface BackupActionState {
  error?: string;
  message?: string;
}

const CROSS_ORIGIN_ERROR = 'Cross-origin request rejected';

export async function setRetentionAction(_prev: BackupActionState, formData: FormData): Promise<BackupActionState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };
  await requireAdmin();

  const count = Number(formData.get('retention'));
  if (!Number.isInteger(count) || count < 1 || count > 365) return { error: 'Keep between 1 and 365 backups.' };
  setBackupRetention(count);
  const pruned = pruneBackups(count);
  revalidatePath('/settings/backups');
  return { message: `Retention set to ${count}. Removed ${pruned.length} old backups.` };
}

export async function runBackupNowAction(): Promise<BackupActionState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };
  await requireAdmin();

  try {
    const result = runNightlyJob(new Date());
    revalidatePath('/settings/backups');
    return { message: `Wrote ${result.backup.name} (${result.backup.bytes} bytes).` };
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Backup failed.' };
  }
}

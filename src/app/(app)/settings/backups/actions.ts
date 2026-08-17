'use server';

import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { CROSS_ORIGIN_ERROR, isSameOrigin } from '@/lib/auth/csrf';
import { requireAdmin } from '@/lib/auth/session';
import { pruneBackups, runNightlyJob, setBackupRetention } from '@/lib/backup';
import { ARCHIVE_NAME_RE, LEGACY_NAME_RE } from '@/lib/backup/archive';
import { RESTART_DELAY_MS, RESTART_EXIT_CODE, stageRestore } from '@/lib/backup/restore';
import { closeDb } from '@/db/client';
import { stopScheduler } from '@/lib/scheduler';

export interface BackupActionState {
  error?: string;
  message?: string;
  restarting?: boolean;
}

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

const stageRestoreSchema = z.object({
  name: z.string().refine((n) => ARCHIVE_NAME_RE.test(n) || LEGACY_NAME_RE.test(n), {
    message: 'That is not one of the listed backups.',
  }),
  confirm: z.literal('on', { errorMap: () => ({ message: 'Tick the confirmation box first.' }) }),
});

/**
 * MUST-20.36: isSameOrigin FIRST, then requireAdmin (MUST-20.37), then zod, then stageRestore
 * — which itself resolves the name through resolveSafeTarget() and validates the artifact in
 * full (MUST-20.2/20.14) before anything is staged. A cross-origin caller is rejected before a
 * single fs call happens; a non-admin caller gets a written refusal, not a redirect
 * (MUST-20.37 deliberately deviates from requireAdmin()'s usual bare-call pattern elsewhere in
 * this file, because a restore's confirm step should read as an honest refusal, not crash).
 */
export async function stageRestoreAction(
  _prev: BackupActionState,
  formData: FormData,
): Promise<BackupActionState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };

  let user;
  try {
    user = await requireAdmin();
  } catch {
    return { error: 'Only an admin can restore a backup.' };
  }

  const parsed = stageRestoreSchema.safeParse({
    name: formData.get('name'),
    confirm: formData.get('confirm'),
  });
  if (!parsed.success) return { error: parsed.error.issues[0].message };

  let request;
  try {
    // MUST-20.38: stageRestore() itself already emits the one required audit line
    // ("[restore] staged ..."); logging it again here would be a second line for one event.
    request = stageRestore({ backupName: parsed.data.name, userId: user.id, username: user.username });
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'That backup could not be staged.' };
  }

  armRestart();
  revalidatePath('/settings/backups');
  return {
    restarting: true,
    message: `Restoring ${request.sourceName} — the app will restart. Refresh this page in about 30 seconds.`,
  };
}

/**
 * MUST-20.28. Armed only AFTER stageRestoreAction has its return value ready — the caller
 * arms this and then returns, so the exit can never pre-empt the HTTP response. unref()'d: the
 * listening HTTP server keeps the event loop alive on its own, so an unref'd timer still fires;
 * and if the process were already exiting for some other reason, being unref'd is exactly what
 * stops this timer from delaying that.
 */
function armRestart(): void {
  setTimeout(() => {
    stopScheduler();
    // MUST-20.29: checkpoints and removes the WAL, so the safety copy the boot hook takes is
    // one self-contained file rather than a database plus a log that must travel with it.
    closeDb();
    process.exit(RESTART_EXIT_CODE);
  }, RESTART_DELAY_MS).unref();
}

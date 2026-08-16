import cron, { type ScheduledTask } from 'node-cron';
import { runNightlyJob } from '@/lib/backup';
import { readEnv } from '@/lib/env';

export const NIGHTLY_CRON = '0 2 * * *';

let task: ScheduledTask | null = null;

/** Idempotent: safe to call more than once per process (e.g. hot-reload in dev). */
export function startScheduler(): void {
  if (task) return;
  const { tz } = readEnv();
  task = cron.schedule(
    NIGHTLY_CRON,
    () => {
      try {
        runNightlyJob(new Date());
      } catch (error) {
        console.error('[backup] nightly job failed', error);
      }
    },
    { timezone: tz },
  );
  console.log(`[scheduler] nightly job registered for ${NIGHTLY_CRON} (${tz})`);
}

export function stopScheduler(): void {
  task?.stop();
  task = null;
}

export function isSchedulerRunning(): boolean {
  return task !== null;
}

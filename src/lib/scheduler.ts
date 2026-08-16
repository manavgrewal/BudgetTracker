import cron, { type ScheduledTask } from 'node-cron';
import { runNightlyJob } from '@/lib/backup';
import { readEnv } from '@/lib/env';
import { sweepPendingReceipts } from '@/lib/warranty/ocr/queue';

export const NIGHTLY_CRON = '0 2 * * *';
/** MUST-7.12: a crash leaves rows in 'pending'; this tick re-enqueues them. */
export const OCR_SWEEP_CRON = '*/10 * * * *';

let task: ScheduledTask | null = null;
let ocrTask: ScheduledTask | null = null;

function runOcrSweep(): void {
  try {
    const enqueued = sweepPendingReceipts();
    if (enqueued > 0) console.log(`[ocr] sweep enqueued ${enqueued} pending receipt(s)`);
  } catch (error) {
    console.error('[ocr] sweep failed', error);
  }
}

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
  ocrTask = cron.schedule(OCR_SWEEP_CRON, runOcrSweep, { timezone: tz });
  console.log(`[scheduler] nightly job registered for ${NIGHTLY_CRON} (${tz})`);
  console.log(`[scheduler] OCR sweep registered for ${OCR_SWEEP_CRON} (${tz})`);
  // ...and once at boot, so a container restarted mid-job recovers immediately instead of
  // leaving a member's receipt unread for up to ten minutes.
  runOcrSweep();
}

export function stopScheduler(): void {
  task?.stop();
  task = null;
  ocrTask?.stop();
  ocrTask = null;
}

export function isSchedulerRunning(): boolean {
  return task !== null;
}

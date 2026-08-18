import cron, { type ScheduledTask } from 'node-cron';
import { runNightlyJob } from '@/lib/backup';
import { readEnv } from '@/lib/env';
import { hasAnyEnabledTarget } from '@/lib/notify/config';
import { runScheduledEvaluation } from '@/lib/notify/evaluate';
import { countPendingOutbox, expireStalePending, pumpOutbox } from '@/lib/notify/outbox';
import { raiseBackupFailed } from '@/lib/notify/raise';
import { sweepPendingReceipts } from '@/lib/warranty/ocr/queue';

export const NIGHTLY_CRON = '0 2 * * *';
/** MUST-7.12: a crash leaves rows in 'pending'; this tick re-enqueues them. */
export const OCR_SWEEP_CRON = '*/10 * * * *';
/** MUST-6.1: five minutes is the retry and catch-up granularity, not the latency floor. */
export const NOTIFY_TICK_CRON = '*/5 * * * *';

let task: ScheduledTask | null = null;
let ocrTask: ScheduledTask | null = null;
let notifyTask: ScheduledTask | null = null;
/** MUST-6.3: single-flight. A tick arriving while the last one is still running is a no-op. */
let ticking = false;
/** MUST-7.8: the 24-hour pending expiry runs on the FIRST tick after boot, once. */
let bootExpiryDone = false;

function runOcrSweep(): void {
  try {
    const enqueued = sweepPendingReceipts();
    if (enqueued > 0) console.log(`[ocr] sweep enqueued ${enqueued} pending receipt(s)`);
  } catch (error) {
    console.error('[ocr] sweep failed', error);
  }
}

/** Exported so a test can drive the nightly failure path without waiting on a real cron tick. */
export function runNightlyTick(now: Date = new Date()): void {
  try {
    runNightlyJob(now);
  } catch (error) {
    console.error('[backup] nightly job failed', error);
    // MUST-14.1: the UNATTENDED path notifies. The "run now" action deliberately does not.
    // raiseBackupFailed is internally guarded (MUST-6.19) and never throws today, so it is
    // NOT relying on this catch for protection: it simply runs inside the same catch body
    // that already handles runNightlyJob's own failure. If that guarantee ever changed, a
    // throw here would propagate out of the cron callback uncaught.
    raiseBackupFailed({ error, at: now });
  }
}

export function runNotifyTick(now: Date = new Date()): void {
  // MUST-6.3: the single-flight guard is the tick's actual first statement.
  if (ticking) return;
  // MUST-6.4: the dormancy bail, right after the single-flight guard above. Two indexed
  // reads against tables that are empty on a dormant install. Nothing below this line
  // executes, so no evaluator runs, no renderer runs, and no transport module is even
  // reached.
  if (!hasAnyEnabledTarget() && countPendingOutbox() === 0) return;

  ticking = true;
  try {
    if (!bootExpiryDone) {
      bootExpiryDone = true;
      const expired = expireStalePending(now);
      if (expired > 0) console.log(`[notify] expired ${expired} pending row(s) older than 24h`);
    }
    runScheduledEvaluation(now);
  } catch (error) {
    console.error('[notify] tick failed', error);
  } finally {
    ticking = false;
  }
  // The pump owns its own single-flight guard and is deliberately not awaited: a slow
  // relay must not hold the cron callback open into the next tick.
  void pumpOutbox(now).catch((error) => console.error('[notify] pump failed', error));
}

/** Idempotent: safe to call more than once per process (e.g. hot-reload in dev). */
export function startScheduler(): void {
  if (task) return;
  const { tz } = readEnv();
  task = cron.schedule(NIGHTLY_CRON, () => runNightlyTick(), { timezone: tz });
  ocrTask = cron.schedule(OCR_SWEEP_CRON, runOcrSweep, { timezone: tz });
  notifyTask = cron.schedule(NOTIFY_TICK_CRON, () => runNotifyTick(), { timezone: tz });
  console.log(`[scheduler] nightly job registered for ${NIGHTLY_CRON} (${tz})`);
  console.log(`[scheduler] OCR sweep registered for ${OCR_SWEEP_CRON} (${tz})`);
  console.log(`[scheduler] notification tick registered for ${NOTIFY_TICK_CRON} (${tz})`);
  // ...and once at boot, so a container restarted mid-job recovers immediately instead of
  // leaving a member's receipt unread for up to ten minutes.
  runOcrSweep();
  // MUST-6.1: run once immediately at boot, so a container that was off through a slot
  // catches up in seconds rather than in up to five minutes.
  runNotifyTick();
}

export function stopScheduler(): void {
  task?.stop();
  task = null;
  ocrTask?.stop();
  ocrTask = null;
  notifyTask?.stop();
  notifyTask = null;
  bootExpiryDone = false;
}

/**
 * True if ANY of the three registered tasks is still running, not just the nightly one,
 * so a regression that forgets to null out `ocrTask`/`notifyTask` in stopScheduler() makes
 * this report "still running" instead of silently agreeing with a partial teardown.
 */
export function isSchedulerRunning(): boolean {
  return task !== null || ocrTask !== null || notifyTask !== null;
}

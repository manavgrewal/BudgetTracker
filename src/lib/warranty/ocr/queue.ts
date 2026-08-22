import { eq } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { warrantyReceipts } from '@/db/schema';
import { todayIso } from '@/lib/dates';
import { receiptFileExists, resolveReceiptPath } from '@/lib/warranty/receipts';
import { suggestFromOcrText } from '@/lib/warranty/suggest';
import {
  OCR_TIMEOUT_MESSAGE,
  OCR_TIMEOUT_MS,
  TRUNCATION_NOTE,
  getOcrEngine,
  releaseOcrEngine,
  truncateOcrText,
  type OcrEngine,
  type OcrResult,
} from '@/lib/warranty/ocr/engine';
import {
  OCR_CRASH_ATTEMPT_LIMIT,
  clearOcrCrashGuard,
  markOcrJobInFlight,
  readOcrCrashGuardState,
  recordOcrJobCrashSurvived,
} from '@/lib/warranty/ocr/onnx/probe';
import { findStagedReceipt, writeSidecar } from '@/lib/warranty/staging';

/**
 * MUST-7.10: a single in-process FIFO queue with concurrency 1. Household scale is a burst
 * of three receipts, not three hundred.
 *
 * MUST-7.12: ocr_status has only three values ('pending' | 'done' | 'failed'), so an
 * in-flight job is tracked by this in-memory claimed-id set rather than in the database.
 * A crash therefore leaves rows in 'pending' and the scheduler's ten-minute sweep (and the
 * immediate one at boot) re-enqueues them — self-healing and idempotent PROVIDED the receipt
 * itself did not cause the crash. Defect fix (v1.5.0): a receipt that reliably kills the
 * process (an OOM-kill on a memory-capped NAS, a SIGILL the hardware probe missed) used to be
 * "self-healed" straight back into the same crash forever, taking the whole app down every
 * ten minutes. reconcileOcrCrashOnBoot() below closes that loop using a settings-table
 * poison-pill marker (owned by onnx/probe.ts per MUST-12.2) rather than a new column or table
 * — AC9 forbids a migration for this release.
 */
export type OcrJob = { kind: 'staged'; stagingId: string } | { kind: 'receipt'; receiptId: number };

const queue: OcrJob[] = [];
const claimed = new Set<string>();
let pump: Promise<void> | null = null;

function jobKey(job: OcrJob): string {
  return job.kind === 'staged' ? `s:${job.stagingId}` : `r:${job.receiptId}`;
}

export function isOcrJobClaimed(job: OcrJob): boolean {
  return claimed.has(jobKey(job));
}

export function ocrQueueDepth(): number {
  return queue.length;
}

/** Returns false when the job is already claimed — MUST-7.16's "second click is a no-op". */
export function enqueueOcrJob(job: OcrJob): boolean {
  const key = jobKey(job);
  if (claimed.has(key)) return false;
  claimed.add(key);
  queue.push(job);
  if (pump === null) pump = runQueue();
  return true;
}

/** Await the in-flight drain. Used by tests; production code never blocks on OCR. */
export async function drainOcrQueue(): Promise<void> {
  while (pump !== null) {
    await pump;
  }
}

export function resetOcrQueueForTests(): void {
  queue.length = 0;
  claimed.clear();
  pump = null;
}

/**
 * Ruling P15 fix report (IMPORTANT 3 finding): an earlier version of this function added a
 * `if (queue.length > 0) continue;` re-check just before clearing `pump`, on the theory that
 * enqueueOcrJob() pushing a job while this loop is about to go idle could otherwise strand
 * it. That branch was dead code and has been removed — traced through fully below.
 *
 * enqueueOcrJob() only starts a fresh pump when `pump === null`; while a pump is already
 * draining, a newly-pushed job trusts that pump's own loop to notice it on its next
 * iteration. The invariant that makes this safe: there is NO `await` (no yield point of any
 * kind — no microtask boundary either) between `queue.shift()` returning `undefined` on the
 * line below and `pump = null` two lines after it. Both statements execute as one
 * uninterruptible synchronous JS turn. Since enqueueOcrJob() is itself fully synchronous
 * (`queue.push` then a plain `if` check, no `await`), there is no possible interleaving of
 * its execution "inside" this stretch — either its push happens strictly before this check
 * runs (and this very iteration's `queue.shift()` would have returned that job, not
 * `undefined`), or it happens strictly after `pump` has already been set to `null` (and
 * enqueueOcrJob()'s own `pump === null` branch starts a fresh drain for it). There is no
 * third timing in which a job is pushed and neither path notices it — hence nothing to
 * re-check. See tests/lib/warranty/ocr/queue.test.ts's "queue never strands a job" suite,
 * which covers both of those paths directly (enqueue while another job is in flight, and
 * enqueue immediately after the queue has drained to idle).
 */
async function runQueue(): Promise<void> {
  for (;;) {
    const job = queue.shift();
    if (job === undefined) {
      pump = null;
      return;
    }
    try {
      // Any error a job can produce is already caught and recorded (as a 'failed'
      // sidecar/row) inside runStagedJob/runReceiptJob via recognizeWithTimeout. This
      // outer catch is only a backstop against a genuine bug elsewhere in the pipeline.
      await runJob(job);
    } catch (error) {
      console.error('[ocr] job failed', jobKey(job), error);
    } finally {
      claimed.delete(jobKey(job));
    }
  }
}

/**
 * MUST-7.11 / Ruling P5: bounds a single recognise call. Wrapping only the engine call
 * (rather than the whole job) matters because Promise.race only abandons the caller's
 * `await` — it does NOT cancel the call itself — so on timeout the failure MUST be
 * recorded here, inside the job's own try/catch, rather than assumed to eventually surface
 * from the abandoned call settling on its own (a genuinely hung engine may never settle,
 * as tests using the fake-engine seam per MUST-7.17 demonstrate). A hung call also keeps
 * holding the cached tesseract worker after we've moved on; left alone, every future job
 * would queue up behind that same wedged worker and time out in turn, permanently breaking
 * OCR until the process restarts. So on timeout we explicitly terminate the cached worker
 * (a no-op when the active job never touched a real worker, e.g. the PDF path or a test's
 * fake engine) so the NEXT job builds a fresh one.
 */
async function recognizeWithTimeout(filePath: string, mime: Parameters<OcrEngine['recognize']>[1]): Promise<OcrResult> {
  let timer: NodeJS.Timeout | undefined;
  let timedOut = false;
  try {
    return await Promise.race([
      getOcrEngine().recognize(filePath, mime),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          reject(new Error(OCR_TIMEOUT_MESSAGE));
        }, OCR_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (timedOut) {
      await releaseOcrEngine().catch((error) => {
        console.warn('[ocr] worker terminate after timeout failed', error);
      });
    }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error && error.message.length > 0 ? error.message : 'OCR failed.';
}

/**
 * Defect fix (v1.5.0): marks `job` in-flight in the settings-table poison-pill before either
 * variant below touches the engine, and clears it in `finally` regardless of outcome. Both
 * runStagedJob and runReceiptJob already catch every failure they can observe (an engine
 * throw, a timeout, a missing file) and record it normally — this wrapper only ever sees the
 * mark survive past its own `finally` when the process itself died mid-`await`, which is
 * exactly the case reconcileOcrCrashOnBoot() below is looking for.
 */
async function runJob(job: OcrJob): Promise<void> {
  const key = jobKey(job);
  markOcrJobInFlight(key);
  try {
    if (job.kind === 'staged') await runStagedJob(job.stagingId);
    else await runReceiptJob(job.receiptId);
  } finally {
    // F1 fix: only THIS job's own crash history (if any) is cleared. Passing `key` is what
    // stops an unrelated job finishing normally from resetting a different, still-poison
    // receipt's crash count back to zero.
    clearOcrCrashGuard(key);
  }
}

async function runStagedJob(stagingId: string): Promise<void> {
  const staged = findStagedReceipt(stagingId);
  // The 24 h purge (or a restart) got there first. Nothing to record and nothing to lose.
  if (staged === null) return;
  try {
    const { text } = await recognizeWithTimeout(staged.path, staged.mime);
    const { text: capped } = truncateOcrText(text);
    writeSidecar(stagingId, { status: 'done', text: capped, suggestions: suggestFromOcrText(capped, todayIso()) });
  } catch (error) {
    writeSidecar(stagingId, { status: 'failed', error: messageOf(error) });
  }
}

async function runReceiptJob(receiptId: number): Promise<void> {
  const db = getDb();
  const row = db
    .select({
      id: warrantyReceipts.id,
      storedFilename: warrantyReceipts.storedFilename,
      mime: warrantyReceipts.mime,
    })
    .from(warrantyReceipts)
    .where(eq(warrantyReceipts.id, receiptId))
    .get();
  if (!row) return;

  if (!receiptFileExists(row.storedFilename)) {
    db.update(warrantyReceipts)
      .set({ ocrStatus: 'failed', ocrText: null, ocrError: 'Receipt file is missing from this install.' })
      .where(eq(warrantyReceipts.id, receiptId))
      .run();
    return;
  }

  try {
    const { text } = await recognizeWithTimeout(resolveReceiptPath(row.storedFilename), row.mime);
    const { text: capped, truncated } = truncateOcrText(text);
    // MUST-7.13: pending -> done. The warranty_search_receipt_au trigger reindexes here.
    // MUST-3.12: application code never writes warranty_search itself.
    db.update(warrantyReceipts)
      .set({ ocrStatus: 'done', ocrText: capped, ocrError: truncated ? TRUNCATION_NOTE : null })
      .where(eq(warrantyReceipts.id, receiptId))
      .run();
  } catch (error) {
    db.update(warrantyReceipts)
      .set({ ocrStatus: 'failed', ocrText: null, ocrError: messageOf(error) })
      .where(eq(warrantyReceipts.id, receiptId))
      .run();
  }
}

/**
 * MUST-7.12: the scheduler tick. Enqueues every warranty_receipts row still 'pending' that
 * is not currently claimed. One indexed query (warranty_receipts_ocr_idx).
 */
export function sweepPendingReceipts(): number {
  const rows = getDb()
    .select({ id: warrantyReceipts.id })
    .from(warrantyReceipts)
    .where(eq(warrantyReceipts.ocrStatus, 'pending'))
    .all();
  let enqueued = 0;
  for (const row of rows) {
    if (enqueueOcrJob({ kind: 'receipt', receiptId: row.id })) enqueued += 1;
  }
  return enqueued;
}

/**
 * Shown on the condemned row/sidecar. Exported so the About panel (or a future admin view)
 * can recognise this specific outcome without string-matching a free-form error again.
 *
 * Defect fix (v1.5.0, F2): reworded to state only what the marker actually proves — the
 * process went down while this receipt's OCR was running, that many times in a row — rather
 * than asserting the receipt caused it. Before src/instrumentation-node.ts learned to clear
 * the marker on SIGTERM/SIGINT, a `docker compose restart` landing mid-job left identical
 * evidence to a real crash, so "OCR crashed this app... repeatedly" claimed more certainty
 * than the evidence supported even after that fix: a still-possible kill -9, an OOM-kill
 * with no signal at all, or three unrelated restarts that all happened to land mid-job are
 * indistinguishable from this receipt actually being the cause.
 */
export const OCR_CRASH_CONDEMNED_MESSAGE =
  `This app's process stopped while OCR was reading this receipt, ${OCR_CRASH_ATTEMPT_LIMIT} times in a row across restarts. Marked as failed instead of retrying forever, since a receipt that keeps doing this would otherwise take the whole app down repeatedly. Re-run OCR to try again.`;

/** Reverses jobKey() above. 'r:' and 's:' are fixed-width prefixes, so slicing them off
 *  recovers the original id verbatim even if a staging UUID somehow contained a colon. */
function condemnCrashedJob(key: string): void {
  if (key.startsWith('r:')) {
    const receiptId = Number(key.slice(2));
    getDb()
      .update(warrantyReceipts)
      .set({ ocrStatus: 'failed', ocrText: null, ocrError: OCR_CRASH_CONDEMNED_MESSAGE })
      .where(eq(warrantyReceipts.id, receiptId))
      .run();
    return;
  }
  const stagingId = key.slice(2);
  writeSidecar(stagingId, { status: 'failed', error: OCR_CRASH_CONDEMNED_MESSAGE });
}

/**
 * Defect fix (v1.5.0): the boot-time half of the crash guard, modelled directly on
 * update/state.ts's reconcileApplyOnBoot — a settings-table marker written before a
 * process-risking step, reconciled once at the next boot. A still-present in-flight marker IS
 * the proof that the LAST process died mid-job: runJob()'s own `finally` clears it on every
 * path that does not kill the process, so nothing else can leave it behind.
 *
 * Never throws into the boot path (the same guarantee update/state.ts's reconciler and
 * notify's raiseRestoreOutcome carry): a database error here must not stop the app booting.
 * Guarded internally, belt-and-braces with the try/catch src/instrumentation-node.ts also
 * wraps the call in, the same doubled-up caution that reconcileApplyOnBoot's own call site
 * already applies.
 */
export function reconcileOcrCrashOnBoot(): void {
  try {
    const state = readOcrCrashGuardState();
    const key = state.inFlightJobKey;
    if (key === null) return; // Nothing was running when the process last stopped.

    // Attempts only carry over when the recorded crash history is for THIS same job — a
    // different job's leftover count must never attach itself to this one.
    const priorAttempts = state.crashJobKey === key ? state.crashAttempts : 0;
    const attempts = priorAttempts + 1;

    if (attempts < OCR_CRASH_ATTEMPT_LIMIT) {
      recordOcrJobCrashSurvived(key, attempts);
      console.warn(
        `[ocr] job ${key} was still marked in-flight at boot (crash ${attempts} of ${OCR_CRASH_ATTEMPT_LIMIT - 1} forgiven) — leaving it pending to retry`,
      );
      return;
    }

    console.error(`[ocr] job ${key} has crashed the app ${attempts} times in a row; marking it failed instead of retrying forever`);
    condemnCrashedJob(key);
    clearOcrCrashGuard(key);
  } catch (error) {
    console.error('[ocr] crash reconciliation failed', error);
  }
}

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
  terminateOcrWorker,
  truncateOcrText,
  type OcrEngine,
  type OcrResult,
} from '@/lib/warranty/ocr/engine';
import { findStagedReceipt, writeSidecar } from '@/lib/warranty/staging';

/**
 * MUST-7.10: a single in-process FIFO queue with concurrency 1. Household scale is a burst
 * of three receipts, not three hundred.
 *
 * MUST-7.12: ocr_status has only three values ('pending' | 'done' | 'failed'), so an
 * in-flight job is tracked by this in-memory claimed-id set rather than in the database.
 * A crash therefore leaves rows in 'pending' and the scheduler's ten-minute sweep
 * re-enqueues them — self-healing and idempotent.
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
 * Ruling P15: enqueueOcrJob only starts a fresh pump when `pump === null`; while a pump is
 * already draining, a newly-pushed job trusts that pump's own loop to notice it on its next
 * iteration. That is correct today because nothing between "the loop finds the queue empty"
 * and "the loop clears `pump`" ever yields to another task — but it is a fragile invariant
 * to lean on silently. This makes it explicit and self-healing: right before a drain loop
 * would go idle, it re-checks the queue one more time and, if something landed, keeps the
 * baton itself rather than clearing `pump` and relying on some *unrelated* future enqueue to
 * notice the stranded job.
 */
async function runQueue(): Promise<void> {
  for (;;) {
    const job = queue.shift();
    if (job === undefined) {
      if (queue.length > 0) continue;
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
      await terminateOcrWorker().catch((error) => {
        console.warn('[ocr] worker terminate after timeout failed', error);
      });
    }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error && error.message.length > 0 ? error.message : 'OCR failed.';
}

async function runJob(job: OcrJob): Promise<void> {
  if (job.kind === 'staged') return runStagedJob(job.stagingId);
  return runReceiptJob(job.receiptId);
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

import type { ReceiptMime } from '@/lib/warranty/sniff';
import { assertOcrAssets, resolveOcrAssets } from '@/lib/warranty/ocr/assets';
import { extractPdfText } from '@/lib/warranty/ocr/pdf';

export interface OcrResult {
  text: string;
}

/** MUST-7.17: the ONLY way any caller reaches recognition. Tests inject a fake. */
export interface OcrEngine {
  recognize(filePath: string, mime: ReceiptMime): Promise<OcrResult>;
}

/** §3.3 / §17.22: without a cap, one pathological PDF bloats the row and the FTS index. */
export const MAX_OCR_TEXT_CHARS = 100_000;
export const OCR_TIMEOUT_MS = 120_000;
export const OCR_IDLE_TERMINATE_MS = 60_000;

export const OCR_UNAVAILABLE_MESSAGE = 'OCR engine unavailable on this install.';
export const OCR_TIMEOUT_MESSAGE = 'OCR timed out.';
export const TRUNCATION_MARKER = '… [truncated]';
export const TRUNCATION_NOTE = `OCR text was truncated at ${MAX_OCR_TEXT_CHARS} characters.`;

export class OcrUnavailableError extends Error {
  constructor(message = OCR_UNAVAILABLE_MESSAGE) {
    super(message);
    this.name = 'OcrUnavailableError';
  }
}

export function truncateOcrText(raw: string): { text: string; truncated: boolean } {
  if (raw.length <= MAX_OCR_TEXT_CHARS) return { text: raw, truncated: false };
  return { text: `${raw.slice(0, MAX_OCR_TEXT_CHARS)}${TRUNCATION_MARKER}`, truncated: true };
}

/* ------------------------------------------------------------------ *
 * Real engine — one lazily created, reused tesseract.js Node worker.  *
 * MUST-7.2: recognition runs in the library's Node worker (its own    *
 * process), so a multi-second recognise never blocks the event loop.  *
 * ------------------------------------------------------------------ */

// The entire surface the queue relies on. Exported ONLY so tests/lib/warranty/ocr/idle.test.ts
// can seed `worker` with a fake object via setOcrWorkerForTests below — this lets the
// idle-timer arm/disarm behaviour be exercised through the REAL defaultEngine without ever
// touching real tesseract.js or WASM (MUST-7.17: getWorker()'s `if (worker) return worker;`
// cache-hit path never calls createWorker() when a fake is already seeded).
export interface TesseractWorkerLike {
  recognize(input: string): Promise<{ data: { text: string } }>;
  terminate(): Promise<void>;
}

let worker: TesseractWorkerLike | null = null;
let idleTimer: NodeJS.Timeout | null = null;

function armIdleTimer(): void {
  if (idleTimer) clearTimeout(idleTimer);
  // MUST-7.10 / risk R5: release the worker's ~100 MB RSS after 60 s idle.
  idleTimer = setTimeout(() => {
    void terminateOcrWorker();
  }, OCR_IDLE_TERMINATE_MS);
  idleTimer.unref?.();
}

/**
 * Ruling P5 / MUST-7.11: the ONLY way a wedged tesseract worker gets discarded. Called both
 * by the idle timer above and — critically — by the queue's per-job timeout
 * (src/lib/warranty/ocr/queue.ts) when a recognise call blows past OCR_TIMEOUT_MS. A
 * Promise.race timeout only abandons the caller's `await`; it does NOT cancel the underlying
 * worker call. Without an explicit terminate() here, a single wedged worker would silently
 * become the worker EVERY future job reuses (getWorker() returns the cached `worker` as-is),
 * so every subsequent job would queue up behind the same stuck process and time out in turn —
 * OCR would be permanently broken until the process restarts. Terminating and nulling the
 * cache here forces the next getWorker() call to build a fresh one instead.
 */
export async function terminateOcrWorker(): Promise<void> {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  const current = worker;
  worker = null;
  if (current) {
    try {
      await current.terminate();
    } catch (error) {
      console.warn('[ocr] worker terminate failed', error);
    }
  }
}

async function getWorker(): Promise<TesseractWorkerLike> {
  if (worker) return worker;
  const health = assertOcrAssets();
  if (!health.ok) throw new OcrUnavailableError();
  const assets = resolveOcrAssets();
  const { createWorker } = await import('tesseract.js');
  // MUST-7.3: ALL FOUR path options are passed. Omitting any one of them lets the library
  // fall back to its CDN defaults. tests/lib/warranty/ocr/engine-options.test.ts pins this.
  worker = (await createWorker('eng', undefined, {
    workerPath: assets.workerPath,
    corePath: assets.corePath,
    langPath: assets.langPath,
    cachePath: assets.cachePath,
    gzip: true,
    cacheMethod: 'none',
    // CRITICAL fix: tesseract.js's worker message handler (createWorker.js) does
    // `promises[id].reject(data)` and THEN, only if no errorHandler is configured,
    // `throw Error(data)` — inside a Node `worker.on('message')` listener. An uncaught
    // throw inside that listener is an uncaught exception outside any promise chain and
    // crashes the whole Node process. A corrupt/truncated eng.traineddata.gz or a missing
    // wasm core would otherwise take the ENTIRE APP down on the very first receipt upload
    // — exactly what MUST-7.6 (degrade gracefully, never crash) forbids. With errorHandler
    // set, the throw is skipped; the job promise was already rejected unconditionally on
    // the line above it, so the failure still surfaces normally through this function's
    // (or active.recognize()'s) own await chain and gets recorded as a 'failed' job.
    //
    // Known secondary effect (acceptable): if the underlying worker PROCESS itself dies
    // before ever sending a message (e.g. a hard crash during spawn, as opposed to a
    // 'reject' status message), the load job's promise this function awaits can be left
    // permanently pending rather than rejected. recognizeWithTimeout's OCR_TIMEOUT_MS race
    // (src/lib/warranty/ocr/queue.ts) still bounds that case, so the job is recorded
    // 'failed' with "OCR timed out." after 120 s rather than hanging forever.
    errorHandler: (error: unknown) => {
      console.error('[ocr] worker error', error);
    },
  })) as unknown as TesseractWorkerLike;
  return worker;
}

const defaultEngine: OcrEngine = {
  async recognize(filePath: string, mime: ReceiptMime): Promise<OcrResult> {
    if (mime === 'application/pdf') return { text: await extractPdfText(filePath) };
    // IMPORTANT 2: disarm any pending idle-terminate timer the INSTANT a job claims the
    // worker, before awaiting anything. armIdleTimer() previously only re-armed inside the
    // `finally` below, which left a window where job N's OWN recognize() call could still
    // be in flight when the timer job N-1 armed on completion fired — terminating the
    // worker mid-recognition, stalling job N for the full OCR_TIMEOUT_MS and recording a
    // bogus "OCR timed out." instead of the real result.
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    const active = await getWorker();
    try {
      const result = await active.recognize(filePath);
      return { text: result.data.text };
    } finally {
      armIdleTimer();
    }
  },
};

let engine: OcrEngine = defaultEngine;

export function getOcrEngine(): OcrEngine {
  return engine;
}

/** Modelled on setImportHooks() in src/lib/import/hooks.ts. Pass null to restore the real engine. */
export function setOcrEngineForTests(next: OcrEngine | null): void {
  engine = next ?? defaultEngine;
}

/**
 * Test-only seam (IMPORTANT 2 coverage): seeds the cached worker directly with a fake
 * object satisfying TesseractWorkerLike, so getWorker()'s `if (worker) return worker;`
 * cache-hit path is taken and createWorker()/real tesseract.js/WASM are never invoked
 * (MUST-7.17). Only meaningful while the default engine is active — pair with
 * `setOcrEngineForTests(null)`. Pass null to clear without terminating (tests call
 * terminateOcrWorker() themselves when they need to assert on it).
 */
export function setOcrWorkerForTests(fake: TesseractWorkerLike | null): void {
  worker = fake;
}

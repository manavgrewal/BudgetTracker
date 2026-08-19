import { assertOcrAssets, resolveOcrAssets } from '@/lib/warranty/ocr/assets';
import { OcrUnavailableError } from '@/lib/warranty/ocr/engine';

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

/** The tesseract half of releaseOcrEngine(). The idle timer stays in engine.ts, which owns
 *  it for both engines. */
export async function releaseTesseractWorker(): Promise<void> {
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

export async function recognizeWithTesseract(filePath: string): Promise<string> {
  const active = await getWorker();
  const result = await active.recognize(filePath);
  return result.data.text;
}

/**
 * Test-only seam (IMPORTANT 2 coverage): seeds the cached worker directly with a fake
 * object satisfying TesseractWorkerLike, so getWorker()'s `if (worker) return worker;`
 * cache-hit path is taken and createWorker()/real tesseract.js/WASM are never invoked
 * (MUST-7.17). Only meaningful while the default engine is active — pair with
 * `setOcrEngineForTests(null)`. Pass null to clear without terminating (tests call
 * releaseOcrEngine() themselves when they need to assert on it).
 */
export function setOcrWorkerForTests(fake: TesseractWorkerLike | null): void {
  worker = fake;
}

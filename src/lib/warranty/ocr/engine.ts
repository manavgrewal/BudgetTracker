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

// A narrow local type: this is the entire surface the queue relies on.
interface TesseractWorkerLike {
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
  })) as unknown as TesseractWorkerLike;
  return worker;
}

const defaultEngine: OcrEngine = {
  async recognize(filePath: string, mime: ReceiptMime): Promise<OcrResult> {
    if (mime === 'application/pdf') return { text: await extractPdfText(filePath) };
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

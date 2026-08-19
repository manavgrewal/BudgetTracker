import type { ReceiptMime } from '@/lib/warranty/sniff';
import { extractPdfText } from '@/lib/warranty/ocr/pdf';
import { recognizeWithTesseract, releaseTesseractWorker } from '@/lib/warranty/ocr/tesseract';
import { resolveOcrEngineKind } from '@/lib/warranty/ocr/onnx/probe';

export { setOcrWorkerForTests, type TesseractWorkerLike } from '@/lib/warranty/ocr/tesseract';

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

let idleTimer: NodeJS.Timeout | null = null;
// Whether the ONNX tree has ever been loaded in this process. releaseOcrEngine() must not
// import it just to release sessions that were never created, and on hardware the probe
// rejected it is never imported at all.
let onnxTouched = false;

function armIdleTimer(): void {
  if (idleTimer) clearTimeout(idleTimer);
  // MUST-7.10 / risk R5: release the engine's resident memory after 60 s idle.
  idleTimer = setTimeout(() => {
    void releaseOcrEngine();
  }, OCR_IDLE_TERMINATE_MS);
  idleTimer.unref?.();
}

/**
 * Replaces the previous worker-only teardown function. The old name described a process
 * the ONNX path does not have, and an accurate name is cheaper than a comment explaining an
 * inaccurate one. Disposes whichever engine is live, each in its own try/catch.
 */
export async function releaseOcrEngine(): Promise<void> {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  if (onnxTouched) {
    try {
      const { releaseOnnxOcrSessions } = await import('@/lib/warranty/ocr/onnx/session');
      await releaseOnnxOcrSessions();
    } catch (error) {
      // Independent of the tesseract release below: a rejection here must not skip it.
      // Called from `void releaseOcrEngine()` by the idle timer, an unhandled rejection
      // here would also take the whole process down.
      console.warn('[ocr] onnx session release failed', error);
    }
  }
  try {
    await releaseTesseractWorker();
  } catch (error) {
    console.warn('[ocr] tesseract worker release failed', error);
  }
}

const defaultEngine: OcrEngine = {
  async recognize(filePath: string, mime: ReceiptMime): Promise<OcrResult> {
    // A PDF goes to the text layer before anything else: no probe, no session, no engine
    // question. This preserves the current behaviour that a PDF never touches an OCR engine.
    if (mime === 'application/pdf') return { text: await extractPdfText(filePath) };
    // IMPORTANT 2: disarm any pending idle-terminate timer the INSTANT a job claims the
    // engine, before awaiting anything. armIdleTimer() previously only re-armed inside the
    // `finally` below, which left a window where job N's OWN recognize() call could still
    // be in flight when the timer job N-1 armed on completion fired — terminating the
    // engine mid-recognition, stalling job N for the full OCR_TIMEOUT_MS and recording a
    // bogus "OCR timed out." instead of the real result.
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    try {
      const kind = await resolveOcrEngineKind();
      // A run-time ONNX failure that is a normal throw does NOT switch the cached engine
      // and does NOT retry on tesseract. Only the probe decides which engine an install
      // uses; a transient bad receipt must not rewrite install-level configuration.
      if (kind === 'onnx') {
        // Dynamic, so the ONNX tree is never evaluated on an install the probe rejected,
        // and so engine.ts and onnx/models.ts do not form an import cycle.
        const { onnxOcrEngine } = await import('@/lib/warranty/ocr/onnx/engine');
        // Set only after the import resolves: a rejected import must not arm
        // releaseOcrEngine()'s ONNX release path for a tree that was never actually loaded.
        onnxTouched = true;
        return await onnxOcrEngine.recognize(filePath, mime);
      }
      return { text: await recognizeWithTesseract(filePath) };
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

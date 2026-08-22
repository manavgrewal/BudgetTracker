import { SCANNER_LOAD_TIMEOUT_MS } from '@/lib/warranty/ocr/onnx/constants';

/**
 * jscanify 1.4.3's surface, as much of it as the scanner uses. The names are documented but
 * were not verified against the published bundle during design, so scan.ts wraps every call
 * in the catch-all that turns a wrong-name TypeError into an original-file upload.
 */
export interface JscanifyCorners {
  topLeftCorner: { x: number; y: number };
  topRightCorner: { x: number; y: number };
  bottomLeftCorner: { x: number; y: number };
  bottomRightCorner: { x: number; y: number };
}

export interface JscanifyLike {
  findPaperContour(image: unknown): unknown;
  getCornerPoints(contour: unknown): JscanifyCorners;
  extractPaper(canvas: HTMLCanvasElement, width: number, height: number, points?: JscanifyCorners): HTMLCanvasElement;
}

/** A cv.Mat, or anything else the wasm heap owns. Every one of these must be `.delete()`d
 *  explicitly -- the wasm heap does not garbage-collect. */
export interface CvMatLike {
  delete(): void;
}

/**
 * The subset of opencv.js's `cv` used outside this file. `then` is real: the bundle assigns
 * `Module["then"] = function(func){ if (calledRun) func(Module); else { ...call func once
 * onRuntimeInitialized fires... } return Module; }`, which makes `cv` itself a thenable that
 * settles exactly when the wasm runtime is ready -- so `await cv` is the correct wait.
 */
export interface CvLike {
  onRuntimeInitialized?: () => void;
  imread(source: HTMLCanvasElement): CvMatLike;
  // No `value` parameter: the real bundle calls `func(Module)` (i.e. with itself), but typing
  // that as `(value: CvLike) => void` makes `CvLike` reference itself inside its own `then`,
  // which TS rejects (TS1062) the moment something does `await cv`. Nothing here reads the
  // resolved value anyway -- `cv` is already in scope wherever it's awaited.
  then(onfulfilled: () => void, onrejected?: (reason: unknown) => void): void;
}

interface ScannerWindow extends Window {
  Module?: { locateFile: (file: string) => string };
  cv?: CvLike;
  jscanify?: new () => JscanifyLike;
}

let cached: Promise<{ cv: CvLike; scanner: JscanifyLike }> | null = null;

function injectScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const element = document.createElement('script');
    element.src = src;
    element.async = true;
    element.onload = () => resolve();
    element.onerror = () => reject(new Error(`could not load ${src}`));
    document.head.appendChild(element);
  });
}

async function load(): Promise<{ cv: CvLike; scanner: JscanifyLike }> {
  const scope = window as ScannerWindow;
  // Set BEFORE injecting the glue: it resolves its .wasm relative to this hook, and without
  // it the fetch goes to the page's own path and 404s.
  scope.Module = { locateFile: (file: string) => `/scanner/${file}` };
  await injectScript('/scanner/opencv.js');
  const cv = scope.cv;
  if (cv === undefined) throw new Error('opencv.js loaded without defining cv');
  // NOT `typeof cv.onRuntimeInitialized === 'undefined'`: Emscripten leaves that property
  // undefined until code assigns to it, so that check is always true and resolves before the
  // wasm runtime exists. `cv` itself is the thenable the bundle installs -- await it directly.
  await cv;
  await injectScript('/scanner/jscanify.min.js');
  const Jscanify = scope.jscanify;
  if (Jscanify === undefined) throw new Error('jscanify.min.js loaded without defining jscanify');
  return { cv, scanner: new Jscanify() };
}

/**
 * One module-level cached promise. Called ONLY from the uploader's first image pick, never
 * at module scope and never on page load, so a household member who never uploads a photo
 * never downloads 9 MB.
 */
export function loadScanner(): Promise<{ cv: CvLike; scanner: JscanifyLike }> {
  if (cached !== null) return cached;
  cached = Promise.race([
    load(),
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error('scanner load timed out')), SCANNER_LOAD_TIMEOUT_MS);
    }),
  ]).catch((error: unknown) => {
    // A failed load must not poison every later pick with a cached rejection: the next pick
    // gets a fresh attempt, and MUST-8.15 means a failure costs nothing but a plain upload.
    cached = null;
    throw error;
  });
  return cached;
}

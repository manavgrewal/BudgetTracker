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
 * BLOCKER (verified against the shipping public/scanner/opencv.js, byte offset ~8972724):
 * `Module["then"]=function(func){if(calledRun){func(Module)}else{var
 * old=Module["onRuntimeInitialized"];Module["onRuntimeInitialized"]=function(){if(old)old();
 * func(Module)}}return Module}`. `then` is real -- `cv` really is a thenable that settles
 * exactly when the wasm runtime is ready -- but `func(Module)` resolves the callback WITH
 * `Module` itself, i.e. with `cv` again, and `cv.then` is this exact same function. That
 * makes the resolved value itself a thenable whose `then` resolves with itself, forever.
 *
 * `await cv` therefore does not settle: the engine keeps seeing "the resolved value is
 * itself thenable, adopt IT instead of settling" and queues another `PromiseResolveThenableJob`
 * on every turn, recursing until the microtask queue is starved -- worse than the no-op gate
 * this replaced, because the tab hangs (no paint, no input, no upload) instead of resolving
 * early, and neither loadScanner()'s own SCANNER_LOAD_TIMEOUT_MS race nor its `.catch` below
 * can ever run: this promise neither resolves nor rejects. See tests/lib/scanner/load.test.ts
 * for the bounded-iteration harness that reproduces this and the regression test that pins
 * the fix. NEVER `await cv` directly for this reason -- call `cv.then(callback)` and resolve
 * your OWN promise from inside `callback` instead (load() below does exactly this).
 */
export interface CvLike {
  onRuntimeInitialized?: () => void;
  imread(source: HTMLCanvasElement): CvMatLike;
  /**
   * `value` is real -- the bundle calls `func(Module)` -- but its type here is `CvModule`,
   * not `CvLike`. Typing it as `(value: CvLike) => void` makes `CvLike` reference itself
   * inside its own `then`, and the moment any code writes `await cv`, TypeScript has to
   * resolve `Awaited<CvLike>` to type that expression, which recurses into resolving
   * `Awaited<CvLike>` again and fails with TS1062 ("referenced directly or indirectly in its
   * own type annotation"). `CvModule` below is a plain, non-thenable subset with no `then` of
   * its own, which breaks that cycle. Nothing in this codebase reads the resolved value
   * anyway (see this interface's own docblock for why `await cv` itself must never be
   * written), so the narrower type costs every real call site nothing.
   */
  then(onfulfilled: (value: CvModule) => void, onrejected?: (reason: unknown) => void): void;
}

/** The non-thenable shape `CvLike.then`'s callback is actually handed -- see `CvLike`'s own
 *  docblock for why this is a separate interface rather than `(value: CvLike) => void`. */
export interface CvModule {
  imread(source: HTMLCanvasElement): CvMatLike;
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
  // wasm runtime exists. `cv` itself is the thenable the bundle installs, but `await cv`
  // directly hangs forever (see CvLike's docblock above): the value it resolves with is
  // itself the same self-referential thenable, so `await` keeps adopting it instead of ever
  // settling. Call `.then()` ourselves and resolve a plain promise of our own from inside the
  // callback, discarding whatever value it is handed -- resolving with `undefined` rather
  // than adopting the thenable is the entire fix.
  await new Promise<void>((resolve) => {
    cv.then(() => resolve());
  });
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

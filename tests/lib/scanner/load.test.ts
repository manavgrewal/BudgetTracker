// @vitest-environment jsdom
//
// B5: load.ts's runtime-init gate read `if (typeof cv.onRuntimeInitialized === 'undefined') {
// resolve(); return; }`. Emscripten leaves that property undefined until code assigns to it,
// so the condition was always true, and loadScanner() resolved before the wasm runtime existed
// -- B1 masked this (every call failed anyway), but fixing B1 alone would have left a race: the
// first pick after every page load would usually lose a ~7MB wasm compile on a phone.
//
// This drives the real loadScanner()/load() against a controllable fake `cv` and asserts it
// only proceeds -- and only resolves -- once the fake's `.then()` callback actually fires,
// proving the gate now genuinely waits on the runtime instead of checking a property that is
// never set. jsdom does not execute injected <script src> tags, so script "loading" is
// simulated by recording the elements load.ts creates and firing their onload ourselves once
// we have set the global each script would really have defined.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let scripts: HTMLScriptElement[] = [];
let restore: (() => void) | undefined;

beforeEach(() => {
  vi.resetModules();
  scripts = [];
  const original = document.createElement.bind(document) as (
    tagName: string,
    options?: ElementCreationOptions,
  ) => HTMLElement;
  const spy = vi
    .spyOn(document, 'createElement')
    .mockImplementation(((tagName: string, options?: ElementCreationOptions) => {
      const element = original(tagName, options);
      if (tagName === 'script') scripts.push(element as HTMLScriptElement);
      return element;
    }) as typeof document.createElement);
  restore = () => spy.mockRestore();
  delete (window as unknown as { cv?: unknown }).cv;
  delete (window as unknown as { jscanify?: unknown }).jscanify;
});

afterEach(() => {
  restore?.();
  vi.restoreAllMocks();
});

describe('B5: loadScanner waits for the wasm runtime, not a synthetic gate', () => {
  it('blocks on jscanify.min.js, and on resolving, until the cv thenable actually fires', async () => {
    const { loadScanner } = await import('@/lib/scanner/load');

    let runtimeReady: (() => void) | undefined;
    const fakeCv = {
      then: vi.fn((onfulfilled: () => void) => {
        runtimeReady = onfulfilled;
      }),
    };
    class FakeJscanify {}

    const resultPromise = loadScanner();

    // Synchronous up to here: load() ran until its first real `await` (injectScript's
    // Promise), which had already created and appended the opencv.js <script>.
    expect(scripts).toHaveLength(1);
    expect(scripts[0].src).toContain('/scanner/opencv.js');

    (window as unknown as { cv: unknown }).cv = fakeCv;
    scripts[0].onload?.(new Event('load'));

    // Let load() resume past `await injectScript(...)` and reach `await cv`.
    await vi.waitFor(() => expect(fakeCv.then).toHaveBeenCalledTimes(1));
    // The OLD gate never called `.then` at all: it resolved as soon as it read
    // `typeof cv.onRuntimeInitialized`, which is always 'undefined'. Reaching this line at
    // all is already proof the fixed code awaits the thenable instead of that property.
    expect(runtimeReady).toBeDefined();

    // It must still be BLOCKED: jscanify.min.js must not load, and loadScanner()'s own promise
    // must not resolve, until the callback we were just handed is actually invoked.
    expect(scripts).toHaveLength(1);
    const settledEarly = await Promise.race([
      resultPromise.then(() => 'resolved' as const),
      new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 20)),
    ]);
    expect(settledEarly).toBe('pending');

    // Now let the runtime "finish initialising".
    runtimeReady?.();
    await vi.waitFor(() => expect(scripts).toHaveLength(2));
    expect(scripts[1].src).toContain('/scanner/jscanify.min.js');

    (window as unknown as { jscanify: unknown }).jscanify = FakeJscanify;
    scripts[1].onload?.(new Event('load'));

    const result = await resultPromise;
    expect(result.cv).toBe(fakeCv);
    expect(result.scanner).toBeInstanceOf(FakeJscanify);
  });

  it('resolves promptly when the runtime is already initialised (the fast path)', async () => {
    const { loadScanner } = await import('@/lib/scanner/load');

    const fakeCv = { then: vi.fn((onfulfilled: () => void) => onfulfilled()) };
    class FakeJscanify {}

    const resultPromise = loadScanner();
    (window as unknown as { cv: unknown }).cv = fakeCv;
    scripts[0].onload?.(new Event('load'));

    await vi.waitFor(() => expect(scripts).toHaveLength(2));
    (window as unknown as { jscanify: unknown }).jscanify = FakeJscanify;
    scripts[1].onload?.(new Event('load'));

    const result = await resultPromise;
    expect(result.cv).toBe(fakeCv);
    expect(result.scanner).toBeInstanceOf(FakeJscanify);
  });
});

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  OCR_IDLE_TERMINATE_MS,
  getOcrEngine,
  setOcrEngineForTests,
  setOcrWorkerForTests,
  terminateOcrWorker,
  type TesseractWorkerLike,
} from '@/lib/warranty/ocr/engine';

/**
 * IMPORTANT 2: armIdleTimer() previously only re-armed the idle-terminate timer inside
 * `finally`, after a job finished. That left a window where job N's OWN recognize() call
 * could still be in flight when the timer job N-1 armed on ITS completion fired, terminating
 * a worker that a live job was actively using. This exercises the REAL defaultEngine (not a
 * fake OcrEngine) via setOcrWorkerForTests, which seeds the module's cached worker directly
 * so getWorker()'s cache-hit path is taken and createWorker()/real tesseract.js/WASM are
 * never invoked (MUST-7.17).
 */
afterEach(async () => {
  vi.useRealTimers();
  await terminateOcrWorker();
  setOcrWorkerForTests(null);
  setOcrEngineForTests(null);
});

describe('idle-terminate timer does not fire on a worker a job is actively using', () => {
  it('disarms the pending idle timer the instant a second job claims the worker, even if the timer would have fired mid-recognition', async () => {
    vi.useFakeTimers();
    setOcrEngineForTests(null); // ensure the real defaultEngine is active

    const terminate = vi.fn(async () => {});
    let resolveJob2!: (value: { data: { text: string } }) => void;
    const job2Result = new Promise<{ data: { text: string } }>((resolve) => {
      resolveJob2 = resolve;
    });
    let calls = 0;
    const fake: TesseractWorkerLike = {
      recognize: async () => {
        calls += 1;
        if (calls === 1) return { data: { text: 'first' } };
        return job2Result;
      },
      terminate,
    };
    setOcrWorkerForTests(fake);

    // Job 1 completes quickly. Its `finally` arms a 60 s idle-terminate timer.
    const first = await getOcrEngine().recognize('/tmp/a.jpg', 'image/jpeg');
    expect(first.text).toBe('first');

    // Advance to just before the idle deadline, then start job 2 — this call must disarm
    // the pending timer BEFORE its own (still in-flight) recognize() call can be hit by it.
    await vi.advanceTimersByTimeAsync(OCR_IDLE_TERMINATE_MS - 5000);
    const job2 = getOcrEngine().recognize('/tmp/b.jpg', 'image/jpeg');

    // Advance well past the ORIGINAL idle deadline while job 2 is still awaiting its
    // recognize() call. If the timer were not disarmed, this would terminate the worker
    // out from under job 2.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(terminate).not.toHaveBeenCalled();

    resolveJob2({ data: { text: 'second' } });
    const second = await job2;
    expect(second.text).toBe('second');
    expect(terminate).not.toHaveBeenCalled();
  });

  it('still terminates on a fresh idle timer once the worker is genuinely idle again', async () => {
    vi.useFakeTimers();
    setOcrEngineForTests(null);

    const terminate = vi.fn(async () => {});
    const fake: TesseractWorkerLike = {
      recognize: async () => ({ data: { text: 'ok' } }),
      terminate,
    };
    setOcrWorkerForTests(fake);

    await getOcrEngine().recognize('/tmp/a.jpg', 'image/jpeg');
    await vi.advanceTimersByTimeAsync(OCR_IDLE_TERMINATE_MS + 1000);
    expect(terminate).toHaveBeenCalledTimes(1);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { OCR_PROBE_OK_LINE, OCR_PROBE_TIMEOUT_MS } from '@/lib/warranty/ocr/onnx/constants';
import { readOcrEngineState, resetOcrProbeForTests, resolveOcrEngineKind } from '@/lib/warranty/ocr/onnx/probe';
import { createSeededTestDb, type TestDb } from '../../../helpers/db';

/**
 * probe.test.ts drives the signal row with a real, self-killing child process, which only
 * runs where a POSIX signal exists to raise (it is skipped on Windows). This file replaces
 * spawn with a fake EventEmitter so the signal row and the timeout row of MUST-5.8's table
 * run deterministically on every platform, without a real OS signal and without a real 60
 * second wait.
 */
const spawnMock = vi.fn();

vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
}

function makeFakeChild(): FakeChild {
  const fake = new EventEmitter() as FakeChild;
  fake.stdout = new EventEmitter();
  fake.stderr = new EventEmitter();
  fake.kill = vi.fn();
  return fake;
}

let current: TestDb | null = null;
let child: FakeChild;

beforeEach(() => {
  current = createSeededTestDb();
  resetOcrProbeForTests();
  spawnMock.mockReset();
  spawnMock.mockImplementation(() => {
    child = makeFakeChild();
    return child;
  });
});

afterEach(() => {
  vi.useRealTimers();
  resetOcrProbeForTests();
  current?.cleanup();
  current = null;
});

describe('MUST-5.8: the signal row, on a fake child so it runs on every platform', () => {
  it('a signal exit with no output gives tesseract and names the signal', async () => {
    const promise = resolveOcrEngineKind();
    child.emit('exit', null, 'SIGILL');
    expect(await promise).toBe('tesseract');
    expect(readOcrEngineState().detail).toMatch(/killed by SIGILL/);
  });

  it('the A7 crash-loop case: the ok line is already buffered on stdout when the signal kills the child, and the verdict is still tesseract', async () => {
    const promise = resolveOcrEngineKind();
    // The child got far enough to print success, then died anyway. child.on('exit') reports
    // code === null here, and the signal check must run before any code check or before the
    // buffered stdout is trusted — otherwise the ok line already sitting in the buffer would
    // win and the verdict would be 'onnx' on hardware that just proved it cannot run ONNX.
    child.stdout.emit('data', Buffer.from(`${OCR_PROBE_OK_LINE}\n`));
    child.emit('exit', null, 'SIGILL');
    expect(await promise).toBe('tesseract');
    expect(readOcrEngineState().detail).toMatch(/killed by SIGILL/);
  });
});

describe('MUST-5.8: the timeout row', () => {
  it('kills the child with SIGKILL and records a timeout verdict distinct from a signal-kill verdict', async () => {
    vi.useFakeTimers();
    const promise = resolveOcrEngineKind();
    await vi.advanceTimersByTimeAsync(OCR_PROBE_TIMEOUT_MS);
    expect(await promise).toBe('tesseract');
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    const detail = readOcrEngineState().detail ?? '';
    // Proves the child was killed rather than left resolved-and-leaked, and that the reason
    // recorded is the timeout, not a signal-kill message racing in from the same child.
    expect(detail).toMatch(/timed out/);
    expect(detail).toContain(String(OCR_PROBE_TIMEOUT_MS));
    expect(detail).not.toMatch(/killed by SIG/);
  });
});

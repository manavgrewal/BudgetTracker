import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getSetting, setSetting } from '@/lib/settings';
import { APP_VERSION } from '@/lib/version';
import { OCR_PROBE_DETAIL_MAX_CHARS, OCR_PROBE_OK_LINE } from '@/lib/warranty/ocr/onnx/constants';
import {
  SETTING_OCR_ENGINE,
  SETTING_OCR_ENGINE_PROBED_VERSION,
  SETTING_OCR_ENGINE_PROBE_AT,
  SETTING_OCR_ENGINE_PROBE_DETAIL,
  probeCacheKey,
  readOcrEngineState,
  resetOcrProbeForTests,
  resolveOcrEngineKind,
  setProbeScriptPathForTests,
} from '@/lib/warranty/ocr/onnx/probe';
import { createSeededTestDb, type TestDb } from '../../../helpers/db';

let current: TestDb | null = null;
let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-ocr-probe-'));
  current = createSeededTestDb();
  resetOcrProbeForTests();
});

afterEach(() => {
  setProbeScriptPathForTests(null);
  resetOcrProbeForTests();
  current?.cleanup();
  current = null;
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A fake probe script written to a temp directory, so every verdict row is driven by a
 *  real child process without loading a real model. */
function fakeScript(name: string, body: string): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, body, 'utf8');
  setProbeScriptPathForTests(file);
  return file;
}

describe('the cache (MUST-5.6, MUST-5.10, MUST-12.5)', () => {
  it('returns a matching cached verdict without spawning', async () => {
    fakeScript('never.mjs', 'process.exit(3);');
    setSetting(SETTING_OCR_ENGINE, 'onnx');
    setSetting(SETTING_OCR_ENGINE_PROBED_VERSION, probeCacheKey());
    expect(await resolveOcrEngineKind()).toBe('onnx');
    // A spawn would have recorded a fresh timestamp.
    expect(getSetting(SETTING_OCR_ENGINE_PROBE_AT)).toBeNull();
  });

  it('re-probes when the version differs', async () => {
    fakeScript('ok.mjs', `console.log('${OCR_PROBE_OK_LINE}');`);
    setSetting(SETTING_OCR_ENGINE, 'tesseract');
    setSetting(SETTING_OCR_ENGINE_PROBED_VERSION, `0.0.1/${process.arch}`);
    expect(await resolveOcrEngineKind()).toBe('onnx');
  });

  it('re-probes when the architecture differs, so a cross-architecture restore cannot lie', async () => {
    fakeScript('ok.mjs', `console.log('${OCR_PROBE_OK_LINE}');`);
    setSetting(SETTING_OCR_ENGINE, 'tesseract');
    setSetting(SETTING_OCR_ENGINE_PROBED_VERSION, `${APP_VERSION}/not-this-arch`);
    expect(await resolveOcrEngineKind()).toBe('onnx');
    expect(getSetting(SETTING_OCR_ENGINE_PROBED_VERSION)).toBe(`${APP_VERSION}/${process.arch}`);
  });

  it('re-probes when the cached engine value is corrupt or unrecognized, rather than trusting it', async () => {
    fakeScript('ok.mjs', `console.log('${OCR_PROBE_OK_LINE}');`);
    setSetting(SETTING_OCR_ENGINE, 'not-a-real-engine-kind');
    setSetting(SETTING_OCR_ENGINE_PROBED_VERSION, probeCacheKey());
    expect(await resolveOcrEngineKind()).toBe('onnx');
    expect(getSetting(SETTING_OCR_ENGINE)).toBe('onnx');
  });
});

describe('MUST-5.8: the verdict table, every row', () => {
  it('exit 0 with the ok line gives onnx and deletes the detail', async () => {
    setSetting(SETTING_OCR_ENGINE_PROBE_DETAIL, 'stale');
    fakeScript('ok.mjs', `console.log('${OCR_PROBE_OK_LINE}');`);
    expect(await resolveOcrEngineKind()).toBe('onnx');
    expect(readOcrEngineState().detail).toBeNull();
  });

  it('exit 0 without the ok line gives tesseract', async () => {
    fakeScript('silent.mjs', 'process.exit(0);');
    expect(await resolveOcrEngineKind()).toBe('tesseract');
    expect(readOcrEngineState().detail).toBe('probe exited cleanly without confirming');
  });

  // Self-directed process.kill with a POSIX-only signal name throws ENOSYS on Windows
  // (matches the guard in tests/lib/env.test.ts): there is no real signal to raise on this
  // dev platform, so this scenario is only exercisable on the Linux deployment target here.
  // skipIf reports a skip rather than a silent pass, so coverage is never overstated.
  // The signal branch itself is exercised on every platform by probe-mocked-child.test.ts.
  it.skipIf(process.platform === 'win32')(
    'a killing signal gives tesseract and names the signal, and does not take the code === 0 branch',
    async () => {
      fakeScript('sigill.mjs', `console.log('${OCR_PROBE_OK_LINE}');\nprocess.kill(process.pid, 'SIGILL');\nawait new Promise(() => {});`);
      expect(await resolveOcrEngineKind()).toBe('tesseract');
      expect(readOcrEngineState().detail).toMatch(/killed by SIG/);
    },
  );

  it('a nonzero exit gives tesseract with the first 200 characters of stderr, newlines collapsed', async () => {
    fakeScript('boom.mjs', "console.error('line one\\nline two');\nprocess.exit(3);");
    expect(await resolveOcrEngineKind()).toBe('tesseract');
    const detail = readOcrEngineState().detail ?? '';
    expect(detail).toBe('line one line two');
    expect(detail.length).toBeLessThanOrEqual(OCR_PROBE_DETAIL_MAX_CHARS);
  });

  it('truncates stderr to exactly OCR_PROBE_DETAIL_MAX_CHARS, so a multi-megabyte stack trace cannot land whole in a settings row', async () => {
    const long = 'x'.repeat(OCR_PROBE_DETAIL_MAX_CHARS + 500);
    fakeScript('longboom.mjs', `console.error(${JSON.stringify(long)});\nprocess.exit(3);`);
    expect(await resolveOcrEngineKind()).toBe('tesseract');
    const detail = readOcrEngineState().detail ?? '';
    expect(detail).toBe('x'.repeat(OCR_PROBE_DETAIL_MAX_CHARS));
    expect(detail.length).toBe(OCR_PROBE_DETAIL_MAX_CHARS);
  });

  it('a spawn error gives tesseract and names the code', async () => {
    setProbeScriptPathForTests(path.join(dir, 'does', 'not', 'exist.mjs'));
    expect(await resolveOcrEngineKind()).toBe('tesseract');
    expect(readOcrEngineState().detail).toMatch(/probe could not start|MODULE_NOT_FOUND|Cannot find module/);
  });
});

describe('the settings write (MUST-5.9, MUST-12.2)', () => {
  it('writes all three keys before the promise resolves', async () => {
    fakeScript('ok.mjs', `console.log('${OCR_PROBE_OK_LINE}');`);
    await resolveOcrEngineKind().then(() => {
      expect(getSetting(SETTING_OCR_ENGINE)).toBe('onnx');
      expect(getSetting(SETTING_OCR_ENGINE_PROBED_VERSION)).toBe(probeCacheKey());
      expect(getSetting(SETTING_OCR_ENGINE_PROBE_AT)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });
});

describe('single flight (MUST-5.6 step 1)', () => {
  it('two concurrent calls spawn exactly one child', async () => {
    const marker = path.join(dir, 'spawns.txt');
    fakeScript(
      'counting.mjs',
      `import fs from 'node:fs';\nfs.appendFileSync(${JSON.stringify(marker)}, 'x');\nawait new Promise((r) => setTimeout(r, 50));\nconsole.log('${OCR_PROBE_OK_LINE}');`,
    );
    const [a, b] = await Promise.all([resolveOcrEngineKind(), resolveOcrEngineKind()]);
    expect(a).toBe('onnx');
    expect(b).toBe('onnx');
    expect(fs.readFileSync(marker, 'utf8')).toBe('x');
  });
});

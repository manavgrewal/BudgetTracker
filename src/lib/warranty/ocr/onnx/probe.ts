import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  OCR_PROBE_DETAIL_MAX_CHARS,
  OCR_PROBE_OK_LINE,
  OCR_PROBE_TIMEOUT_MS,
} from '@/lib/warranty/ocr/onnx/constants';
import { deleteSetting, getSetting, setSetting } from '@/lib/settings';
import { APP_VERSION } from '@/lib/version';

// MUST-12.2: this module owns every settings key beginning `ocr.` and no other module writes
// one. The protocol numbers live in constants.ts, because this file sits under onnx/ and
// MUST-4.41's grep bans a bare 200 anywhere in that tree.
export const SETTING_OCR_ENGINE = 'ocr.engine';
export const SETTING_OCR_ENGINE_PROBED_VERSION = 'ocr.engine_probed_version';
export const SETTING_OCR_ENGINE_PROBE_AT = 'ocr.engine_probe_at';
export const SETTING_OCR_ENGINE_PROBE_DETAIL = 'ocr.engine_probe_detail';

export type OcrEngineKind = 'onnx' | 'tesseract';

export interface OcrEngineState {
  engine: OcrEngineKind | null;
  probedVersion: string | null;
  probedAt: string | null;
  detail: string | null;
}

/**
 * Keyed on the architecture as well as the version. A backup restored from an amd64 machine
 * onto an arm64 NAS re-probes, because a cached "this CPU is fine" verdict must never be
 * carried onto a CPU that is not.
 */
export function probeCacheKey(): string {
  return `${APP_VERSION}/${process.arch}`;
}

function isKind(value: string | null): value is OcrEngineKind {
  return value === 'onnx' || value === 'tesseract';
}

/** The single reader over the four keys, so no caller assembles this from loose getSetting
 *  calls. */
export function readOcrEngineState(): OcrEngineState {
  const engine = getSetting(SETTING_OCR_ENGINE);
  return {
    engine: isKind(engine) ? engine : null,
    probedVersion: getSetting(SETTING_OCR_ENGINE_PROBED_VERSION),
    probedAt: getSetting(SETTING_OCR_ENGINE_PROBE_AT),
    detail: getSetting(SETTING_OCR_ENGINE_PROBE_DETAIL),
  };
}

let inFlight: Promise<OcrEngineKind> | null = null;
let scriptPathOverride: string | null = null;

export function resetOcrProbeForTests(): void {
  inFlight = null;
  // Also clear the script override. A leaked override surviving into another suite in the
  // same worker would silently point the probe at a deleted temp file.
  scriptPathOverride = null;
}

export function setProbeScriptPathForTests(scriptPath: string | null): void {
  scriptPathOverride = scriptPath;
}

function probeScriptPath(): string {
  return scriptPathOverride ?? path.join(process.cwd(), 'scripts', 'ocr-probe.mjs');
}

function record(kind: OcrEngineKind, detail: string | null): void {
  setSetting(SETTING_OCR_ENGINE, kind);
  setSetting(SETTING_OCR_ENGINE_PROBED_VERSION, probeCacheKey());
  setSetting(SETTING_OCR_ENGINE_PROBE_AT, new Date().toISOString());
  if (detail === null) deleteSetting(SETTING_OCR_ENGINE_PROBE_DETAIL);
  else setSetting(SETTING_OCR_ENGINE_PROBE_DETAIL, detail);
}

interface Outcome {
  kind: OcrEngineKind;
  detail: string | null;
}

function runProbe(): Promise<Outcome> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (outcome: Outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };

    // Never spawnSync: a synchronous 60 second worst case would freeze the HTTP server.
    const child = spawn(process.execPath, [probeScriptPath()], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      // Derived from the constant rather than written as its own literal, so the reason
      // recorded on the Settings surface cannot drift from the value actually enforced.
      finish({ kind: 'tesseract', detail: `probe timed out after ${OCR_PROBE_TIMEOUT_MS} ms` });
    }, OCR_PROBE_TIMEOUT_MS);
    timer.unref?.();

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on('error', (error: NodeJS.ErrnoException) => {
      finish({ kind: 'tesseract', detail: `probe could not start: ${error.code ?? error.message}` });
    });

    child.on('exit', (code, signal) => {
      // The signal branch comes FIRST. child.on('exit') reports code === null when a signal
      // killed the process, and code that only checks code !== 0 mishandles exactly the
      // case this whole mechanism was built for.
      if (signal !== null) {
        finish({ kind: 'tesseract', detail: `probe process was killed by ${signal}` });
        return;
      }
      if (code !== 0) {
        const detail = stderr.replace(/\s*\n\s*/g, ' ').trim().slice(0, OCR_PROBE_DETAIL_MAX_CHARS);
        finish({ kind: 'tesseract', detail: detail.length > 0 ? detail : `probe exited with code ${code}` });
        return;
      }
      const lastLine = stdout
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .at(-1);
      if (lastLine === OCR_PROBE_OK_LINE) finish({ kind: 'onnx', detail: null });
      else finish({ kind: 'tesseract', detail: 'probe exited cleanly without confirming' });
    });
  });
}

/**
 * Runs at most once per image version per architecture, ever. It runs inside a queue job,
 * which is already off the request path, never at boot, never on a page render and never
 * from a server action.
 */
export async function resolveOcrEngineKind(): Promise<OcrEngineKind> {
  // A module-level in-flight promise, because the boot sweep can enqueue several jobs at
  // once and they must not each spawn a child.
  if (inFlight !== null) return inFlight;

  const cached = readOcrEngineState();
  if (cached.engine !== null && cached.probedVersion === probeCacheKey()) return cached.engine;

  inFlight = (async () => {
    const outcome = await runProbe();
    // Written before this promise resolves, so a crash between the probe and the first
    // receipt does not re-probe.
    record(outcome.kind, outcome.detail);
    if (outcome.detail !== null) console.warn(`[ocr] compatibility probe failed: ${outcome.detail}`);
    return outcome.kind;
  })().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

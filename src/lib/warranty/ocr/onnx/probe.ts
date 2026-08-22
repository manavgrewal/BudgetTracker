import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  OCR_PROBE_DETAIL_MAX_CHARS,
  OCR_PROBE_OK_LINE,
  OCR_PROBE_TIMEOUT_MS,
} from '@/lib/warranty/ocr/onnx/constants';
import { readEnv } from '@/lib/env';
import { deleteSetting, getIntSetting, getSetting, setSetting } from '@/lib/settings';
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
  // Defect fix (v1.5.0): OCR_ENGINE, when set, wins over BOTH the cache below and a fresh
  // probe — checked first, before touching `inFlight` or `cached`, so an admin recovering a
  // broken install never spawns a probe child they no longer need. This is the only way back
  // to a working engine when the armed one throws on every receipt: there is no Settings
  // control for this, and deleting the cache (INSTALL.md's cross-machine-restore note) just
  // re-probes and answers the same verdict again.
  const override = readEnv().ocrEngineOverride;
  if (override !== null) return override;

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

/**
 * Defect fix (v1.5.0): a SYNCHRONOUS, side-effect-free answer to "which engine would a
 * receipt use right now", for Settings -> About to render. It deliberately does NOT call
 * resolveOcrEngineKind(): that function may spawn the probe child, and a probe must never run
 * from a page render (same rule the module docblock above states for boot and server actions).
 * Mirrors resolveOcrEngineKind()'s own precedence — override, then a cache hit for THIS
 * version/arch — and returns null for exactly the cases that function would still need to do
 * work to answer: no override, and either no probe yet or a stale one.
 */
export function readEffectiveOcrEngine(): OcrEngineKind | null {
  const override = readEnv().ocrEngineOverride;
  if (override !== null) return override;
  const cached = readOcrEngineState();
  if (cached.engine !== null && cached.probedVersion === probeCacheKey()) return cached.engine;
  return null;
}

// --- Crash guard (defect fix, v1.5.0) ---------------------------------------------------
//
// MUST-12.2 above makes this file the sole owner of every settings key beginning `ocr.`; the
// three keys below extend that ownership to the poison-pill guard src/lib/warranty/ocr/queue.ts
// needs. No migration — AC9 forbids one for this release, and `settings` is already a
// key/value table, exactly the reasoning update/state.ts already relies on for its own
// apply-requested marker.
//
// Shape: queue.ts marks the job about to run BEFORE calling the engine, and clears the mark
// in a `finally` on ANY normal completion — a success, or a failure the job's own try/catch
// already handled. If the whole process dies mid-run instead (an OOM-kill, a SIGILL the probe
// missed), the mark survives to the next boot with no matching clear, which is the proof: only
// a process death leaves it behind.
//
// A single stale mark is forgiven rather than condemned immediately, because a clean container
// restart landing mid-run (a host reboot, `docker compose restart`) leaves exactly the same
// evidence and is not the receipt's fault. OCR_CRASH_ATTEMPT_LIMIT draws that line; see its
// own comment for why that specific number.
export const SETTING_OCR_INFLIGHT_JOB = 'ocr.inflight_job';
export const SETTING_OCR_CRASH_JOB = 'ocr.crash_job';
export const SETTING_OCR_CRASH_ATTEMPTS = 'ocr.crash_attempts';

/**
 * How many times the SAME job may be found crashed-in-flight at boot before it is condemned
 * instead of retried again. The first two are forgiven: one unlucky restart landing mid-run is
 * ordinary NAS behaviour (a DSM update, a power blip with a UPS-triggered clean shutdown), and
 * a second coincidence is still more plausible than not. The third is condemned — by then the
 * far likelier explanation is that this specific receipt reliably kills the process, and every
 * further retry is a full outage of the whole app for the whole household, not a delayed
 * receipt, so the cost of one more "benefit of the doubt" outweighs the cost of being wrong
 * about a merely-unlucky one.
 */
export const OCR_CRASH_ATTEMPT_LIMIT = 3;

export interface OcrCrashGuardState {
  /** Set only while a job is physically running. Present at boot => that job killed the process. */
  inFlightJobKey: string | null;
  /** Which job key `crashAttempts` below is counting for. */
  crashJobKey: string | null;
  crashAttempts: number;
}

export function readOcrCrashGuardState(): OcrCrashGuardState {
  return {
    inFlightJobKey: getSetting(SETTING_OCR_INFLIGHT_JOB),
    crashJobKey: getSetting(SETTING_OCR_CRASH_JOB),
    crashAttempts: getIntSetting(SETTING_OCR_CRASH_ATTEMPTS, 0),
  };
}

/** Called by queue.ts immediately before it calls the engine — before anything can crash. */
export function markOcrJobInFlight(jobKey: string): void {
  setSetting(SETTING_OCR_INFLIGHT_JOB, jobKey);
}

/**
 * Called by queue.ts in a `finally` wrapped around every job, whatever the outcome: the
 * process is still alive to run this line, so THIS job did not crash it. Wipes any earlier
 * crash history too — a job that finishes cleanly, even by failing normally, has proven
 * itself and deserves a clean slate the next time it is unlucky.
 */
export function clearOcrCrashGuard(): void {
  deleteSetting(SETTING_OCR_INFLIGHT_JOB);
  deleteSetting(SETTING_OCR_CRASH_JOB);
  deleteSetting(SETTING_OCR_CRASH_ATTEMPTS);
}

/** Called only by the boot crash reconciler's "forgive" branch (queue.ts). */
export function recordOcrJobCrashSurvived(jobKey: string, attempts: number): void {
  setSetting(SETTING_OCR_CRASH_JOB, jobKey);
  setSetting(SETTING_OCR_CRASH_ATTEMPTS, String(attempts));
  deleteSetting(SETTING_OCR_INFLIGHT_JOB);
}

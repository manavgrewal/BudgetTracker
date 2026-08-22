/**
 * Node-only half of the boot hook, split out of instrumentation.ts so that
 * Next's Edge-runtime compiler pass never has to resolve better-sqlite3/node-cron
 * (both are native/CJS-only and have no Edge-compatible build). instrumentation.ts
 * only ever `import()`s this file behind a NEXT_RUNTIME === 'nodejs' check, so the
 * Edge compilation of that file stays trivially side-effect free.
 */
import { getDb } from '@/db/client';
import { RESTART_EXIT_CODE, applyStagedRestoreOnBoot } from '@/lib/backup/restore';
import { raiseRestoreOutcome } from '@/lib/notify/raise';
import { startScheduler } from '@/lib/scheduler';
import { reconcileApplyOnBoot } from '@/lib/update/state';
import { clearOcrInFlightMarkerOnShutdown } from '@/lib/warranty/ocr/onnx/probe';
import { assertOcrAssets, resolveOcrAssets } from '@/lib/warranty/ocr/assets';
import { reconcileOcrCrashOnBoot } from '@/lib/warranty/ocr/queue';

// MUST-20.26: FIRST, before anything can open the database. This ordering is load-bearing
// and tests/ops/restore-seams.test.ts pins it: src/db/client.ts builds its singleton lazily
// inside ensureInstance(), so the import above is inert, and Next awaits register() before
// the server accepts a request, so no route module can beat this to the database either.
const restoreOutcome = applyStagedRestoreOnBoot();

// MUST-20.23 (T1 review, CRITICAL): a 'restart' outcome means a commit was interrupted
// mid-step and has NOT exhausted its retry cap. commit.json still exists and the live
// budget.db may currently be missing or mid-transition. getDb() would CREATE a fresh, empty,
// migrated database at exactly the path the interrupted commit still needs to finish writing
// to, and the app would serve (and could accept writes into) that empty database until the
// next restart silently overwrote it. Exiting here instead (the same RESTART_EXIT_CODE and
// restart-policy path already used after a GUI-staged restore, MUST-20.28) lets the next
// boot resume the same commit.json under the same attempt cap, and getDb() below is never
// reached while a commit might still be in flight.
if (restoreOutcome === 'restart') {
  console.error('[restore] a commit is mid-flight; exiting to retry on the next boot');
  process.exit(RESTART_EXIT_CODE);
}

// Opening the database here also applies the pragmas and runs migrations on boot. This is
// how a restored older backup migrates forward (MUST-20.24).
getDb();

// MUST-7.6: one line, either way. Missing assets DO NOT crash the app. Receipts still
// upload and OCR jobs simply record 'failed' with "OCR engine unavailable on this
// install." A warranty tracker without OCR is still a warranty tracker; a container that
// refuses to boot is not.
const ocr = assertOcrAssets();
if (ocr.ok) {
  console.log(`[ocr] assets ok (${resolveOcrAssets().langPath})`);
} else {
  console.error(`[ocr] MISSING: ${ocr.missing.join(', ')}`);
}

// MUST-14.2: AFTER the database is open above (the outcome has to be written into the
// restored database) and BEFORE the scheduler starts below (whose immediate boot tick then
// drains the row). The guard is mandatory: a notification failure must never stop the app
// from booting.
try {
  raiseRestoreOutcome();
} catch (error) {
  console.error('[notify] restore outcome raise failed', error);
}

// update spec MUST-7.6: AFTER getDb() above (the outcome is written into the restored
// database) and BEFORE the scheduler starts below. reconcileApplyOnBoot is internally
// guarded (update spec MUST-7.7) and never throws today; this catch is the same
// belt-and-braces the raise above carries, so a future change to that guarantee cannot
// take the boot down with it.
try {
  reconcileApplyOnBoot();
} catch (error) {
  console.error('[update] boot reconciliation failed', error);
}

// Defect fix (v1.5.0): AFTER getDb() (the condemned row/sidecar is written into the restored
// database) and BEFORE startScheduler() below, whose immediate boot sweep must see the
// outcome — a receipt this reconciler condemns has to already be 'failed', not 'pending',
// before that sweep decides what to re-enqueue. reconcileOcrCrashOnBoot is internally guarded
// (it never throws today); this catch is the same belt-and-braces the two reconcilers above
// already carry.
try {
  reconcileOcrCrashOnBoot();
} catch (error) {
  console.error('[ocr] crash reconciliation failed', error);
}

startScheduler();

// Defect fix (v1.5.0, F2): `docker compose restart`/`stop` sends SIGTERM, and a foregrounded
// `docker compose up` stopped with Ctrl-C sends SIGINT — neither is a crash, but Node's
// default action for both is an immediate, silent exit with no chance to run this line, and
// once ANY handler is registered for a signal that default is replaced, so this handler is
// also on the hook for actually terminating the process afterwards. Without this, an admin
// restarting the container mid-job (exactly what setting OCR_ENGINE, see src/lib/env.ts,
// requires) leaves the same ocr.inflight_job marker a real crash leaves, and
// reconcileOcrCrashOnBoot() (queue.ts) cannot tell a clean restart from a crash.
function handleShutdownSignal(signal: NodeJS.Signals): void {
  try {
    clearOcrInFlightMarkerOnShutdown();
  } catch (error) {
    console.error('[shutdown] failed to clear the OCR in-flight marker', error);
  }
  console.log(`[shutdown] received ${signal}, exiting`);
  process.exit(0);
}

process.on('SIGTERM', () => handleShutdownSignal('SIGTERM'));
process.on('SIGINT', () => handleShutdownSignal('SIGINT'));

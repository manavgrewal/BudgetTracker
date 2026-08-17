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
import { assertOcrAssets, resolveOcrAssets } from '@/lib/warranty/ocr/assets';

// MUST-20.26: FIRST, before anything can open the database. This ordering is load-bearing
// and tests/ops/restore-seams.test.ts pins it: src/db/client.ts builds its singleton lazily
// inside ensureInstance(), so the import above is inert, and Next awaits register() before
// the server accepts a request — so no route module can beat this to the database either.
const restoreOutcome = applyStagedRestoreOnBoot();

// MUST-20.23 (T1 review, CRITICAL): a 'restart' outcome means a commit was interrupted
// mid-step and has NOT exhausted its retry cap — commit.json still exists and the live
// budget.db may currently be missing or mid-transition. getDb() would CREATE a fresh, empty,
// migrated database at exactly the path the interrupted commit still needs to finish writing
// to, and the app would serve (and could accept writes into) that empty database until the
// next restart silently overwrote it. Exiting here instead — the same RESTART_EXIT_CODE and
// restart-policy path already used after a GUI-staged restore (MUST-20.28) — lets the next
// boot resume the same commit.json under the same attempt cap, and getDb() below is never
// reached while a commit might still be in flight.
if (restoreOutcome === 'restart') {
  console.error('[restore] a commit is mid-flight; exiting to retry on the next boot');
  process.exit(RESTART_EXIT_CODE);
}

// Opening the database here also applies the pragmas and runs migrations on boot — which is
// how a restored older backup migrates forward (MUST-20.24).
getDb();

// MUST-7.6: one line, either way. Missing assets DO NOT crash the app — receipts still
// upload and OCR jobs simply record 'failed' with "OCR engine unavailable on this
// install." A warranty tracker without OCR is still a warranty tracker; a container that
// refuses to boot is not.
const ocr = assertOcrAssets();
if (ocr.ok) {
  console.log(`[ocr] assets ok (${resolveOcrAssets().langPath})`);
} else {
  console.error(`[ocr] MISSING: ${ocr.missing.join(', ')}`);
}

// MUST-14.2: AFTER getDb() (the outcome has to be written into the restored database) and
// BEFORE the scheduler starts below (whose immediate boot tick then drains the row). The
// guard is mandatory: a notification failure must never stop the app from booting.
try {
  raiseRestoreOutcome();
} catch (error) {
  console.error('[notify] restore outcome raise failed', error);
}

startScheduler();

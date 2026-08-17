/**
 * Node-only half of the boot hook, split out of instrumentation.ts so that
 * Next's Edge-runtime compiler pass never has to resolve better-sqlite3/node-cron
 * (both are native/CJS-only and have no Edge-compatible build). instrumentation.ts
 * only ever `import()`s this file behind a NEXT_RUNTIME === 'nodejs' check, so the
 * Edge compilation of that file stays trivially side-effect free.
 */
import { getDb } from '@/db/client';
import { applyStagedRestoreOnBoot } from '@/lib/backup/restore';
import { startScheduler } from '@/lib/scheduler';
import { assertOcrAssets, resolveOcrAssets } from '@/lib/warranty/ocr/assets';

// MUST-20.26: FIRST, before anything can open the database. This ordering is load-bearing
// and tests/ops/restore-seams.test.ts pins it: src/db/client.ts builds its singleton lazily
// inside ensureInstance(), so the import above is inert, and Next awaits register() before
// the server accepts a request — so no route module can beat this to the database either.
applyStagedRestoreOnBoot();

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

startScheduler();

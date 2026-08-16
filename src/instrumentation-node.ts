/**
 * Node-only half of the boot hook, split out of instrumentation.ts so that
 * Next's Edge-runtime compiler pass never has to resolve better-sqlite3/node-cron
 * (both are native/CJS-only and have no Edge-compatible build). instrumentation.ts
 * only ever `import()`s this file behind a NEXT_RUNTIME === 'nodejs' check, so the
 * Edge compilation of that file stays trivially side-effect free.
 */
import { getDb } from '@/db/client';
import { startScheduler } from '@/lib/scheduler';
import { assertOcrAssets, resolveOcrAssets } from '@/lib/warranty/ocr/assets';

// Opening the database here also applies the pragmas and runs migrations on boot.
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

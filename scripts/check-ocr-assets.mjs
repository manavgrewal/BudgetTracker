#!/usr/bin/env node
/**
 * BUILD-TIME guard (MUST-7.9, acceptance check A3).
 *
 * Next's standalone output tracing cannot know that a .wasm blob, a worker script loaded by
 * string path, and a .traineddata.gz under vendor/ are runtime inputs — the same class of
 * miss that already forced explicit COPY lines for better-sqlite3's .node binary, drizzle/,
 * scripts/ and CHANGELOG.md. If one of those COPY lines is ever deleted, this must break
 * `docker build`, NOT production: the failure mode it prevents is tesseract.js silently
 * falling back to its CDN on an install that has no route to the internet.
 *
 * Deliberately self-contained (no "@/..." alias): it runs inside the runtime image, whose
 * working directory holds Next's standalone output and not the project's src/ tree. The
 * four paths below are duplicated from src/lib/warranty/ocr/assets.ts's resolveOcrAssets() on
 * purpose (Ruling P10a) — tests/scripts/check-ocr-assets.test.ts imports that function and
 * pins these literals against it, so drift between the two fails the test suite instead of
 * only failing a docker build weeks later.
 */
import fs from 'node:fs';
import path from 'node:path';

const REQUIRED = [
  'vendor/tessdata/eng.traineddata.gz',
  'node_modules/tesseract.js-core',
  'node_modules/tesseract.js/src/worker-script/node/index.js',
  'node_modules/pdfjs-dist',
];

const missing = [];
for (const relative of REQUIRED) {
  const absolute = path.join(process.cwd(), relative);
  if (fs.existsSync(absolute)) {
    console.log(`ok   ${relative}`);
  } else {
    missing.push(relative);
    console.error(`MISS ${relative}`);
  }
}

if (missing.length > 0) {
  console.error(
    `\n${missing.length} OCR asset(s) missing from ${process.cwd()}.\n` +
      'Check the COPY lines in the runner stage of the Dockerfile — see spec §7.4.',
  );
  process.exit(1);
}

console.log(`OCR assets ok (${REQUIRED.length} checked)`);

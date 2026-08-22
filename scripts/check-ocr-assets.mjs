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
 * paths below are duplicated from src/lib/warranty/ocr/assets.ts's resolveOcrAssets() and
 * src/lib/warranty/ocr/onnx/models.ts's resolveOnnxOcrAssets() on purpose (Ruling P10a) —
 * tests/scripts/check-ocr-assets.test.ts imports those functions and pins these literals
 * against them, so drift between the two fails the test suite instead of only failing a
 * docker build weeks later.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const REQUIRED = [
  'vendor/tessdata/eng.traineddata.gz',
  'node_modules/tesseract.js-core',
  'node_modules/tesseract.js/src/worker-script/node/index.js',
  'node_modules/pdfjs-dist',
  'vendor/ocr-models/ch_PP-OCRv5_det_mobile.onnx',
  'vendor/ocr-models/en_PP-OCRv5_rec_mobile.onnx',
  'vendor/ocr-models/ch_PP-LCNet_x0_25_textline_ori_cls_mobile.onnx',
  'vendor/ocr-models/en_dict.txt',
  'node_modules/onnxruntime-node/bin/napi-v6',
  'scripts/ocr-probe.mjs',
];

// Ruling P10a: duplicated from src/lib/warranty/ocr/onnx/models.ts on purpose, because this
// script runs inside the runtime image where '@/...' does not resolve and src/ is not
// present. tests/scripts/check-ocr-assets.test.ts pins these against the real constants, so
// a drift fails the test suite rather than only failing a docker build weeks later.
const MODEL_HASHES = {
  'vendor/ocr-models/ch_PP-OCRv5_det_mobile.onnx':
    '4d97c44a20d30a81aad087d6a396b08f786c4635742afc391f6621f5c6ae78ae',
  'vendor/ocr-models/en_PP-OCRv5_rec_mobile.onnx':
    'c3461add59bb4323ecba96a492ab75e06dda42467c9e3d0c18db5d1d21924be8',
  'vendor/ocr-models/ch_PP-LCNet_x0_25_textline_ori_cls_mobile.onnx':
    '54379ae5174d026780215fc748a7f31910dee36818e63d49e17dc598ecc82df7',
  // The same 64-hex literal as OCR_DICT_SHA256 in models.ts.
  'vendor/ocr-models/en_dict.txt': 'e025a66d31f327ba0c232e03f407ae8d105e1e709e7ccb3f408aa778c24e70d6',
};

// An un-stripped image is 204 MB heavier and nothing else tells anyone (MUST-10.1).
const MUST_NOT_EXIST = [
  'node_modules/onnxruntime-node/bin/napi-v6/darwin',
  'node_modules/onnxruntime-node/bin/napi-v6/win32',
];

const SCANNER_GLUE = 'public/scanner/opencv.js';
const SCANNER_JSCANIFY = 'public/scanner/jscanify.min.js';
const INLINED_GLUE_MIN_BYTES = 8_000_000;

// B8: the two vendored scanner assets got only a shape check (size/existence) while the four
// OCR models above got a SHA256 pin -- an inconsistent standard for ~9 MB of third-party code
// that executes in every household member's browser. These hashes were measured directly off
// node_modules/@techstark/opencv-js/dist/opencv.js and node_modules/jscanify/src/jscanify.js
// right after `npm ci`, i.e. exactly the bytes scripts/vendor-scanner-assets.mjs copies, with
// package.json pinning those packages to 4.7.0-release.1 and 1.4.3 respectively. A mismatch
// therefore means one of two things: a corrupted/tampered vendor copy, or a real version bump
// that nobody re-pinned yet -- see the error message below for which to assume.
const SCANNER_HASHES = {
  'public/scanner/opencv.js': '694a3dc0c753fd0b71f3cdcdaab38e6d5fa03517d3ea11ba3d9624bc48dc4090',
  'public/scanner/jscanify.min.js': 'a09dadd36ad4103e693523677f1aba3740d06f2dcdeb3ed87c66022e6ac0d13d',
};

// A local `npm ci` leaves the darwin and win32 directories in place, so the strip assertion
// is an image-build check only. The Dockerfile and the release workflow set this; a
// developer running `npm run check-ocr-assets` still gets the other three phases.
const IN_IMAGE = process.env.OCR_ASSETS_IN_IMAGE === '1';

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

// Phase 2: SHA256 verification of the four vendored model files. A corrupt or swapped model
// produces output that is indistinguishable from a correct read until someone checks the
// paper, so this is the second of three checkpoints on those bytes (the first is Task 1's
// fetch script, the third is verifyOnnxOcrAssets() at first use).
const hashMismatches = [];
for (const [relative, expected] of Object.entries(MODEL_HASHES)) {
  const absolute = path.join(process.cwd(), relative);
  const actual = createHash('sha256').update(fs.readFileSync(absolute)).digest('hex');
  if (actual === expected) {
    console.log(`ok   ${relative} sha256`);
  } else {
    hashMismatches.push(`${relative}: expected ${expected}, got ${actual}`);
    console.error(`MISS ${relative} sha256 mismatch: expected ${expected}, got ${actual}`);
  }
}

if (hashMismatches.length > 0) {
  console.error(
    `\n${hashMismatches.length} OCR model(s) failed SHA256 verification in ${process.cwd()}.\n` +
      hashMismatches.join('\n') +
      '\nRe-run npm run fetch-ocr-models and check the COPY lines in the Dockerfile — see spec §7.4.',
  );
  process.exit(1);
}

// Phase 3: the strip assertion (MUST-10.1, MUST-10.9), image-build only.
if (IN_IMAGE) {
  const stillPresent = [];
  for (const relative of MUST_NOT_EXIST) {
    const absolute = path.join(process.cwd(), relative);
    if (fs.existsSync(absolute)) {
      stillPresent.push(relative);
      console.error(`MISS ${relative} (must NOT exist)`);
    } else {
      console.log(`ok   ${relative} absent`);
    }
  }
  if (stillPresent.length > 0) {
    console.error(
      `\nthe deps stage's rm -rf did not run (MUST-10.1); this image is about 204 MB heavier ` +
        `than it should be.\nStill present: ${stillPresent.join(', ')}`,
    );
    process.exit(1);
  }
}

// Phase 4: the generated scanner assets, in one of the two shapes upstream can ship
// (Task 10 / scripts/vendor-scanner-assets.mjs).
const scannerMissing = [];
for (const relative of [SCANNER_GLUE, SCANNER_JSCANIFY]) {
  const absolute = path.join(process.cwd(), relative);
  if (fs.existsSync(absolute)) {
    console.log(`ok   ${relative}`);
  } else {
    scannerMissing.push(relative);
    console.error(`MISS ${relative}`);
  }
}

if (scannerMissing.length > 0) {
  console.error(
    `\n${scannerMissing.length} scanner asset(s) missing from ${process.cwd()}.\n` +
      'Check that the Dockerfile builder stage runs scripts/vendor-scanner-assets.mjs before npm run build.',
  );
  process.exit(1);
}

const scannerDir = path.join(process.cwd(), 'public', 'scanner');
const scannerEntries = fs.readdirSync(scannerDir);
const wasmFiles = scannerEntries.filter((entry) => entry.endsWith('.wasm'));
const glueBytes = fs.statSync(path.join(scannerDir, 'opencv.js')).size;

if (wasmFiles.length === 1) {
  console.log(`ok   public/scanner/${wasmFiles[0]}`);
} else if (wasmFiles.length === 0 && glueBytes >= INLINED_GLUE_MIN_BYTES) {
  console.log(`ok   public/scanner/opencv.js is ${glueBytes} bytes (wasm inlined)`);
} else {
  console.error(
    `\npublic/scanner/ is not in either accepted shape: found ${wasmFiles.length} .wasm file(s) ` +
      `and an opencv.js of ${glueBytes} bytes (need >= ${INLINED_GLUE_MIN_BYTES} if no .wasm sits ` +
      'alongside it).\nCheck scripts/vendor-scanner-assets.mjs and the Dockerfile builder stage.',
  );
  process.exit(1);
}

// Phase 5 (B8): SHA256 verification of the two vendored scanner assets, the same treatment
// the four OCR models get above (see SCANNER_HASHES for what these are pinned against).
const scannerHashMismatches = [];
for (const [relative, expected] of Object.entries(SCANNER_HASHES)) {
  const absolute = path.join(process.cwd(), relative);
  const actual = createHash('sha256').update(fs.readFileSync(absolute)).digest('hex');
  if (actual === expected) {
    console.log(`ok   ${relative} sha256`);
  } else {
    scannerHashMismatches.push(`${relative}: expected ${expected}, got ${actual}`);
    console.error(`MISS ${relative} sha256 mismatch: expected ${expected}, got ${actual}`);
  }
}

if (scannerHashMismatches.length > 0) {
  console.error(
    `\n${scannerHashMismatches.length} scanner asset(s) failed SHA256 verification in ${process.cwd()}.\n` +
      scannerHashMismatches.join('\n') +
      '\nSCANNER_HASHES is pinned to opencv-js 4.7.0-release.1 and jscanify 1.4.3 exactly (see package.json).' +
      ' If those dependency versions have NOT changed, treat this as a corrupted or tampered vendor copy:' +
      ' re-run npm run vendor-scanner-assets and re-check.\nIf you intentionally bumped either package, this' +
      ' failure is expected -- re-run npm run vendor-scanner-assets to regenerate public/scanner/, then' +
      " update SCANNER_HASHES in scripts/check-ocr-assets.mjs with the new build's sha256 before shipping.",
  );
  process.exit(1);
}

console.log(`OCR assets ok (${REQUIRED.length} checked)`);

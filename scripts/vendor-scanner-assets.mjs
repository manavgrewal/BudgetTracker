/**
 * Copies the browser scanner's runtime files out of node_modules into public/scanner/.
 * Performs NO network access: it only copies files npm already installed. Run by
 * `npm run vendor-scanner-assets`, by the Dockerfile's builder stage before `npm run build`,
 * and by the release workflow's guard job.
 *
 * public/scanner/ is generated and gitignored, unlike the models under vendor/, which are
 * committed. The models come from ModelScope, which the build must not depend on; these
 * come from npm, which it already does.
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const OPENCV_DIST = path.join(ROOT, 'node_modules', '@techstark', 'opencv-js', 'dist');
// jscanify 1.4.3 ships no dist/ build at all: package.json's "." export resolves to
// src/jscanify-node.js (a canvas/jsdom build meant for Node), and the browser-facing UMD
// bundle lives at the "./client" export, src/jscanify.js -- unminified, but still the
// correct file: it assumes a global `cv` and attaches `global.jscanify`, exactly what
// src/lib/scanner/load.ts expects after injecting it as a <script> tag.
const JSCANIFY = path.join(ROOT, 'node_modules', 'jscanify', 'src', 'jscanify.js');
const OUT = path.join(ROOT, 'public', 'scanner');
const INLINED_GLUE_MIN_BYTES = 8_000_000;

function fail(message, listing) {
  console.error(message);
  if (listing) {
    console.error(`\nWhat is actually in ${OPENCV_DIST}:`);
    for (const entry of listing) console.error(`  ${entry}`);
  }
  console.error(
    '\nTwo shapes are accepted:\n' +
      '  1. dist/opencv.js plus exactly one sibling .wasm file\n' +
      `  2. dist/opencv.js alone, at least ${INLINED_GLUE_MIN_BYTES} bytes, meaning the wasm is base64-inlined\n` +
      'Anything else is an upstream layout change and needs a look before it ships.',
  );
  process.exit(1);
}

if (!fs.existsSync(OPENCV_DIST)) fail(`${OPENCV_DIST} does not exist. Run npm ci first.`);
const listing = fs.readdirSync(OPENCV_DIST);
const glue = path.join(OPENCV_DIST, 'opencv.js');
if (!listing.includes('opencv.js')) fail('opencv.js is missing from the opencv-js dist directory.', listing);

const wasmFiles = listing.filter((entry) => entry.endsWith('.wasm'));
const glueBytes = fs.statSync(glue).size;
if (wasmFiles.length > 1) fail(`Found ${wasmFiles.length} .wasm files; exactly one is expected.`, listing);
if (wasmFiles.length === 0 && glueBytes < INLINED_GLUE_MIN_BYTES) {
  fail(`No .wasm file, and opencv.js is only ${glueBytes} bytes, which is too small to be an inlined build.`, listing);
}

fs.mkdirSync(OUT, { recursive: true });
const copied = [];
function copy(from, to) {
  fs.copyFileSync(from, to);
  copied.push(`${to} (${fs.statSync(to).size} bytes)`);
}

copy(glue, path.join(OUT, 'opencv.js'));
// Keep the upstream filename: the glue resolves its wasm by that name through locateFile.
for (const entry of wasmFiles) copy(path.join(OPENCV_DIST, entry), path.join(OUT, entry));
if (!fs.existsSync(JSCANIFY)) fail(`${JSCANIFY} does not exist. Run npm ci first.`);
// Destination name stays jscanify.min.js regardless of the upstream source name: load.ts
// and the ops tests inject/assert a fixed same-origin path, not whatever jscanify happens
// to call its own file this version.
copy(JSCANIFY, path.join(OUT, 'jscanify.min.js'));

for (const line of copied) console.log(`wrote ${line}`);
console.log(`scanner assets ok (${copied.length} files)`);

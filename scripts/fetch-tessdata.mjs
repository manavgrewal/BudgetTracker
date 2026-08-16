#!/usr/bin/env node
/**
 * ONE-TIME regeneration helper for vendor/tessdata/eng.traineddata.gz (MUST-7.7).
 *
 * Run by a maintainer with internet access. It is NEVER invoked by a build, by a test,
 * or by the app: the .gz is committed to the repository precisely so that an offline LAN
 * install has no dependency on npm resolution or on a third-party data package staying
 * published (§17.21).
 *
 *   node scripts/fetch-tessdata.mjs
 *
 * It prints the sha256 of the file it wrote. Paste that value into TESSDATA_SHA256 in
 * src/lib/warranty/ocr/assets.ts so a corrupt or swapped file is caught by CI rather than
 * at a family member's first upload.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';

const URL_ENG = 'https://github.com/tesseract-ocr/tessdata_fast/raw/main/eng.traineddata';
const OUT_DIR = path.join(process.cwd(), 'vendor', 'tessdata');
const OUT_FILE = path.join(OUT_DIR, 'eng.traineddata.gz');

const response = await fetch(URL_ENG);
if (!response.ok) {
  console.error(`Download failed: ${response.status} ${response.statusText}`);
  process.exit(1);
}
const raw = Buffer.from(await response.arrayBuffer());
if (raw.length < 1_000_000) {
  console.error(`Refusing a suspiciously small download (${raw.length} bytes)`);
  process.exit(1);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
const gz = zlib.gzipSync(raw, { level: 9 });
fs.writeFileSync(OUT_FILE, gz);

const digest = createHash('sha256').update(gz).digest('hex');
console.log(`wrote ${OUT_FILE} (${gz.length} bytes)`);
console.log(`eng.traineddata.gz sha256 = ${digest}`);
console.log('Paste that value into TESSDATA_SHA256 in src/lib/warranty/ocr/assets.ts');

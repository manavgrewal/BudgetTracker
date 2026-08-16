import fs from 'node:fs';
import path from 'node:path';
import { readEnv } from '@/lib/env';

/**
 * MUST-7.4: the SINGLE place the OCR asset paths are computed. Everything resolves against
 * the app root (process.cwd() — /app in the container, the repo root in dev and test) and
 * every value returned is an ABSOLUTE FILESYSTEM PATH.
 *
 * MUST-7.3: tesseract.js downloads its worker script, its .wasm core and eng.traineddata
 * from a CDN by default. That is forbidden here — the install is LAN-only and frequently
 * has no route to the internet. Omitting even one of the four options below is how the CDN
 * default silently comes back, which is why a test asserts all four are passed.
 */
export interface OcrAssets {
  workerPath: string;
  corePath: string;
  langPath: string;
  cachePath: string;
}

export const TESSDATA_RELATIVE_PATH = 'vendor/tessdata/eng.traineddata.gz';

/** Regenerate with `node scripts/fetch-tessdata.mjs`, which prints this value. */
export const TESSDATA_SHA256 = 'b130d16b69e3888bc099133991a50a5b50e1da0e3ff6ca31a5496fab0fb386c3';

export function resolveOcrAssets(): OcrAssets {
  const root = process.cwd();
  return {
    workerPath: path.join(root, 'node_modules', 'tesseract.js', 'src', 'worker-script', 'node', 'index.js'),
    // A DIRECTORY: the library selects the SIMD / non-SIMD build inside it.
    corePath: path.join(root, 'node_modules', 'tesseract.js-core'),
    langPath: path.join(root, 'vendor', 'tessdata'),
    // Belt and braces for any write path that ignores cacheMethod: 'none' — the container
    // rootfs is read-only, ${DATA_DIR}/tmp is not (MUST-13.8).
    cachePath: path.join(readEnv().dataDir, 'tmp'),
  };
}

/**
 * MUST-7.6: fail loudly, degrade gracefully. Called at boot; missing assets log one line
 * and DO NOT crash the app — receipts still upload, and OCR jobs simply record 'failed'.
 * A warranty tracker without OCR is still a warranty tracker; a container that refuses to
 * boot is not.
 */
export function assertOcrAssets(): { ok: boolean; missing: string[] } {
  const assets = resolveOcrAssets();
  const required: [string, string][] = [
    ['workerPath', assets.workerPath],
    ['corePath', assets.corePath],
    ['langPath', path.join(assets.langPath, 'eng.traineddata.gz')],
  ];
  const missing = required.filter(([, value]) => !fs.existsSync(value)).map(([name, value]) => `${name}=${value}`);
  return { ok: missing.length === 0, missing };
}

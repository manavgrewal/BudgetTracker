import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { OCR_UNAVAILABLE_MESSAGE, OcrUnavailableError } from '@/lib/warranty/ocr/engine';

/**
 * PP-OCRv5 ONNX models converted by RapidOCR (https://github.com/RapidAI/RapidOCR) at tag
 * v3.9.2 and distributed under the Apache License 2.0. The underlying weights are
 * copyright Baidu, released under the same licence by PaddlePaddle/PaddleOCR. Full
 * provenance and licence text: vendor/ocr-models/NOTICE.
 *
 * This is the SINGLE place the four vendored paths are computed. Same rule, same reason,
 * as resolveOcrAssets() in ../assets.ts.
 */

export const OCR_MODELS_DIR_RELATIVE = 'vendor/ocr-models';
export const DET_MODEL_FILENAME = 'ch_PP-OCRv5_det_mobile.onnx';
export const REC_MODEL_FILENAME = 'en_PP-OCRv5_rec_mobile.onnx';
export const CLS_MODEL_FILENAME = 'ch_PP-LCNet_x0_25_textline_ori_cls_mobile.onnx';
export const DICT_FILENAME = 'en_dict.txt';

/** Published by RapidOCR in python/rapidocr/default_models.yaml at tag v3.9.2. */
export const DET_MODEL_SHA256 = '4d97c44a20d30a81aad087d6a396b08f786c4635742afc391f6621f5c6ae78ae';
export const REC_MODEL_SHA256 = 'c3461add59bb4323ecba96a492ab75e06dda42467c9e3d0c18db5d1d21924be8';
export const CLS_MODEL_SHA256 = '54379ae5174d026780215fc748a7f31910dee36818e63d49e17dc598ecc82df7';
/** Regenerate with `npm run fetch-ocr-models`, which prints this value. Upstream publishes none. */
export const OCR_DICT_SHA256 = 'e025a66d31f327ba0c232e03f407ae8d105e1e709e7ccb3f408aa778c24e70d6';

export interface OnnxOcrAssets {
  detPath: string;
  recPath: string;
  clsPath: string;
  dictPath: string;
}

export function resolveOnnxOcrAssets(): OnnxOcrAssets {
  const dir = path.join(process.cwd(), 'vendor', 'ocr-models');
  return {
    detPath: path.join(dir, DET_MODEL_FILENAME),
    recPath: path.join(dir, REC_MODEL_FILENAME),
    clsPath: path.join(dir, CLS_MODEL_FILENAME),
    dictPath: path.join(dir, DICT_FILENAME),
  };
}

/** Existence only. Cheap enough to call at boot. */
export function assertOnnxOcrAssets(): { ok: boolean; missing: string[] } {
  const assets = resolveOnnxOcrAssets();
  const missing = Object.entries(assets)
    .filter(([, value]) => !fs.existsSync(value))
    .map(([name, value]) => `${name}=${value}`);
  return { ok: missing.length === 0, missing };
}

const EXPECTED: [keyof OnnxOcrAssets, string][] = [
  ['detPath', DET_MODEL_SHA256],
  ['recPath', REC_MODEL_SHA256],
  ['clsPath', CLS_MODEL_SHA256],
  ['dictPath', OCR_DICT_SHA256],
];

let verification: { ok: boolean; problems: string[] } | null = null;

/**
 * Existence plus SHA256 of all four. Called ONCE, lazily, before the first InferenceSession
 * is created, and never on the request path afterwards. Hashing 12.7 MB costs roughly 60 ms
 * once. A corrupt or swapped model must never be silently tolerated: its output is
 * indistinguishable from a correct read until someone checks the paper.
 */
export function verifyOnnxOcrAssets(): { ok: boolean; problems: string[] } {
  if (verification !== null) return verification;
  const assets = resolveOnnxOcrAssets();
  const problems: string[] = [];
  for (const [key, expected] of EXPECTED) {
    const file = assets[key];
    if (!fs.existsSync(file)) {
      problems.push(`${file} is missing`);
      continue;
    }
    const actual = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    if (actual !== expected) problems.push(`${file} sha256 ${actual} does not match the pinned ${expected}`);
  }
  verification = { ok: problems.length === 0, problems };
  return verification;
}

export function resetOnnxAssetVerificationForTests(): void {
  verification = null;
}

/**
 * MUST-3.12 / MUST-3.13: a failure puts this process on the tesseract path for its whole
 * life and logs which file failed. It does NOT crash the app, and it does NOT rewrite the
 * cached ocr.engine setting, because a bad file is not a hardware verdict.
 */
export function requireVerifiedOnnxOcrAssets(): void {
  const result = verifyOnnxOcrAssets();
  if (result.ok) return;
  for (const problem of result.problems) console.error(`[ocr] vendored asset check failed: ${problem}`);
  throw new OcrUnavailableError(OCR_UNAVAILABLE_MESSAGE);
}

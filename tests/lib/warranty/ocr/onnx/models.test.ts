import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  CLS_MODEL_FILENAME,
  CLS_MODEL_SHA256,
  DET_MODEL_FILENAME,
  DET_MODEL_SHA256,
  DICT_FILENAME,
  OCR_DICT_SHA256,
  REC_MODEL_FILENAME,
  REC_MODEL_SHA256,
  assertOnnxOcrAssets,
  resetOnnxAssetVerificationForTests,
  resolveOnnxOcrAssets,
  verifyOnnxOcrAssets,
} from '@/lib/warranty/ocr/onnx/models';

afterEach(() => resetOnnxAssetVerificationForTests());

describe('resolveOnnxOcrAssets (MUST-3.10)', () => {
  it('returns four absolute paths under process.cwd()/vendor/ocr-models', () => {
    const assets = resolveOnnxOcrAssets();
    for (const value of Object.values(assets)) {
      expect(path.isAbsolute(value)).toBe(true);
      expect(value.startsWith(path.join(process.cwd(), 'vendor', 'ocr-models'))).toBe(true);
    }
    expect(path.basename(assets.detPath)).toBe(DET_MODEL_FILENAME);
    expect(path.basename(assets.recPath)).toBe(REC_MODEL_FILENAME);
    expect(path.basename(assets.clsPath)).toBe(CLS_MODEL_FILENAME);
    expect(path.basename(assets.dictPath)).toBe(DICT_FILENAME);
  });
});

describe('the four pinned hashes match the committed bytes (MUST-3.1, MUST-3.11)', () => {
  it('finds every file present', () => {
    expect(assertOnnxOcrAssets()).toEqual({ ok: true, missing: [] });
  });

  it.each([
    ['detPath', DET_MODEL_SHA256],
    ['recPath', REC_MODEL_SHA256],
    ['clsPath', CLS_MODEL_SHA256],
    ['dictPath', OCR_DICT_SHA256],
  ] as const)('%s hashes to its pinned constant', (key, expected) => {
    const bytes = fs.readFileSync(resolveOnnxOcrAssets()[key]);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(expected);
  });

  it('every pin is 64 lowercase hex characters', () => {
    for (const pin of [DET_MODEL_SHA256, REC_MODEL_SHA256, CLS_MODEL_SHA256, OCR_DICT_SHA256]) {
      expect(pin).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});

describe('verifyOnnxOcrAssets (MUST-3.12, MUST-3.13)', () => {
  it('passes against the committed files', () => {
    expect(verifyOnnxOcrAssets()).toEqual({ ok: true, problems: [] });
  });

  it('is memoised: the second call does not re-read the files', () => {
    const spy = fs.readFileSync;
    let reads = 0;
    // Count reads through a local wrapper rather than a global mock, so a failure here
    // cannot leave fs patched for the rest of the suite.
    const counting = ((...args: Parameters<typeof fs.readFileSync>) => {
      reads += 1;
      return spy(...args);
    }) as typeof fs.readFileSync;
    const original = fs.readFileSync;
    (fs as { readFileSync: typeof fs.readFileSync }).readFileSync = counting;
    try {
      verifyOnnxOcrAssets();
      const afterFirst = reads;
      verifyOnnxOcrAssets();
      expect(reads).toBe(afterFirst);
      expect(afterFirst).toBe(4);
    } finally {
      (fs as { readFileSync: typeof fs.readFileSync }).readFileSync = original;
    }
  });

  it('names the specific file when one byte is flipped', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-ocr-models-'));
    const original = process.cwd();
    try {
      fs.mkdirSync(path.join(dir, 'vendor', 'ocr-models'), { recursive: true });
      const real = resolveOnnxOcrAssets();
      for (const [name, source] of [
        [DET_MODEL_FILENAME, real.detPath],
        [REC_MODEL_FILENAME, real.recPath],
        [CLS_MODEL_FILENAME, real.clsPath],
        [DICT_FILENAME, real.dictPath],
      ] as const) {
        fs.copyFileSync(source, path.join(dir, 'vendor', 'ocr-models', name));
      }
      const victim = path.join(dir, 'vendor', 'ocr-models', DICT_FILENAME);
      const bytes = fs.readFileSync(victim);
      bytes[0] ^= 0xff;
      fs.writeFileSync(victim, bytes);

      process.chdir(dir);
      resetOnnxAssetVerificationForTests();
      const result = verifyOnnxOcrAssets();
      expect(result.ok).toBe(false);
      expect(result.problems).toHaveLength(1);
      expect(result.problems[0]).toContain(DICT_FILENAME);
      expect(result.problems[0]).toContain(OCR_DICT_SHA256);
    } finally {
      process.chdir(original);
      resetOnnxAssetVerificationForTests();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { resolveOcrAssets, TESSDATA_RELATIVE_PATH } from '@/lib/warranty/ocr/assets';
import {
  DET_MODEL_SHA256,
  REC_MODEL_SHA256,
  CLS_MODEL_SHA256,
  OCR_DICT_SHA256,
  resolveOnnxOcrAssets,
} from '@/lib/warranty/ocr/onnx/models';

const root = process.cwd();
const script = path.join(root, 'scripts/check-ocr-assets.mjs');

function run(cwd: string) {
  return spawnSync(process.execPath, [script], { cwd, encoding: 'utf8' });
}

describe('scripts/check-ocr-assets.mjs (MUST-7.9)', () => {
  it('exits 0 in a healthy checkout, covering all ten paths', () => {
    const result = run(root);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('en_dict.txt');
    expect(result.stdout).toContain('opencv.js');
  });

  it('exits non-zero and names the missing path when an asset is absent', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-ocr-guard-'));
    try {
      const result = run(empty);
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain('vendor/tessdata/eng.traineddata.gz');
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  it('checks exactly the ten paths the runtime needs, and no URL', () => {
    const source = fs.readFileSync(script, 'utf8');
    for (const needle of [
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
    ]) {
      expect(source).toContain(needle);
    }
    expect(source).not.toMatch(/https?:\/\//);
  });

  // Ruling P10a: the guard script duplicates path literals from resolveOcrAssets() on
  // purpose (it must run standalone in the runtime image, where '@/...' does not resolve).
  // Duplication without a pin is how the two quietly drift apart — e.g. someone moves
  // worker-script/node/index.js in a tesseract.js upgrade, updates assets.ts, and never
  // notices the guard script still points at the old path. This test derives the expected
  // literals from the SAME function the runtime uses (resolveOcrAssets()) rather than
  // retyping them, so a real drift fails here instead of only failing `docker build` weeks
  // later.
  it('matches every path resolveOcrAssets() resolves, so the two cannot silently drift (Ruling P10a)', () => {
    const source = fs.readFileSync(script, 'utf8');
    const assets = resolveOcrAssets();

    const workerRelative = path.relative(root, assets.workerPath).split(path.sep).join('/');
    const coreRelative = path.relative(root, assets.corePath).split(path.sep).join('/');

    expect(source).toContain(workerRelative);
    expect(source).toContain(coreRelative);
    expect(source).toContain(TESSDATA_RELATIVE_PATH);
  });

  it('MUST-10.8: its duplicated model hashes equal the ones models.ts pins (Ruling P10a)', () => {
    const source = fs.readFileSync(script, 'utf8');
    for (const hash of [DET_MODEL_SHA256, REC_MODEL_SHA256, CLS_MODEL_SHA256, OCR_DICT_SHA256]) {
      expect(source).toContain(hash);
    }
    const assets = resolveOnnxOcrAssets();
    for (const value of Object.values(assets)) {
      expect(source).toContain(path.relative(root, value).split(path.sep).join('/'));
    }
  });

  it('MUST-10.9: it asserts the darwin and win32 platform directories are gone', () => {
    const source = fs.readFileSync(script, 'utf8');
    expect(source).toContain('node_modules/onnxruntime-node/bin/napi-v6/darwin');
    expect(source).toContain('node_modules/onnxruntime-node/bin/napi-v6/win32');
    expect(source).toContain('MUST-10.1');
  });

  it('MUST-10.10: it checks the scanner assets and the two accepted wasm shapes', () => {
    const source = fs.readFileSync(script, 'utf8');
    expect(source).toContain('public/scanner/opencv.js');
    expect(source).toContain('public/scanner/jscanify.min.js');
    expect(source).toContain('INLINED_GLUE_MIN_BYTES');
  });

  // B8: the two vendored scanner assets used to get only a shape check (size/existence)
  // while the four OCR models got a SHA256 pin -- inconsistent for ~9 MB of third-party code
  // that runs in every household member's browser. These two tests are the scanner-asset
  // equivalent of the MUST-10.8 model-hash test above and the missing-path test further up.
  it('B8: pins a SHA256 hash for both vendored scanner assets, the same treatment as the OCR models', () => {
    const source = fs.readFileSync(script, 'utf8');
    expect(source).toContain('SCANNER_HASHES');
    expect(source).toMatch(/'public\/scanner\/opencv\.js':\s*'[0-9a-f]{64}'/);
    expect(source).toMatch(/'public\/scanner\/jscanify\.min\.js':\s*'[0-9a-f]{64}'/);
  });

  it('B8: fails with an actionable re-vendor/re-pin message on a scanner hash mismatch, without touching the real vendored files', () => {
    const source = fs.readFileSync(script, 'utf8');
    const match = source.match(/'public\/scanner\/opencv\.js':\s*'([0-9a-f]{64})'/);
    expect(match, 'expected SCANNER_HASHES to pin public/scanner/opencv.js').not.toBeNull();
    const realHash = (match as RegExpMatchArray)[1];
    // Flip the last hex digit so the pin is wrong but well-formed -- a copy of the script,
    // never the real file on disk, so the healthy checkout this suite depends on stays intact.
    const bogusHash = realHash.slice(0, -1) + (realHash.endsWith('0') ? '1' : '0');
    const tamperedScript = source.replace(`'${realHash}'`, `'${bogusHash}'`);

    const tmpScript = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-guard-tamper-')), 'check-ocr-assets.mjs');
    fs.writeFileSync(tmpScript, tamperedScript);
    try {
      const result = spawnSync(process.execPath, [tmpScript], { cwd: root, encoding: 'utf8' });
      expect(result.status).not.toBe(0);
      const output = `${result.stdout}${result.stderr}`;
      expect(output).toContain('sha256 mismatch');
      expect(output).toContain('opencv-js 4.7.0-release.1');
      expect(output).toContain('jscanify 1.4.3');
      expect(output).toMatch(/corrupted or tampered/);
      expect(output).toContain('npm run vendor-scanner-assets');
      expect(output).toContain('SCANNER_HASHES');
    } finally {
      fs.rmSync(path.dirname(tmpScript), { recursive: true, force: true });
    }
  });

  it("its inlined-glue threshold equals the vendoring script's, so the two cannot disagree", () => {
    // Both scripts implement the same two accepted dist shapes, because neither can import
    // from the other: one runs in the repo before the build, the other inside the runtime
    // image. Asserting that each contains the identifier proves nothing about the value, so
    // parse the number out of both and compare it. A build that accepts a 6 MB inlined glue
    // in one place and rejects it in the other is a build that fails at the worst moment.
    const threshold = (source: string) => {
      const match = source.match(/INLINED_GLUE_MIN_BYTES\s*=\s*([\d_]+)/);
      expect(match, 'INLINED_GLUE_MIN_BYTES is not a plain numeric literal').not.toBeNull();
      return Number((match as RegExpMatchArray)[1].replace(/_/g, ''));
    };
    const guard = threshold(fs.readFileSync(script, 'utf8'));
    const vendoring = threshold(
      fs.readFileSync(path.join(root, 'scripts/vendor-scanner-assets.mjs'), 'utf8'),
    );
    expect(guard).toBe(vendoring);
    expect(guard).toBe(8_000_000);
  });
});

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { resolveOcrAssets, TESSDATA_RELATIVE_PATH } from '@/lib/warranty/ocr/assets';

const root = process.cwd();
const script = path.join(root, 'scripts/check-ocr-assets.mjs');

function run(cwd: string) {
  return spawnSync(process.execPath, [script], { cwd, encoding: 'utf8' });
}

describe('scripts/check-ocr-assets.mjs (MUST-7.9)', () => {
  it('exits 0 in a healthy checkout and names what it checked', () => {
    const result = run(root);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('eng.traineddata.gz');
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

  it('checks exactly the four paths the runtime needs, and no URL', () => {
    const source = fs.readFileSync(script, 'utf8');
    for (const needle of [
      'vendor/tessdata/eng.traineddata.gz',
      'node_modules/tesseract.js-core',
      'node_modules/tesseract.js/src/worker-script/node/index.js',
      'node_modules/pdfjs-dist',
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
});

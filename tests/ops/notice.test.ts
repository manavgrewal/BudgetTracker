import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  CLS_MODEL_SHA256,
  DET_MODEL_SHA256,
  REC_MODEL_SHA256,
} from '@/lib/warranty/ocr/onnx/models';

const read = (relative: string) => fs.readFileSync(path.join(process.cwd(), relative), 'utf8');

describe('vendor/ocr-models/NOTICE (MUST-3.9, MUST-3.14)', () => {
  const notice = read('vendor/ocr-models/NOTICE');

  it('names all three published model hashes', () => {
    for (const hash of [DET_MODEL_SHA256, REC_MODEL_SHA256, CLS_MODEL_SHA256]) {
      expect(notice).toContain(hash);
    }
  });

  it('names the pinned tag and both upstream projects', () => {
    expect(notice).toContain('v3.9.2');
    expect(notice).toContain('RapidOCR');
    expect(notice).toContain('PaddleOCR');
    expect(notice).toContain('Baidu');
  });

  it('carries the full Apache-2.0 licence text', () => {
    expect(notice).toContain('Apache License');
    expect(notice).toContain('Version 2.0, January 2004');
    expect(notice).toContain('TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION');
  });
});

describe('models.ts records the licence provenance (MUST-3.14)', () => {
  it('names the licence, the upstream project and the tag in its header comment', () => {
    const source = read('src/lib/warranty/ocr/onnx/models.ts');
    const header = source.slice(0, source.indexOf('export const OCR_MODELS_DIR_RELATIVE'));
    expect(header).toContain('Apache License 2.0');
    expect(header).toContain('RapidOCR');
    expect(header).toContain('v3.9.2');
  });
});

describe('the fetch script is maintainer-run only (MUST-3.5, MUST-11.2)', () => {
  it('says so in its header', () => {
    const source = read('scripts/fetch-ocr-models.mjs');
    expect(source).toContain('ONE-TIME');
    expect(source).toMatch(/never .*docker build/);
    expect(source).toMatch(/never .*test/);
    expect(source).toMatch(/never .*lifecycle hook/);
  });

  it('is not wired to any npm lifecycle hook', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    expect(pkg.scripts['fetch-ocr-models']).toBe('node scripts/fetch-ocr-models.mjs');
    for (const hook of ['postinstall', 'prepare', 'prebuild', 'pretest', 'build', 'test']) {
      expect(pkg.scripts[hook] ?? '').not.toContain('fetch-ocr-models');
    }
  });

  it('pins the tag in the URL and never a moving reference', () => {
    const source = read('scripts/fetch-ocr-models.mjs');
    expect(source).toContain("RAPIDOCR_TAG = 'v3.9.2'");
    expect(source).not.toMatch(/resolve\/(main|master)\//);
  });
});

describe('the four dependencies are pinned as MUST-2.4 requires', () => {
  it('pins three exactly and carries the reason in package.json', () => {
    const pkg = JSON.parse(read('package.json')) as {
      dependencies: Record<string, string>;
      ['//ocr-pins']?: string;
    };
    expect(pkg.dependencies['onnxruntime-node']).toBe('1.27.0');
    expect(pkg.dependencies['jscanify']).toBe('1.4.3');
    expect(pkg.dependencies['@techstark/opencv-js']).toBe('4.7.0-release.1');
    expect(pkg.dependencies['sharp']).toBe('^0.35.3');
    expect(pkg['//ocr-pins'] ?? '').toContain('MLAS');
  });

  it('keeps tesseract.js and its core as the fallback (MUST-5.14)', () => {
    const pkg = JSON.parse(read('package.json')) as { dependencies: Record<string, string> };
    expect(pkg.dependencies['tesseract.js']).toBeTruthy();
    expect(fs.existsSync(path.join(process.cwd(), 'vendor/tessdata/eng.traineddata.gz'))).toBe(true);
  });
});

describe('next.config.ts externalises both native packages (MUST-10.12)', () => {
  it('lists onnxruntime-node and sharp', () => {
    const source = read('next.config.ts');
    expect(source).toContain("'onnxruntime-node'");
    expect(source).toContain("'sharp'");
  });
});

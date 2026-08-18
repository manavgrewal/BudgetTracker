import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import * as C from '@/lib/warranty/ocr/onnx/constants';
import { MAX_RECEIPT_BYTES } from '@/lib/warranty/receipts';

const ONNX_DIR = path.join(process.cwd(), 'src/lib/warranty/ocr/onnx');

/**
 * Section 4.11's table, with four values corrected against RapidOCR v3.9.2 (Task 2
 * correction; see constants.ts and the spec's revision history): DET_LIMIT_SIDE_LEN,
 * DET_LIMIT_TYPE, DET_MEAN and DET_STD. The plan's four additions are deliberately absent.
 */
const TABLE: Record<string, number | string | boolean | readonly number[]> = {
  PREPROCESS_MAX_INPUT_PIXELS: 50_000_000,
  PREPROCESS_MIN_LONG_SIDE_PX: 1280,
  PREPROCESS_MAX_UPSCALE: 3.0,
  PREPROCESS_MAX_LONG_SIDE_PX: 4000,
  NORMALISE_LOWER_PERCENTILE: 1,
  NORMALISE_UPPER_PERCENTILE: 99,
  DESKEW_SEARCH_MAX_DEG: 10,
  DESKEW_SEARCH_STEP_DEG: 0.5,
  DESKEW_MIN_APPLY_DEG: 0.3,
  DESKEW_PROFILE_LONG_SIDE_PX: 800,
  DESKEW_BACKGROUND: '#ffffff',
  DET_LIMIT_SIDE_LEN: 736,
  DET_LIMIT_TYPE: 'min',
  DET_SIZE_MULTIPLE: 32,
  DET_MEAN: [0.5, 0.5, 0.5],
  DET_STD: [0.5, 0.5, 0.5],
  DET_SCALE: 1 / 255,
  DET_BINARY_THRESH: 0.3,
  DET_BOX_THRESH: 0.5,
  DET_UNCLIP_RATIO: 1.6,
  DET_MAX_CANDIDATES: 1000,
  DET_MIN_BOX_SIDE_PX: 3,
  DET_USE_DILATION: true,
  DET_DILATION_KERNEL: 2,
  DET_SCORE_MODE: 'fast',
  DET_MAX_BOXES: 200,
  CROP_MIN_ROTATE_DEG: 0.5,
  CLS_INPUT_HEIGHT: 80,
  CLS_INPUT_WIDTH: 160,
  CLS_MEAN: 0.5,
  CLS_STD: 0.5,
  CLS_PAD_VALUE: 0,
  CLS_THRESH: 0.9,
  CLS_BATCH_SIZE: 6,
  REC_INPUT_HEIGHT: 48,
  REC_BASE_WIDTH: 320,
  REC_MAX_WIDTH: 1200,
  REC_MEAN: 0.5,
  REC_STD: 0.5,
  REC_PAD_VALUE: 0,
  REC_BATCH_SIZE: 6,
  REC_BLANK_INDEX: 0,
  REC_USE_SPACE_CHAR: true,
  REC_DROP_SCORE: 0.5,
  LINE_OVERLAP_RATIO: 0.5,
  LINE_JOIN: ' ',
  BLOCK_JOIN: '\n',
  ORT_INTRA_OP_THREADS: 2,
  ORT_INTER_OP_THREADS: 1,
  ORT_GRAPH_OPT: 'all',
  ORT_LOG_SEVERITY: 3,
  ORT_CPU_MEM_ARENA: false,
};

/** 0, 1, 2 and 3 are excluded: they are array indices and channel counts everywhere. */
const EXEMPT = new Set([0, 1, 2, 3]);

function bannedNumbers(): Set<number> {
  const out = new Set<number>();
  for (const value of Object.values(TABLE)) {
    const numbers = typeof value === 'number' ? [value] : Array.isArray(value) ? value : [];
    for (const n of numbers) if (!EXEMPT.has(n)) out.add(n);
  }
  // DET_SCALE is 1 / 255; the literal a stage file could reach for is 255, not 0.0039...
  out.delete(1 / 255);
  out.add(255);
  return out;
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function numericLiterals(source: string): number[] {
  return [...stripComments(source).matchAll(/(?<![\w.$])\d[\d_]*(?:\.\d+)?(?![\w.$])/g)].map((m) =>
    Number(m[0].replace(/_/g, '')),
  );
}

describe('MUST-4.41: the pinned constant table', () => {
  it.each(Object.entries(TABLE))('%s equals the spec value', (name, expected) => {
    expect((C as Record<string, unknown>)[name]).toEqual(expected);
  });

  it('every other file under onnx/ reaches for the constant, never the number', () => {
    const banned = bannedNumbers();
    const offenders: string[] = [];
    for (const entry of fs.readdirSync(ONNX_DIR)) {
      if (entry === 'constants.ts' || !entry.endsWith('.ts')) continue;
      const found = numericLiterals(fs.readFileSync(path.join(ONNX_DIR, entry), 'utf8'));
      for (const value of found) if (banned.has(value)) offenders.push(`${entry}: ${value}`);
    }
    expect(offenders).toEqual([]);
  });
});

describe('plan resolution 14: the client-safe byte cap is pinned to the server one', () => {
  it('SCANNER_MAX_OUTPUT_BYTES equals MAX_RECEIPT_BYTES', () => {
    // scan.ts cannot import @/lib/warranty/receipts: that module pulls node:fs, node:crypto
    // and @/lib/env, and scan.ts is value-imported by a 'use client' component. This test is
    // the pin that stops the duplicate drifting.
    expect(C.SCANNER_MAX_OUTPUT_BYTES).toBe(MAX_RECEIPT_BYTES);
  });
});

describe('MUST-2.1: constants.ts, contours.ts and assemble.ts are pure', () => {
  it.each(['constants.ts', 'contours.ts', 'assemble.ts'])('%s imports nothing forbidden', (file) => {
    const source = fs.readFileSync(path.join(ONNX_DIR, file), 'utf8');
    expect(source).not.toMatch(/from\s+['"]@\/db/);
    expect(source).not.toMatch(/from\s+['"]@\/lib\/env['"]/);
    expect(source).not.toMatch(/from\s+['"]node:/);
    expect(source).not.toMatch(/['"]onnxruntime-node['"]/);
    expect(source).not.toMatch(/from\s+['"]sharp['"]/);
  });

  it('constants.ts imports nothing at all', () => {
    const source = stripComments(fs.readFileSync(path.join(ONNX_DIR, 'constants.ts'), 'utf8'));
    expect(source).not.toMatch(/^\s*import\s/m);
  });
});

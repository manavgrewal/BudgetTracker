import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  CLS_INPUT_HEIGHT,
  CLS_INPUT_WIDTH,
  DET_SIZE_MULTIPLE,
  OCR_PROBE_OK_LINE,
  ORT_CPU_MEM_ARENA,
  ORT_GRAPH_OPT,
  ORT_INTER_OP_THREADS,
  ORT_INTRA_OP_THREADS,
  ORT_LOG_SEVERITY,
  REC_BASE_WIDTH,
  REC_INPUT_HEIGHT,
} from '@/lib/warranty/ocr/onnx/constants';
import {
  CLS_MODEL_FILENAME,
  DET_MODEL_FILENAME,
  REC_MODEL_FILENAME,
} from '@/lib/warranty/ocr/onnx/models';

const run = promisify(execFile);
const script = path.join(process.cwd(), 'scripts', 'ocr-probe.mjs');

describe('scripts/ocr-probe.mjs source (MUST-5.4)', () => {
  const source = fs.readFileSync(script, 'utf8');

  it('touches no database, no socket and no disk write', () => {
    expect(source).not.toContain('better-sqlite3');
    expect(source).not.toContain('@/db');
    expect(source).not.toMatch(/(?<![.\w])fetch\s*\(/);
    expect(source).not.toContain('writeFile');
    expect(source).not.toContain('process.env');
  });

  it('pins the same ok line the parent compares against', () => {
    expect(source).toContain(`'${OCR_PROBE_OK_LINE}'`);
  });
});

// Ruling P10a, applied to the probe exactly as it is applied to check-ocr-assets.mjs. The
// script cannot import '@/...', so it duplicates; these assertions are what stop the
// duplicate drifting from the values the app actually runs with.
describe('scripts/ocr-probe.mjs duplicates the pinned constants faithfully', () => {
  const source = fs.readFileSync(script, 'utf8');

  it('re-types the six session options at their pinned values', () => {
    expect(source).toContain(`intraOpNumThreads: ${ORT_INTRA_OP_THREADS}`);
    expect(source).toContain(`interOpNumThreads: ${ORT_INTER_OP_THREADS}`);
    expect(source).toContain(`graphOptimizationLevel: '${ORT_GRAPH_OPT}'`);
    expect(source).toContain(`logSeverityLevel: ${ORT_LOG_SEVERITY}`);
    expect(source).toContain(`enableCpuMemArena: ${ORT_CPU_MEM_ARENA}`);
    expect(source).toContain("executionProviders: ['cpu']");
  });

  it('probes the three real filenames', () => {
    for (const filename of [DET_MODEL_FILENAME, CLS_MODEL_FILENAME, REC_MODEL_FILENAME]) {
      expect(source).toContain(`'${filename}'`);
    }
  });

  it('probes the classifier and recogniser at their pinned input shapes', () => {
    // A probe that loads the graphs but runs them at some other shape can miss exactly the
    // kernel the app will select.
    expect(source).toContain(`[1, 3, ${CLS_INPUT_HEIGHT}, ${CLS_INPUT_WIDTH}]`);
    expect(source).toContain(`[1, 3, ${REC_INPUT_HEIGHT}, ${REC_BASE_WIDTH}]`);
    // The detector takes one DBNet stride, which is the smallest valid input.
    expect(source).toContain(`[1, 3, ${DET_SIZE_MULTIPLE}, ${DET_SIZE_MULTIPLE}]`);
  });
});

describe('MUST-13.3: the real probe against the real models', () => {
  it('loads all three graphs, runs three inferences and exits 0 with the ok line', async () => {
    const { stdout } = await run(process.execPath, [script], { cwd: process.cwd() });
    expect(stdout.trim().split('\n').at(-1)).toBe(OCR_PROBE_OK_LINE);
  }, 60_000);
});

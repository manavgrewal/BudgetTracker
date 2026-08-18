import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { assembleText, type AssemblyBox } from '@/lib/warranty/ocr/onnx/assemble';
import type { Quad } from '@/lib/warranty/ocr/onnx/contours';
import { suggestFromOcrText } from '@/lib/warranty/suggest';

function quad(x0: number, y0: number, x1: number, y1: number): Quad {
  return [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
  ] as const;
}

function fixture(): AssemblyBox[] {
  const raw = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), 'tests/fixtures/ocr/receipt-boxes.json'), 'utf8'),
  ) as { quad: [number, number][]; text: string; score: number }[];
  return raw.map((entry) => ({
    quad: entry.quad.map(([x, y]) => ({ x, y })) as unknown as Quad,
    text: entry.text,
    score: entry.score,
  }));
}

describe('assembleText (MUST-4.33)', () => {
  it('merges two boxes overlapping by 60 percent of the shorter height', () => {
    // Box A spans y 0..20, box B spans y 8..28, both 20 tall. Overlap is
    // min(20, 28) - max(0, 8) = 12, and 12 / 20 = 0.6, which clears LINE_OVERLAP_RATIO.
    const text = assembleText([
      { quad: quad(0, 0, 50, 20), text: 'left', score: 0.9 },
      { quad: quad(60, 8, 110, 28), text: 'right', score: 0.9 },
    ]);
    expect(text).toBe('left right');
  });

  it('does not merge two boxes overlapping by 40 percent', () => {
    // Same shapes shifted four pixels further down: overlap is
    // min(20, 32) - max(0, 12) = 8, and 8 / 20 = 0.4, which does not.
    const text = assembleText([
      { quad: quad(0, 0, 50, 20), text: 'top', score: 0.9 },
      { quad: quad(60, 12, 110, 32), text: 'bottom', score: 0.9 },
    ]);
    expect(text).toBe('top\nbottom');
  });

  it('merges at exactly LINE_OVERLAP_RATIO, because the comparison is at-or-above', () => {
    // Overlap 10 of a 20 tall pair is exactly 0.5.
    const text = assembleText([
      { quad: quad(0, 0, 50, 20), text: 'a', score: 0.9 },
      { quad: quad(60, 10, 110, 30), text: 'b', score: 0.9 },
    ]);
    expect(text).toBe('a b');
  });

  it('emits a single box as one line with no trailing newline', () => {
    expect(assembleText([{ quad: quad(0, 0, 10, 10), text: 'only', score: 0.9 }])).toBe('only');
  });

  it('returns the empty string for no boxes', () => {
    expect(assembleText([])).toBe('');
  });
});

describe('MUST-4.34: the assembled text is what suggest.ts can read (risk R9)', () => {
  const text = assembleText(fixture());

  it('puts the vendor on the first line even though the fixture is scrambled', () => {
    expect(text.split('\n')[0]).toBe('HOME HARDWARE');
  });

  it('keeps the TOTAL line intact and on one line', () => {
    expect(text).toMatch(/^TOTAL 42\.17$/m);
  });

  it('keeps the subtotal on its own line, so it cannot be read as the total', () => {
    expect(text).toMatch(/^Subtotal 37\.85$/m);
  });

  // The single most important assertion in this suite. Better OCR that assembles into one
  // long line would make every suggestion worse while looking like an improvement.
  it('yields the expected vendor, date and price through the real suggester', () => {
    expect(suggestFromOcrText(text, '2026-08-18')).toEqual({
      vendor: 'HOME HARDWARE',
      purchaseDate: '2026-03-14',
      priceCents: 4217,
    });
  });
});

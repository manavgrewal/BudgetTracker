import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ScannedPdfError, extractPdfText } from '@/lib/warranty/ocr/pdf';

/**
 * M5: pdf.ts had zero execution coverage. MUST-7.17 forbids loading the real WASM OCR
 * engine in tests — it does NOT forbid pdfjs-dist, which reads a PDF's own text layer and
 * never touches tesseract or any .wasm file. So these fixtures are hand-authored, minimal,
 * but STRUCTURALLY REAL PDFs, run through the actual extractPdfText().
 */
let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-pdf-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A minimal single-page PDF with one Helvetica text-show operator (or none, for `text === ''`). */
function buildMinimalPdf(text: string): Buffer {
  const escaped = text.replace(/([()\\])/g, '\\$1');
  const content = text.length > 0 ? `BT /F1 24 Tf 10 100 Td (${escaped}) Tj ET` : '';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /MediaBox [0 0 400 200] /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
  ];

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefStart = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return Buffer.from(pdf, 'latin1');
}

function writeFixture(text: string): string {
  const file = path.join(dir, 'fixture.pdf');
  fs.writeFileSync(file, buildMinimalPdf(text));
  return file;
}

describe('extractPdfText (M5 — real pdfjs-dist execution, not the OCR engine)', () => {
  it('reads the text layer of a real text-layer PDF', async () => {
    const file = writeFixture('HOME DEPOT TOTAL 42.00 hardware receipt');
    const text = await extractPdfText(file);
    expect(text).toContain('HOME DEPOT TOTAL 42.00');
  });

  it('throws ScannedPdfError when the PDF has no text layer', async () => {
    const file = writeFixture('');
    await expect(extractPdfText(file)).rejects.toThrow(ScannedPdfError);
  });
});

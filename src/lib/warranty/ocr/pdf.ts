import fs from 'node:fs';

/** MUST-7.15: below this, the PDF is a scan, not a text-layer document. */
export const MIN_PDF_TEXT_CHARS = 20;

export const SCANNED_PDF_MESSAGE =
  'This PDF has no text layer — it looks like a scan. Scanned-PDF OCR is not supported yet; photograph the receipt instead.';

export class ScannedPdfError extends Error {
  constructor() {
    super(SCANNED_PDF_MESSAGE);
    this.name = 'ScannedPdfError';
  }
}

/**
 * MUST-7.14: PDFs are NOT rasterised and NOT run through Tesseract. Text comes from the
 * document's own text layer via pdfjs-dist's legacy Node build, with every remote fetch
 * disabled (no font URL, no CMap URL, no worker fetch) so this path makes no network call.
 *
 * pdf-parse was rejected (§17.10): its published build executes a demo-file read at
 * require time when module.parent is unset, which breaks under bundlers and in ESM, and
 * it is unmaintained.
 */
export async function extractPdfText(filePath: string): Promise<string> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(fs.readFileSync(filePath));
  const doc = await pdfjs.getDocument({
    data,
    useWorkerFetch: false,
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
  }).promise;

  try {
    const pages: string[] = [];
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
      const page = await doc.getPage(pageNumber);
      const content = await page.getTextContent();
      pages.push(
        content.items
          .map((item) => ('str' in item ? item.str : ''))
          .join(' ')
          .replace(/[ \t]+/g, ' ')
          .trim(),
      );
      page.cleanup();
    }
    const text = pages.join('\n');
    if (text.replace(/\s/g, '').length < MIN_PDF_TEXT_CHARS) throw new ScannedPdfError();
    return text;
  } finally {
    await doc.destroy();
  }
}

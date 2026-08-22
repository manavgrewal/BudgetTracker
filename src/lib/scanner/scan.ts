import {
  SCANNER_JPEG_QUALITY,
  SCANNER_MAX_OUTPUT_BYTES,
  SCANNER_MIN_QUAD_AREA_RATIO,
  SCANNER_MIN_SIDE_RATIO,
  SCANNER_OUTPUT_MAX_PX,
  SCANNER_WORK_MAX_PX,
} from '@/lib/warranty/ocr/onnx/constants';
import { loadScanner } from '@/lib/scanner/load';

// Do NOT import MAX_RECEIPT_BYTES from @/lib/warranty/receipts here. This module is
// value-imported by a 'use client' component, and that one pulls node:fs, node:path,
// node:crypto and @/lib/env into the browser bundle. SCANNER_MAX_OUTPUT_BYTES is the same
// number in a client-safe file, and tests/ops/constants.test.ts pins the two equal.

export interface ScanQuad {
  topLeft: { x: number; y: number };
  topRight: { x: number; y: number };
  bottomRight: { x: number; y: number };
  bottomLeft: { x: number; y: number };
}

export interface ScanResult {
  /** The file to upload. Either the corrected JPEG or, on any failure, the original. */
  file: File;
  /** Present only when a crop actually happened. */
  corrected?: { url: string; quad: ScanQuad; sourceWidth: number; sourceHeight: number };
}

const corners = (quad: ScanQuad) => [quad.topLeft, quad.topRight, quad.bottomRight, quad.bottomLeft];

/** MUST-8.13's five conditions, all of which must hold. A quad hugging the whole frame is
 *  the detector finding the photo's border; a sliver is a countertop edge. */
export function isUsableQuad(quad: ScanQuad, workWidth: number, workHeight: number): boolean {
  const points = corners(quad);
  if (points.length !== 4) return false;
  if (points.some((point) => !Number.isFinite(point.x) || !Number.isFinite(point.y))) return false;

  let cross = 0;
  for (let i = 0; i < 4; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % 4];
    const c = points[(i + 2) % 4];
    const z = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (z === 0) continue;
    if (cross === 0) cross = Math.sign(z);
    else if (Math.sign(z) !== cross) return false;
  }

  let area = 0;
  for (let i = 0; i < 4; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % 4];
    area += a.x * b.y - b.x * a.y;
  }
  if (Math.abs(area) / 2 < workWidth * workHeight * SCANNER_MIN_QUAD_AREA_RATIO) return false;

  const minSide = Math.max(workWidth, workHeight) * SCANNER_MIN_SIDE_RATIO;
  for (let i = 0; i < 4; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % 4];
    if (Math.hypot(b.x - a.x, b.y - a.y) < minSide) return false;
  }
  return true;
}

function canvasOf(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function toBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', SCANNER_JPEG_QUALITY));
}

function jpegName(original: string): string {
  const stem = original.replace(/\.[^.]+$/, '');
  return `${stem.length > 0 ? stem : 'receipt'}.jpg`;
}

async function run(file: File): Promise<ScanResult> {
  if (!file.type.startsWith('image/')) return { file };
  // Bail before paying for the ~9 MB scanner load if the runtime cannot even decode the
  // image: createImageBitmap is universal across current browsers but is exactly the kind
  // of thing an old or unusual one might lack, and there is no point loading opencv.js only
  // to fail on the next line.
  if (typeof createImageBitmap !== 'function') return { file };
  const { cv, scanner } = await loadScanner();

  const bitmap = await createImageBitmap(file);
  try {
    const workScale = Math.min(1, SCANNER_WORK_MAX_PX / Math.max(bitmap.width, bitmap.height));
    const workWidth = Math.max(1, Math.round(bitmap.width * workScale));
    const workHeight = Math.max(1, Math.round(bitmap.height * workScale));
    const work = canvasOf(workWidth, workHeight);
    work.getContext('2d')?.drawImage(bitmap, 0, 0, workWidth, workHeight);

    // jscanify requires a cv.Mat, not a canvas (jscanify.js:28 "@param img ... cv.Mat";
    // jscanify's own highlightPaper converts with cv.imread before calling this). Passing a
    // canvas directly throws a BindingError on every call. Both the Mat and the contour Mat
    // findPaperContour hands back are ours to free -- the wasm heap does not garbage-collect.
    const workMat = cv.imread(work);
    let workQuad: ScanQuad;
    try {
      const contour = scanner.findPaperContour(workMat) as { delete(): void } | null | undefined;
      if (contour === null || contour === undefined) return { file };
      try {
        const points = scanner.getCornerPoints(contour);
        workQuad = {
          topLeft: points.topLeftCorner,
          topRight: points.topRightCorner,
          bottomRight: points.bottomRightCorner,
          bottomLeft: points.bottomLeftCorner,
        };
      } finally {
        contour.delete();
      }
    } finally {
      workMat.delete();
    }
    if (!isUsableQuad(workQuad, workWidth, workHeight)) return { file };

    const back = (point: { x: number; y: number }) => ({ x: point.x / workScale, y: point.y / workScale });
    const fullQuad: ScanQuad = {
      topLeft: back(workQuad.topLeft),
      topRight: back(workQuad.topRight),
      bottomRight: back(workQuad.bottomRight),
      bottomLeft: back(workQuad.bottomLeft),
    };
    const side = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(b.x - a.x, b.y - a.y);
    const meanWidth = (side(fullQuad.topLeft, fullQuad.topRight) + side(fullQuad.bottomLeft, fullQuad.bottomRight)) / 2;
    const meanHeight = (side(fullQuad.topLeft, fullQuad.bottomLeft) + side(fullQuad.topRight, fullQuad.bottomRight)) / 2;
    const outScale = Math.min(1, SCANNER_OUTPUT_MAX_PX / Math.max(meanWidth, meanHeight));
    const outWidth = Math.max(1, Math.round(meanWidth * outScale));
    const outHeight = Math.max(1, Math.round(meanHeight * outScale));

    // F3 defect fix: jscanify's extractPaper (jscanify.js:144) does its own `cv.imread(image)`
    // internally, producing an RGBA Mat at the FULL resolution of whatever canvas is handed
    // to it -- and warpPerspective only ever asks that Mat for outWidth x outHeight pixels
    // out, so drawing at the untouched bitmap resolution buys nothing. It also costs a lot: a
    // 12 MP photo is ~48 MB as RGBA, sitting in a wasm heap that cannot shrink, and if
    // warpPerspective or imshow throws before jscanify's own `img.delete()` runs, that Mat
    // leaks. `outScale` above is exactly the factor that already caps meanWidth/meanHeight
    // down to outWidth/outHeight, so applying that SAME scale to the whole bitmap bounds the
    // extract source to no more resolution than the capped output can use, and applying it to
    // fullQuad's corners keeps them pointing at the same physical spot on the shrunk canvas --
    // the quad mapping has to stay consistent with the source it is measured against, which is
    // the whole point of handing jscanify a validated quad instead of letting it re-detect.
    const extractWidth = Math.max(1, Math.round(bitmap.width * outScale));
    const extractHeight = Math.max(1, Math.round(bitmap.height * outScale));
    const extractSource = canvasOf(extractWidth, extractHeight);
    extractSource.getContext('2d')?.drawImage(bitmap, 0, 0, extractWidth, extractHeight);
    const toExtractSource = (point: { x: number; y: number }) => ({ x: point.x * outScale, y: point.y * outScale });
    // Hand jscanify the quad MUST-8.13 already validated, instead of letting it silently
    // re-detect on the extract source (jscanify.js:147:
    // `cornerPoints ? null : this.findPaperContour(img)`), which both makes isUsableQuad
    // decorative and defeats the SCANNER_WORK_MAX_PX downscale cap.
    const extracted = scanner.extractPaper(extractSource, outWidth, outHeight, {
      topLeftCorner: toExtractSource(fullQuad.topLeft),
      topRightCorner: toExtractSource(fullQuad.topRight),
      bottomLeftCorner: toExtractSource(fullQuad.bottomLeft),
      bottomRightCorner: toExtractSource(fullQuad.bottomRight),
    });
    const blob = await toBlob(extracted);
    if (blob === null) return { file };
    // A crop that fails the size limit is not a crop, it is a rejected upload.
    if (blob.size > SCANNER_MAX_OUTPUT_BYTES) return { file };

    const corrected = new File([blob], jpegName(file.name), { type: 'image/jpeg' });
    return {
      file: corrected,
      corrected: {
        url: URL.createObjectURL(blob),
        quad: fullQuad,
        sourceWidth: bitmap.width,
        sourceHeight: bitmap.height,
      },
    };
  } finally {
    bitmap.close();
  }
}

/**
 * MUST-8.15: never throws, never rejects, and never blocks an upload. Every failure returns
 * the original file with one console.debug line. The failure of an assistive crop is not a
 * failure the owner needs to hear about, and the server-side pipeline then does exactly
 * what it would have done without a scanner.
 */
export async function scanReceiptFile(file: File): Promise<ScanResult> {
  try {
    if (typeof WebAssembly === 'undefined') return { file };
    return await run(file);
  } catch (error) {
    console.debug('[scanner] falling back to the original file', error);
    return { file };
  }
}

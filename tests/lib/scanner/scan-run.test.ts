// @vitest-environment jsdom
//
// B7: run() in src/lib/scanner/scan.ts had zero executed test coverage. Every existing test
// (tests/app/receipt-scanner.test.tsx) mocks scanReceiptFile itself at the module boundary, so
// none of them ever call the real run(). That let three real defects ship silently:
//   B1: findPaperContour was called with a raw canvas instead of a cv.Mat (jscanify throws a
//       BindingError on anything else), so scanReceiptFile's catch-all swallowed it and every
//       upload silently fell back to the original file.
//   B2: extractPaper was called without the corner points that MUST-8.13 (isUsableQuad)
//       already validated, so jscanify silently re-detected on the untouched full-resolution
//       bitmap and warped whatever *that* found -- isUsableQuad became decorative.
// This file drives the real run() (via the real, exported scanReceiptFile) against a
// recording fake `cv` and a recording fake `JscanifyLike`, and asserts on the actual arguments
// each fake received -- the same technique the ledger says would have caught all three.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CvLike, CvMatLike, JscanifyCorners, JscanifyLike } from '@/lib/scanner/load';
import * as loadModule from '@/lib/scanner/load';
import { scanReceiptFile } from '@/lib/scanner/scan';
import { SCANNER_OUTPUT_MAX_PX } from '@/lib/warranty/ocr/onnx/constants';

// Deliberately the same quad already proven usable by MUST-8.13's own suite
// (tests/app/receipt-scanner.test.tsx `quad()`), against a 100x100 working frame -- so
// workScale is exactly 1 and fullQuad equals workQuad, keeping the arithmetic in this file
// easy to check by eye.
function quad() {
  return {
    topLeft: { x: 10, y: 10 },
    topRight: { x: 90, y: 12 },
    bottomRight: { x: 92, y: 90 },
    bottomLeft: { x: 8, y: 88 },
  };
}

function makeMat(): CvMatLike & { deleted: boolean } {
  const mat = { deleted: false, delete: vi.fn() };
  mat.delete.mockImplementation(() => {
    mat.deleted = true;
  });
  return mat;
}

/** A canvas-shaped stand-in for what extractPaper returns: real jsdom canvases cannot
 *  toBlob() (jsdom has no `canvas` npm package backing it), so the fake supplies its own. */
function fakeExtractedCanvas(blob: Blob): HTMLCanvasElement {
  return { toBlob: (callback: (blob: Blob | null) => void) => callback(blob) } as unknown as HTMLCanvasElement;
}

interface Rig {
  cv: CvLike;
  scanner: JscanifyLike;
  imreadMats: ReturnType<typeof makeMat>[];
  contourMat: ReturnType<typeof makeMat>;
  findPaperContourArgs: unknown[];
  extractPaperArgs: [HTMLCanvasElement, number, number, JscanifyCorners | undefined][];
  contourResult: CvMatLike | null;
}

function buildRig(): Rig {
  const imreadMats: ReturnType<typeof makeMat>[] = [];
  const contourMat = makeMat();
  const findPaperContourArgs: unknown[] = [];
  const extractPaperArgs: [HTMLCanvasElement, number, number, JscanifyCorners | undefined][] = [];
  const rig: Rig = {
    imreadMats,
    contourMat,
    findPaperContourArgs,
    extractPaperArgs,
    contourResult: contourMat,
    cv: {
      imread: vi.fn((_source: HTMLCanvasElement) => {
        const mat = makeMat();
        imreadMats.push(mat);
        return mat;
      }),
      then: vi.fn((onfulfilled: (value: CvLike) => void) => onfulfilled(rig.cv)),
    },
    scanner: {
      findPaperContour: vi.fn((image: unknown) => {
        findPaperContourArgs.push(image);
        return rig.contourResult;
      }),
      getCornerPoints: vi.fn(() => {
        const q = quad();
        return {
          topLeftCorner: q.topLeft,
          topRightCorner: q.topRight,
          bottomLeftCorner: q.bottomLeft,
          bottomRightCorner: q.bottomRight,
        };
      }),
      extractPaper: vi.fn((canvas: HTMLCanvasElement, width: number, height: number, points?: JscanifyCorners) => {
        extractPaperArgs.push([canvas, width, height, points]);
        return fakeExtractedCanvas(new Blob(['fake-jpeg-bytes'], { type: 'image/jpeg' }));
      }),
    },
  };
  return rig;
}

function fakeBitmap(width: number, height: number) {
  return { width, height, close: vi.fn() };
}

beforeEach(() => {
  // jsdom canvases have no real 2D backend (no `canvas` npm package): getContext('2d')
  // otherwise logs a noisy "not implemented" error and returns null anyway. Returning null
  // directly exercises scan.ts's own `?.drawImage(...)` guard for that case.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  (URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = vi.fn(() => 'blob:mock');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('B1: the scanner converts the canvas to a cv.Mat before calling findPaperContour', () => {
  it('findPaperContour receives the Mat cv.imread returned, never the canvas', async () => {
    const rig = buildRig();
    vi.spyOn(loadModule, 'loadScanner').mockResolvedValue({ cv: rig.cv, scanner: rig.scanner });
    vi.stubGlobal('createImageBitmap', vi.fn(async () => fakeBitmap(100, 100)));

    const file = new File(['jpeg-bytes'], 'receipt.jpg', { type: 'image/jpeg' });
    const result = await scanReceiptFile(file);

    expect(rig.cv.imread).toHaveBeenCalledTimes(1);
    const [canvasPassedToImread] = (rig.cv.imread as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(canvasPassedToImread).toBeInstanceOf(HTMLCanvasElement);

    expect(rig.findPaperContourArgs).toHaveLength(1);
    const receivedByFindPaperContour = rig.findPaperContourArgs[0];
    // The crux of B1: what jscanify's findPaperContour actually receives is the Mat
    // cv.imread(work) handed back -- not the HTMLCanvasElement scan.ts built.
    expect(receivedByFindPaperContour).not.toBeInstanceOf(HTMLCanvasElement);
    expect(receivedByFindPaperContour).toBe(rig.imreadMats[0]);

    expect(result.corrected).toBeDefined();
  });

  it('deletes both the working Mat and the contour Mat once corner points are read', async () => {
    const rig = buildRig();
    vi.spyOn(loadModule, 'loadScanner').mockResolvedValue({ cv: rig.cv, scanner: rig.scanner });
    vi.stubGlobal('createImageBitmap', vi.fn(async () => fakeBitmap(100, 100)));

    await scanReceiptFile(new File(['jpeg-bytes'], 'receipt.jpg', { type: 'image/jpeg' }));

    expect(rig.imreadMats[0].deleted).toBe(true);
    expect(rig.contourMat.deleted).toBe(true);
  });

  it('still deletes the working Mat when findPaperContour finds nothing (null contour)', async () => {
    const rig = buildRig();
    rig.contourResult = null;
    vi.spyOn(loadModule, 'loadScanner').mockResolvedValue({ cv: rig.cv, scanner: rig.scanner });
    vi.stubGlobal('createImageBitmap', vi.fn(async () => fakeBitmap(100, 100)));

    const result = await scanReceiptFile(new File(['jpeg-bytes'], 'receipt.jpg', { type: 'image/jpeg' }));

    expect(result.corrected).toBeUndefined();
    expect(rig.imreadMats[0].deleted).toBe(true);
    expect(rig.scanner.extractPaper).not.toHaveBeenCalled();
  });

  it('still deletes both Mats when the quad fails MUST-8.13 validation', async () => {
    const rig = buildRig();
    rig.scanner.getCornerPoints = vi.fn(() => ({
      // A sliver: fails isUsableQuad's minimum-side-ratio condition.
      topLeftCorner: { x: 0, y: 0 },
      topRightCorner: { x: 100, y: 0 },
      bottomRightCorner: { x: 100, y: 3 },
      bottomLeftCorner: { x: 0, y: 3 },
    }));
    vi.spyOn(loadModule, 'loadScanner').mockResolvedValue({ cv: rig.cv, scanner: rig.scanner });
    vi.stubGlobal('createImageBitmap', vi.fn(async () => fakeBitmap(100, 100)));

    const result = await scanReceiptFile(new File(['jpeg-bytes'], 'receipt.jpg', { type: 'image/jpeg' }));

    expect(result.corrected).toBeUndefined();
    expect(rig.imreadMats[0].deleted).toBe(true);
    expect(rig.contourMat.deleted).toBe(true);
    expect(rig.scanner.extractPaper).not.toHaveBeenCalled();
  });

  it('F4: falls back gracefully, via isUsableQuad returning false, when jscanify leaves a corner unset', async () => {
    const rig = buildRig();
    // node_modules/jscanify/src/jscanify.js:207-259's getCornerPoints leaves a corner
    // undefined when no contour point lands in that quadrant -- this is that exact shape,
    // not a degenerate-but-defined quad. Before the F4 fix this threw a TypeError inside
    // isUsableQuad instead of the gate cleanly returning false.
    rig.scanner.getCornerPoints = vi.fn(() => ({
      topLeftCorner: { x: 10, y: 10 },
      topRightCorner: { x: 90, y: 12 },
      bottomRightCorner: { x: 92, y: 90 },
      bottomLeftCorner: undefined,
    }));
    vi.spyOn(loadModule, 'loadScanner').mockResolvedValue({ cv: rig.cv, scanner: rig.scanner });
    vi.stubGlobal('createImageBitmap', vi.fn(async () => fakeBitmap(100, 100)));

    const result = await scanReceiptFile(new File(['jpeg-bytes'], 'receipt.jpg', { type: 'image/jpeg' }));

    // MUST-8.15's fallback, but reached via isUsableQuad actually running and returning
    // false -- proven by extractPaper never being called and both Mats still being freed --
    // not via the outer catch-all swallowing a thrown TypeError.
    expect(result.corrected).toBeUndefined();
    expect(rig.imreadMats[0].deleted).toBe(true);
    expect(rig.contourMat.deleted).toBe(true);
    expect(rig.scanner.extractPaper).not.toHaveBeenCalled();
  });
});

describe('B2: the validated quad is handed to extractPaper instead of being discarded', () => {
  it('extractPaper receives 4 arguments: the full canvas, the output size, and the validated quad', async () => {
    const rig = buildRig();
    vi.spyOn(loadModule, 'loadScanner').mockResolvedValue({ cv: rig.cv, scanner: rig.scanner });
    vi.stubGlobal('createImageBitmap', vi.fn(async () => fakeBitmap(100, 100)));

    await scanReceiptFile(new File(['jpeg-bytes'], 'receipt.jpg', { type: 'image/jpeg' }));

    expect(rig.extractPaperArgs).toHaveLength(1);
    const [canvasArg, , , pointsArg] = rig.extractPaperArgs[0];
    expect(canvasArg).toBeInstanceOf(HTMLCanvasElement);
    // The exact mapping from ScanQuad's naming to jscanify's corner naming (MUST verify: this
    // is the mapping B2 says to check "against the installed source").
    const q = quad();
    expect(pointsArg).toEqual({
      topLeftCorner: q.topLeft,
      topRightCorner: q.topRight,
      bottomLeftCorner: q.bottomLeft,
      bottomRightCorner: q.bottomRight,
    });
  });

  it('never lets extractPaper re-detect: it is called with corner points on every accepted quad', async () => {
    const rig = buildRig();
    vi.spyOn(loadModule, 'loadScanner').mockResolvedValue({ cv: rig.cv, scanner: rig.scanner });
    vi.stubGlobal('createImageBitmap', vi.fn(async () => fakeBitmap(100, 100)));

    await scanReceiptFile(new File(['jpeg-bytes'], 'receipt.jpg', { type: 'image/jpeg' }));

    const [, , , pointsArg] = rig.extractPaperArgs[0];
    // jscanify.js:147 -- `cornerPoints ? null : this.findPaperContour(img)` -- only skips
    // re-detection when this argument is truthy. An undefined 4th argument (the pre-fix
    // behaviour) would silently re-run detection on the untouched full-resolution bitmap.
    expect(pointsArg).toBeDefined();
  });
});

describe('F3: the extract source is bounded to the capped output, and the quad is scaled to match', () => {
  it('shrinks the canvas handed to extractPaper, and scales the quad by the exact same factor, once the source exceeds SCANNER_OUTPUT_MAX_PX', async () => {
    const rig = buildRig();
    // A big, square working frame (bigger than SCANNER_WORK_MAX_PX = 1600, so workScale < 1)
    // with a quad that fills nearly all of it -- comfortably passes every MUST-8.13 check.
    const workSide = 1600;
    rig.scanner.getCornerPoints = vi.fn(() => ({
      topLeftCorner: { x: 100, y: 100 },
      topRightCorner: { x: 1500, y: 100 },
      bottomRightCorner: { x: 1500, y: 1500 },
      bottomLeftCorner: { x: 100, y: 1500 },
    }));
    vi.spyOn(loadModule, 'loadScanner').mockResolvedValue({ cv: rig.cv, scanner: rig.scanner });
    // A big bitmap: workScale = 1600 / 8000 = 0.2, so the quad scales back up (fullQuad) to a
    // 7000x7000 square -- well past SCANNER_OUTPUT_MAX_PX (2400), which is what makes outScale
    // (and therefore F3's bound on the extract source) less than 1 in this test.
    const bitmapSide = 8000;
    vi.stubGlobal('createImageBitmap', vi.fn(async () => fakeBitmap(bitmapSide, bitmapSide)));

    await scanReceiptFile(new File(['jpeg-bytes'], 'receipt.jpg', { type: 'image/jpeg' }));

    expect(rig.extractPaperArgs).toHaveLength(1);
    const [canvasArg, outWidth, outHeight, pointsArg] = rig.extractPaperArgs[0];

    // The math scan.ts itself does, replicated here rather than re-imported, so this test
    // fails if that math ever silently changes: workScale = 1600/8000 = 0.2, so the quad
    // above (already a 1400x1400 square in work coordinates) becomes a 7000x7000 square in
    // full/original-bitmap coordinates; outScale is what caps THAT down to
    // SCANNER_OUTPUT_MAX_PX.
    const workScale = workSide / bitmapSide;
    const fullQuadSide = 1400 / workScale;
    const outScale = Math.min(1, SCANNER_OUTPUT_MAX_PX / fullQuadSide);
    expect(outScale).toBeLessThan(1); // otherwise this test is not exercising F3 at all

    // F3: the canvas handed to extractPaper is bounded by outScale, NOT the untouched
    // 8000x8000 bitmap -- this is the whole leak/memory fix.
    expect(canvasArg).toBeInstanceOf(HTMLCanvasElement);
    const canvas = canvasArg as HTMLCanvasElement;
    expect(canvas.width).toBe(Math.max(1, Math.round(bitmapSide * outScale)));
    expect(canvas.height).toBe(Math.max(1, Math.round(bitmapSide * outScale)));
    expect(canvas.width).toBeLessThan(bitmapSide);

    // The output size passed alongside it is unaffected -- still capped at
    // SCANNER_OUTPUT_MAX_PX, independent of how the source was bounded.
    expect(Math.max(outWidth, outHeight)).toBeLessThanOrEqual(SCANNER_OUTPUT_MAX_PX);

    // The quad handed to extractPaper must be scaled by the exact same outScale that bounded
    // the canvas -- not left in full-bitmap coordinates -- or the crop would warp the wrong
    // region of a canvas that no longer matches the bitmap's original scale.
    const fullQuadTopLeft = { x: 100 / workScale, y: 100 / workScale };
    expect(pointsArg?.topLeftCorner?.x).toBeCloseTo(fullQuadTopLeft.x * outScale, 6);
    expect(pointsArg?.topLeftCorner?.y).toBeCloseTo(fullQuadTopLeft.y * outScale, 6);
    const fullQuadBottomRight = { x: 1500 / workScale, y: 1500 / workScale };
    expect(pointsArg?.bottomRightCorner?.x).toBeCloseTo(fullQuadBottomRight.x * outScale, 6);
    expect(pointsArg?.bottomRightCorner?.y).toBeCloseTo(fullQuadBottomRight.y * outScale, 6);
  });

  it('leaves the extract source at full bitmap resolution when the quad is already within the cap (no regression)', async () => {
    const rig = buildRig();
    vi.spyOn(loadModule, 'loadScanner').mockResolvedValue({ cv: rig.cv, scanner: rig.scanner });
    vi.stubGlobal('createImageBitmap', vi.fn(async () => fakeBitmap(100, 100)));

    await scanReceiptFile(new File(['jpeg-bytes'], 'receipt.jpg', { type: 'image/jpeg' }));

    const [canvasArg] = rig.extractPaperArgs[0];
    const canvas = canvasArg as HTMLCanvasElement;
    // outScale is 1 here (the 100x100 frame is nowhere near SCANNER_OUTPUT_MAX_PX), so F3's
    // bound is a no-op and the extract source is exactly the untouched bitmap, same as before.
    expect(canvas.width).toBe(100);
    expect(canvas.height).toBe(100);
  });
});

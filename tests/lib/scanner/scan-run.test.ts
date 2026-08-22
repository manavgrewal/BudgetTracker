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

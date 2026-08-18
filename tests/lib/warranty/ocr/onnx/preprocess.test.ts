import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import {
  DESKEW_MIN_APPLY_DEG,
  PREPROCESS_MAX_LONG_SIDE_PX,
  PREPROCESS_MAX_UPSCALE,
  PREPROCESS_MIN_LONG_SIDE_PX,
} from '@/lib/warranty/ocr/onnx/constants';
import { estimateSkewDeg, preprocessReceipt } from '@/lib/warranty/ocr/onnx/preprocess';
import { barGridPng, exifOrientation6Png, solidRgb, transparentBlackPng } from '../../../../helpers/ocr-images';

let dir: string;
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-ocr-pre-'));
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

async function write(name: string, bytes: Buffer): Promise<string> {
  const file = path.join(dir, name);
  fs.writeFileSync(file, bytes);
  return file;
}

async function png(width: number, height: number, rgb: [number, number, number]): Promise<Buffer> {
  return sharp(solidRgb(width, height, rgb), { raw: { width, height, channels: 3 } }).png().toBuffer();
}

describe('MUST-4.4: the sharp pipeline', () => {
  it('applies the EXIF orientation tag, so a portrait phone photo is not read sideways', async () => {
    const file = await write('exif6.jpg', await exifOrientation6Png());
    const out = await preprocessReceipt(file);
    // Stored 120 by 60 with orientation 6, which means "rotate 90 clockwise to display".
    expect(out.height).toBeGreaterThan(out.width);
  });

  it('flattens transparency onto white, not black', async () => {
    const file = await write('transparent.png', await transparentBlackPng());
    const out = await preprocessReceipt(file);
    expect(out.data[0]).toBeGreaterThan(240);
  });

  it('returns three channels of raw RGB with no alpha', async () => {
    const file = await write('plain.png', await png(1400, 900, [200, 200, 200]));
    const out = await preprocessReceipt(file);
    expect(out.data.length).toBe(out.width * out.height * 3);
  });

  it('upscales a 500 pixel long side to exactly the minimum', async () => {
    // 1280 / 500 = 2.56, which is under PREPROCESS_MAX_UPSCALE, so the minimum is reached.
    // The cap starts binding below 1280 / 3 = 426.67, which the next case covers; a 400
    // pixel image would come out at 1200, not 1280.
    const file = await write('small.png', await png(500, 300, [180, 180, 180]));
    const out = await preprocessReceipt(file);
    expect(Math.max(out.width, out.height)).toBe(PREPROCESS_MIN_LONG_SIDE_PX);
  });

  it('caps a 200 pixel image at the maximum upscale rather than reaching the minimum', async () => {
    // 1280 / 200 = 6.4, so PREPROCESS_MAX_UPSCALE wins: 200 * 3 = 600. Beyond 3x there is no
    // information left to recover and the extra pixels only cost detection time.
    const file = await write('tiny.png', await png(200, 150, [180, 180, 180]));
    const out = await preprocessReceipt(file);
    expect(Math.max(out.width, out.height)).toBe(Math.round(200 * PREPROCESS_MAX_UPSCALE));
    expect(Math.max(out.width, out.height)).toBeLessThan(PREPROCESS_MIN_LONG_SIDE_PX);
  });

  it('the upscale floor and the maximum upscale factor meet at 1280 / 3, and the factor wins just below it', async () => {
    // The boundary case, written down because "upscale small images to 1280" is what the
    // rule sounds like and is not what it does. This is about PREPROCESS_MAX_UPSCALE (the
    // upscale factor limit), not PREPROCESS_MAX_LONG_SIDE_PX (the downscale cap below).
    const file = await write('boundary.png', await png(400, 300, [180, 180, 180]));
    const out = await preprocessReceipt(file);
    expect(Math.max(out.width, out.height)).toBe(1200);
  });

  it('downscales a 6000 pixel image to the maximum', async () => {
    const file = await write('huge.png', await png(6000, 1000, [180, 180, 180]));
    const out = await preprocessReceipt(file);
    expect(Math.max(out.width, out.height)).toBe(PREPROCESS_MAX_LONG_SIDE_PX);
  });

  describe('MUST-4.43: the 1600 pixel long side cap (controller ruling, Task 3)', () => {
    it('downscales a 4000 pixel long side, a full resolution phone photo, to the 1600 pixel cap', async () => {
      // DET_LIMIT_TYPE = 'min' (constants.ts) supplies no upper bound of its own, so this
      // cap is the only thing standing between a full resolution phone photo and the
      // detector. PREPROCESS_MAX_LONG_SIDE_PX is pinned to 1600 for exactly that reason.
      const file = await write('phone.png', await png(4000, 3000, [180, 180, 180]));
      const out = await preprocessReceipt(file);
      expect(Math.max(out.width, out.height)).toBe(1600);
      expect(PREPROCESS_MAX_LONG_SIDE_PX).toBe(1600);
    });

    it('leaves an image exactly at the 1600 pixel cap unchanged', async () => {
      const file = await write('exact-cap.png', await png(1600, 1000, [180, 180, 180]));
      const out = await preprocessReceipt(file);
      expect(out.width).toBe(1600);
      expect(out.height).toBe(1000);
    });

    it('still upscales a 400 pixel long side per the existing rule, never past the cap', async () => {
      // Same input as the boundary case above, restated so the interaction between the
      // upscale floor and the lowered cap has its own explicit regression test: a small
      // image upscales toward PREPROCESS_MIN_LONG_SIDE_PX, never toward the cap.
      const file = await write('small-vs-cap.png', await png(400, 300, [180, 180, 180]));
      const out = await preprocessReceipt(file);
      expect(Math.max(out.width, out.height)).toBe(1200);
      expect(Math.max(out.width, out.height)).toBeLessThan(PREPROCESS_MAX_LONG_SIDE_PX);
    });
  });
});

describe('MUST-4.5 / MUST-4.6: deskew', () => {
  it('measures a 4.0 degree tilt within half a degree, with the sign the caller expects', async () => {
    // barGridPng(4) applies sharp's .rotate(4), which tilts the content CLOCKWISE. The
    // returned value is the content's skew, so it must be +4: the caller corrects with
    // .rotate(-angle). A sign error here does not fail loudly, it doubles the tilt.
    const measured = await estimateSkewDeg(await barGridPng(4));
    expect(measured).toBeGreaterThan(0);
    expect(Math.abs(measured - 4)).toBeLessThanOrEqual(0.5);
  });

  it('measures the opposite tilt as a negative angle', async () => {
    const measured = await estimateSkewDeg(await barGridPng(-4));
    expect(measured).toBeLessThan(0);
    expect(Math.abs(measured + 4)).toBeLessThanOrEqual(0.5);
  });

  it('measures a level image below the apply threshold', async () => {
    const measured = await estimateSkewDeg(await barGridPng(0));
    expect(Math.abs(measured)).toBeLessThan(DESKEW_MIN_APPLY_DEG);
  });

  it('leaves a level image byte-identical, proving the no-op path really is a no-op', async () => {
    // 1400 is between PREPROCESS_MIN_LONG_SIDE_PX and PREPROCESS_MAX_LONG_SIDE_PX, so no
    // resize happens either and the ONLY difference between the two pipelines below would be
    // a deskew rotate. The reference goes through the same intermediate PNG so a lossless
    // round-trip cannot be mistaken for a rotation.
    const level = await write('level.png', await barGridPng(0, 1400, 900));
    const out = await preprocessReceipt(level);
    const staged = await sharp(level)
      .rotate()
      .flatten({ background: '#ffffff' })
      .greyscale()
      .normalise({ lower: 1, upper: 99 })
      .png()
      .toBuffer();
    const reference = await sharp(staged).toColourspace('srgb').removeAlpha().raw().toBuffer();
    expect(Buffer.compare(out.data, reference)).toBe(0);
  });

  it('a solid image with no structure at all measures exactly 0, not the first candidate angle', async () => {
    // The degenerate case: every row sum is identical at every angle, so nothing beats the
    // seed. A search seeded at -DESKEW_SEARCH_MAX_DEG would return -10 here and rotate a
    // level receipt by ten degrees.
    expect(await estimateSkewDeg(await png(300, 200, [200, 200, 200]))).toBe(0);
  });
});

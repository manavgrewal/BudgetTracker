import { describe, it, expect } from 'vitest';
import {
  DET_MEAN,
  DET_SCALE,
  DET_SIZE_MULTIPLE,
  DET_STD,
} from '@/lib/warranty/ocr/onnx/constants';
import { buildDetTensor, detResize, detectBoxes, scaleQuad } from '@/lib/warranty/ocr/onnx/detect';
import type { Quad } from '@/lib/warranty/ocr/onnx/contours';
import type { RawImage } from '@/lib/warranty/ocr/onnx/preprocess';

/** 4 by 4 RGB with known values: pixel n has r = n, g = n + 1, b = n + 2. */
function tensor4x4(): RawImage {
  const data = Buffer.alloc(4 * 4 * 3);
  for (let i = 0; i < 16; i += 1) {
    data[i * 3] = i;
    data[i * 3 + 1] = i + 1;
    data[i * 3 + 2] = i + 2;
  }
  return { data, width: 4, height: 4 };
}

// Every expectation below is worked out by hand against DET_LIMIT_TYPE = 'min' and
// DET_LIMIT_SIDE_LEN = 736 (the Task 2 correction), not against the 'max' rule the original
// research doc described. Under 'min', the ratio only ever raises the SHORTER side up to the
// floor; it never caps the longer one, so an image whose short side already clears the floor
// is only rounded to the nearest multiple of 32, never rescaled.
describe('detResize (MUST-4.7)', () => {
  it('leaves both dimensions alone when the short side already meets the floor, only rounding to the nearest multiple of 32', () => {
    // Short side 900 >= DET_LIMIT_SIDE_LEN (736), so ratio = 1: nothing is scaled up.
    // 1400 / 32 = 43.75, rounds to 44 -> 1408. 900 / 32 = 28.125, rounds to 28 -> 896.
    const out = detResize(1400, 900);
    expect(out.resizeW).toBe(1408);
    expect(out.resizeH).toBe(896);
    expect(out.scaleX).toBeCloseTo(1400 / 1408, 10);
    expect(out.scaleY).toBeCloseTo(900 / 896, 10);
  });

  it('raises the shorter side to DET_LIMIT_SIDE_LEN when it falls below the floor', () => {
    // Short side 300 < 736, so ratio = 736 / 300. The short side (height) scales to exactly
    // 736, which is already a multiple of 32 (23 * 32), so it survives rounding untouched.
    // The long side (width) scales by the same ratio: 400 * 736 / 300 = 981.333..., and
    // 981.333... / 32 = 30.6667, which rounds to 31 -> 992.
    const out = detResize(400, 300);
    expect(out.resizeH).toBe(736);
    expect(out.resizeW).toBe(992);
  });

  it('rounds to the NEAREST multiple of 32, not up', () => {
    // Short side 1000 >= 736, so ratio = 1 here too, isolating the rounding rule itself from
    // the upscale path. 1000 / 32 = 31.25, which rounds DOWN to 31 -> 992; ceiling would give
    // 32 -> 1024. 1500 / 32 = 46.875, which rounds UP to 47 -> 1504.
    const out = detResize(1000, 1500);
    expect(out.resizeW).toBe(992);
    expect(out.resizeH).toBe(1504);
  });

  it('never returns a dimension below one multiple of 32', () => {
    // ratio = 736 / 8 = 92. Height scales to exactly 736. Width = 10 * 92 / 32 = 28.75,
    // which rounds to 29 -> 928. Neither the shrink toward zero this guard exists for, nor
    // the floor clamp itself, is reachable through the 'min' ratio for a realistic positive
    // image, since the ratio never shrinks a dimension; this pins the floor is not silently
    // broken even so.
    const out = detResize(10, 8);
    expect(out.resizeH).toBe(736);
    expect(out.resizeW).toBe(928);
    expect(out.resizeW).toBeGreaterThanOrEqual(DET_SIZE_MULTIPLE);
    expect(out.resizeH).toBeGreaterThanOrEqual(DET_SIZE_MULTIPLE);
  });

  it('round-trips a corner back to within a pixel', () => {
    const out = detResize(1000, 1500);
    const quad: Quad = [
      { x: 0, y: 0 },
      { x: out.resizeW, y: 0 },
      { x: out.resizeW, y: out.resizeH },
      { x: 0, y: out.resizeH },
    ];
    const scaled = scaleQuad(quad, out.scaleX, out.scaleY, 1000, 1500);
    expect(Math.abs(scaled[2].x - 1000)).toBeLessThanOrEqual(1);
    expect(Math.abs(scaled[2].y - 1500)).toBeLessThanOrEqual(1);
  });
});

describe('buildDetTensor (MUST-4.8, risk R3)', () => {
  it('pins the first sixteen floats for the 4 by 4 fixture', () => {
    const image = tensor4x4();
    const tensor = buildDetTensor(image, image);
    // NCHW: the first 16 values are the whole red plane, pixels 0..15.
    const expected = Array.from({ length: 16 }, (_, i) => (i * DET_SCALE - DET_MEAN[0]) / DET_STD[0]);
    for (let i = 0; i < 16; i += 1) expect(tensor[i]).toBeCloseTo(expected[i], 6);
  });

  it('packs RGB in that order, not BGR', () => {
    const image = tensor4x4();
    const tensor = buildDetTensor(image, image);
    const plane = 16;
    expect(tensor[plane]).toBeCloseTo((1 * DET_SCALE - DET_MEAN[1]) / DET_STD[1], 6);
    expect(tensor[plane * 2]).toBeCloseTo((2 * DET_SCALE - DET_MEAN[2]) / DET_STD[2], 6);
  });

  it('is 1 * 3 * h * w long', () => {
    const image = tensor4x4();
    expect(buildDetTensor(image, image)).toHaveLength(3 * 16);
  });
});

describe('detectBoxes (MUST-4.9)', () => {
  const image: RawImage = { data: Buffer.alloc(64 * 64 * 3, 255), width: 64, height: 64 };

  it('throws when the returned spatial dimensions do not match the input', async () => {
    await expect(
      detectBoxes(image, async () => ({ data: new Float32Array(4), dims: [1, 1, 2, 2] })),
    ).rejects.toThrow(/spatial/i);
  });

  it('returns boxes in preprocessed-image coordinates', async () => {
    const resized = detResize(64, 64);
    const map = new Float32Array(resized.resizeW * resized.resizeH);
    for (let y = 8; y < 24; y += 1) {
      for (let x = 8; x < 40; x += 1) map[y * resized.resizeW + x] = 0.9;
    }
    const boxes = await detectBoxes(image, async () => ({
      data: map,
      dims: [1, 1, resized.resizeH, resized.resizeW],
    }));
    expect(boxes).toHaveLength(1);
    for (const point of boxes[0].quad) {
      expect(point.x).toBeGreaterThanOrEqual(0);
      expect(point.x).toBeLessThanOrEqual(image.width);
      expect(point.y).toBeGreaterThanOrEqual(0);
      expect(point.y).toBeLessThanOrEqual(image.height);
    }
  });
});

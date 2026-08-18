import { describe, it, expect } from 'vitest';
import { CROP_ANGLE_LIMIT_DEG } from '@/lib/warranty/ocr/onnx/constants';
import type { DetectedBox } from '@/lib/warranty/ocr/onnx/contours';
import { rectCorners } from '@/lib/warranty/ocr/onnx/contours';
import { cropBoxes, normaliseCropAngle } from '@/lib/warranty/ocr/onnx/crop';
import type { RawImage } from '@/lib/warranty/ocr/onnx/preprocess';
import { solidRgb } from '../../../../helpers/ocr-images';

function box(cx: number, cy: number, width: number, height: number, angleDeg: number): DetectedBox {
  const rect = { cx, cy, width, height, angleDeg };
  return { rect, quad: rectCorners(rect), score: 0.9 };
}

const page: RawImage = { data: solidRgb(200, 120, [255, 255, 255]), width: 200, height: 120 };

describe('normaliseCropAngle (MUST-4.19)', () => {
  it('leaves a wide rectangle alone', () => {
    expect(normaliseCropAngle({ cx: 0, cy: 0, width: 100, height: 20, angleDeg: 3 })).toEqual({
      angleDeg: 3,
      width: 100,
      height: 20,
    });
  });

  it('swaps width and height when the rectangle is taller than it is wide', () => {
    const out = normaliseCropAngle({ cx: 0, cy: 0, width: 20, height: 100, angleDeg: 80 });
    expect(out.width).toBe(100);
    expect(out.height).toBe(20);
    expect(Math.abs(out.angleDeg)).toBeLessThanOrEqual(CROP_ANGLE_LIMIT_DEG);
  });

  it('always returns an angle inside the limit', () => {
    for (const angleDeg of [-179, -91, -46, 46, 91, 179]) {
      const out = normaliseCropAngle({ cx: 0, cy: 0, width: 60, height: 12, angleDeg });
      expect(Math.abs(out.angleDeg)).toBeLessThanOrEqual(CROP_ANGLE_LIMIT_DEG);
    }
  });
});

describe('cropBoxes (MUST-4.20, MUST-4.21)', () => {
  it('carries the original box index on every crop', async () => {
    const crops = await cropBoxes(page, [box(50, 30, 60, 16, 0), box(120, 80, 70, 18, 0)]);
    expect(crops.map((crop) => crop.boxIndex)).toEqual([0, 1]);
  });

  it('skips the rotate entirely below CROP_MIN_ROTATE_DEG', async () => {
    const level = await cropBoxes(page, [box(50, 30, 60, 16, 0.2)]);
    const plain = await cropBoxes(page, [box(50, 30, 60, 16, 0)]);
    expect(level[0].width).toBe(plain[0].width);
    expect(level[0].height).toBe(plain[0].height);
  });

  it('rotates above the threshold, which changes the extracted size', async () => {
    const tilted = await cropBoxes(page, [box(100, 60, 60, 16, 10)]);
    expect(tilted).toHaveLength(1);
    expect(tilted[0].data.length).toBe(tilted[0].width * tilted[0].height * 3);
  });

  it('drops a zero-width box rather than passing it on, because a zero-width tensor is an ORT crash', async () => {
    const crops = await cropBoxes(page, [box(0, 0, 0, 0, 0), box(50, 30, 60, 16, 0)]);
    expect(crops).toHaveLength(1);
    expect(crops[0].boxIndex).toBe(1);
  });

  it('drops a box that lies entirely outside the image rather than sliding it onto the corner', async () => {
    // left = -520, top = -506, right = -480, bottom = -494: nothing overlaps the page.
    // Clamping before this check yields left 0, top 0, width 40, height 12, which is a
    // perfectly valid crop of a region the detector never pointed at.
    const crops = await cropBoxes(page, [box(-500, -500, 40, 12, 0)]);
    expect(crops).toHaveLength(0);
  });

  it('keeps a box that straddles the edge, clipped to the part that is on the page', async () => {
    // left = -10, right = 30, so 30 columns of the 40 are real.
    const crops = await cropBoxes(page, [box(10, 30, 40, 12, 0)]);
    expect(crops).toHaveLength(1);
    expect(crops[0].width).toBe(30);
    expect(crops[0].height).toBe(12);
  });
});

import { describe, it, expect, vi, afterEach } from 'vitest';
import { CLS_BATCH_SIZE, CLS_MEAN, CLS_STD, CLS_THRESH, PIXEL_SCALE } from '@/lib/warranty/ocr/onnx/constants';
import { buildClsTensor, classifyAndFlip } from '@/lib/warranty/ocr/onnx/classify';
import type { Crop } from '@/lib/warranty/ocr/onnx/crop';
import type { OnnxOcrSessions, OnnxTensorData } from '@/lib/warranty/ocr/onnx/session';
import { solidRgb } from '../../../../helpers/ocr-images';

afterEach(() => vi.restoreAllMocks());

function crop(boxIndex: number, value = 128): Crop {
  return { data: solidRgb(20, 10, [value, value, value]), width: 20, height: 10, boxIndex };
}

/** 4 by 2, every pixel a distinct grey, so a 180 degree rotation is visible in the bytes:
 *  index 0 holds 0 and index 7 holds 70, and the rotation swaps them. */
function gradientCrop(boxIndex: number): Crop {
  const width = 4;
  const height = 2;
  const data = Buffer.alloc(width * height * 3);
  for (let i = 0; i < width * height; i += 1) {
    data[i * 3] = i * 10;
    data[i * 3 + 1] = i * 10;
    data[i * 3 + 2] = i * 10;
  }
  return { data, width, height, boxIndex };
}

function sessions(runCls: (input: OnnxTensorData) => Promise<OnnxTensorData>): OnnxOcrSessions {
  return {
    runDet: async () => ({ data: new Float32Array(1), dims: [1, 1, 1, 1] }),
    runCls,
    runRec: async () => ({ data: new Float32Array(1), dims: [1, 1, 1] }),
    clsInputHeight: 80,
    clsInputWidth: 160,
    recClassCount: 3,
    dictionary: ['', 'a', ' '],
  };
}

describe('buildClsTensor (MUST-4.23)', () => {
  it('normalises with the pinned mean and std, RGB, NCHW', () => {
    const tensor = buildClsTensor([crop(0, 255)], 2, 2);
    const expected = (255 * PIXEL_SCALE - CLS_MEAN) / CLS_STD;
    expect(tensor).toHaveLength(1 * 3 * 2 * 2);
    for (const value of tensor) expect(value).toBeCloseTo(expected, 6);
  });

  it('is batchSize * 3 * h * w long', () => {
    expect(buildClsTensor([crop(0), crop(1), crop(2)], 4, 8)).toHaveLength(3 * 3 * 4 * 8);
  });
});

describe('classifyAndFlip (MUST-4.24)', () => {
  it('flips a crop whose class-1 probability is at the threshold, and the pixels prove it', async () => {
    const input = gradientCrop(0);
    expect(input.data[0]).toBe(0);
    const out = await classifyAndFlip(
      [input],
      sessions(async () => ({ data: new Float32Array([1 - CLS_THRESH, CLS_THRESH]), dims: [1, 2] })),
    );
    expect(out).toHaveLength(1);
    expect(out[0].boxIndex).toBe(0);
    // A 180 degree rotation reverses both axes, so the last pixel becomes the first. Asserting
    // only the length and the index would pass identically on the un-flipped path.
    expect(out[0].data[0]).toBe(70);
    expect(out[0].width).toBe(input.width);
    expect(out[0].height).toBe(input.height);
  });

  it('is exactly at-or-above, not strictly above, the threshold', async () => {
    const input = gradientCrop(0);
    const justUnder = await classifyAndFlip(
      [input],
      sessions(async () => ({ data: new Float32Array([1, CLS_THRESH - 0.01]), dims: [1, 2] })),
    );
    expect(justUnder[0].data).toBe(input.data);
  });

  it('leaves a crop below the threshold byte-identical', async () => {
    const input = crop(0);
    const out = await classifyAndFlip(
      [input],
      sessions(async () => ({ data: new Float32Array([0.9, 0.1]), dims: [1, 2] })),
    );
    expect(out[0].data).toBe(input.data);
  });

  it('batches CLS_BATCH_SIZE crops at a time', async () => {
    const batches: number[] = [];
    const crops = Array.from({ length: CLS_BATCH_SIZE * 2 + 1 }, (_, i) => crop(i));
    await classifyAndFlip(
      crops,
      sessions(async (input) => {
        const size = input.dims[0];
        batches.push(size);
        return { data: new Float32Array(size * 2).fill(0.1), dims: [size, 2] };
      }),
    );
    expect(batches).toEqual([CLS_BATCH_SIZE, CLS_BATCH_SIZE, 1]);
  });

  it('MUST-4.3 exception: a classifier failure logs one line and returns the crops unflipped', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const input = [crop(0), crop(1)];
    const out = await classifyAndFlip(
      input,
      sessions(async () => {
        throw new Error('kernel exploded');
      }),
    );
    expect(out).toEqual(input);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('an unexpected class count fails the batch rather than guessing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const input = [crop(0)];
    const out = await classifyAndFlip(
      input,
      sessions(async () => ({ data: new Float32Array([0.2, 0.3, 0.5]), dims: [1, 3] })),
    );
    expect(out).toEqual(input);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

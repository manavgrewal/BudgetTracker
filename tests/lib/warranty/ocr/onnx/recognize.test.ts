import { describe, it, expect } from 'vitest';
import {
  REC_BATCH_SIZE,
  REC_BLANK_INDEX,
  REC_DROP_SCORE,
  REC_INPUT_HEIGHT,
  REC_MAX_WIDTH,
  REC_MEAN,
  REC_PAD_VALUE,
  REC_STD,
  REC_WIDTH_MULTIPLE,
  PIXEL_SCALE,
} from '@/lib/warranty/ocr/onnx/constants';
import type { Crop } from '@/lib/warranty/ocr/onnx/crop';
import {
  batchWidth,
  buildRecTensor,
  ctcGreedyDecode,
  orderByAspect,
  recognizeCrops,
} from '@/lib/warranty/ocr/onnx/recognize';
import type { OnnxOcrSessions, OnnxTensorData } from '@/lib/warranty/ocr/onnx/session';
import { solidRgb } from '../../../../helpers/ocr-images';

const DICT = ['', 'A', 'B', ' '];

function crop(boxIndex: number, width: number, height = REC_INPUT_HEIGHT, value = 128): Crop {
  return { data: solidRgb(width, height, [value, value, value]), width, height, boxIndex };
}

/** One [T, C] row laid out flat, from a list of (classIndex, probability) pairs. */
function row(steps: [number, number][], classCount = DICT.length): Float32Array {
  const out = new Float32Array(steps.length * classCount);
  steps.forEach(([index, probability], t) => {
    out[t * classCount + index] = probability;
  });
  return out;
}

function sessions(runRec: (input: OnnxTensorData) => Promise<OnnxTensorData>): OnnxOcrSessions {
  return {
    runDet: async () => ({ data: new Float32Array(1), dims: [1, 1, 1, 1] }),
    runCls: async () => ({ data: new Float32Array(2), dims: [1, 2] }),
    runRec,
    clsInputHeight: 80,
    clsInputWidth: 160,
    recClassCount: DICT.length,
    dictionary: DICT,
  };
}

describe('ctcGreedyDecode (MUST-4.31)', () => {
  it('collapses repeats but keeps a genuine double separated by a blank', () => {
    const steps: [number, number][] = [
      [REC_BLANK_INDEX, 0.9],
      [1, 0.9],
      [1, 0.9],
      [REC_BLANK_INDEX, 0.9],
      [1, 0.9],
    ];
    const result = ctcGreedyDecode(row(steps), steps.length, DICT.length, DICT);
    expect(result.text).toBe('AA');
  });

  it('decodes an all-blank row to the empty string', () => {
    const steps: [number, number][] = [
      [REC_BLANK_INDEX, 1],
      [REC_BLANK_INDEX, 1],
    ];
    expect(ctcGreedyDecode(row(steps), steps.length, DICT.length, DICT)).toEqual({ text: '', score: 0 });
  });

  it('scores the mean of the KEPT timesteps only', () => {
    const steps: [number, number][] = [
      [REC_BLANK_INDEX, 0.1],
      [1, 0.8],
      [2, 0.6],
    ];
    const result = ctcGreedyDecode(row(steps), steps.length, DICT.length, DICT);
    expect(result.text).toBe('AB');
    expect(result.score).toBeCloseTo((0.8 + 0.6) / 2, 6);
  });
});

describe('batching (MUST-4.26, MUST-4.27)', () => {
  it('orders by aspect ratio ascending', () => {
    const crops = [crop(0, 480), crop(1, 96), crop(2, 240)];
    expect(orderByAspect(crops).map((c) => c.boxIndex)).toEqual([1, 2, 0]);
  });

  it('rounds the batch width up to a multiple of REC_WIDTH_MULTIPLE', () => {
    const width = batchWidth([crop(0, 101)]);
    expect(width % REC_WIDTH_MULTIPLE).toBe(0);
  });

  it('never returns a width below the base and never above the cap', () => {
    expect(batchWidth([crop(0, 4)])).toBeGreaterThanOrEqual(320);
    expect(batchWidth([crop(0, 100_000)])).toBe(REC_MAX_WIDTH);
  });
});

describe('buildRecTensor (MUST-4.28, MUST-4.29, risk R3)', () => {
  it('pads in normalised space with REC_PAD_VALUE, not with black', () => {
    const width = 64;
    const tensor = buildRecTensor([crop(0, 8, REC_INPUT_HEIGHT, 255)], width);
    const plane = REC_INPUT_HEIGHT * width;
    // Column 8 onward is padding on the first row of the red plane.
    expect(tensor[8]).toBe(REC_PAD_VALUE);
    expect(tensor[width - 1]).toBe(REC_PAD_VALUE);
    expect(tensor[0]).toBeCloseTo((255 * PIXEL_SCALE - REC_MEAN) / REC_STD, 6);
    expect(tensor).toHaveLength(3 * plane);
  });
});

describe('recognizeCrops (MUST-4.30, MUST-4.32)', () => {
  it('restores detection order after aspect-ratio batching', async () => {
    const crops = [crop(0, 480), crop(1, 96), crop(2, 240)];
    const out = await recognizeCrops(
      crops,
      sessions(async (input) => {
        const batch = input.dims[0];
        const timesteps = 2;
        const data = new Float32Array(batch * timesteps * DICT.length);
        for (let n = 0; n < batch; n += 1) {
          data[n * timesteps * DICT.length + 1] = 0.9;
          data[n * timesteps * DICT.length + DICT.length + REC_BLANK_INDEX] = 0.9;
        }
        return { data, dims: [batch, timesteps, DICT.length] };
      }),
    );
    expect(out.map((line) => line.boxIndex)).toEqual([0, 1, 2]);
  });

  it('drops a line scoring below REC_DROP_SCORE and keeps one above it', async () => {
    const probabilities = [REC_DROP_SCORE - 0.01, REC_DROP_SCORE + 0.01];
    const out = await recognizeCrops(
      [crop(0, 96), crop(1, 96)],
      sessions(async (input) => {
        const batch = input.dims[0];
        const data = new Float32Array(batch * DICT.length);
        for (let n = 0; n < batch; n += 1) data[n * DICT.length + 1] = probabilities[n];
        return { data, dims: [batch, 1, DICT.length] };
      }),
    );
    expect(out).toHaveLength(1);
    expect(out[0].boxIndex).toBe(1);
  });

  it('drops a line that trims to nothing', async () => {
    const out = await recognizeCrops(
      [crop(0, 96)],
      sessions(async () => ({ data: new Float32Array([0, 0, 0, 0.99]), dims: [1, 1, DICT.length] })),
    );
    expect(out).toHaveLength(0);
  });

  it('throws when the class count disagrees with the dictionary', async () => {
    await expect(
      recognizeCrops(
        [crop(0, 96)],
        sessions(async () => ({ data: new Float32Array(9), dims: [1, 1, 9] })),
      ),
    ).rejects.toThrow(/class/i);
  });

  it('yields to the event loop between batches (MUST-4.39)', async () => {
    let ticks = 0;
    const stopper = setInterval(() => {
      ticks += 1;
    }, 0);
    const crops = Array.from({ length: REC_BATCH_SIZE * 3 }, (_, i) => crop(i, 96));
    await recognizeCrops(
      crops,
      sessions(async (input) => {
        const batch = input.dims[0];
        const data = new Float32Array(batch * DICT.length);
        for (let n = 0; n < batch; n += 1) data[n * DICT.length + 1] = 0.9;
        return { data, dims: [batch, 1, DICT.length] };
      }),
    );
    clearInterval(stopper);
    expect(ticks).toBeGreaterThan(0);
  });
});

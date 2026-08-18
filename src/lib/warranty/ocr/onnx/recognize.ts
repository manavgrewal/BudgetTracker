import sharp from 'sharp';
import {
  PIXEL_SCALE,
  REC_BASE_WIDTH,
  REC_BATCH_SIZE,
  REC_BLANK_INDEX,
  REC_DROP_SCORE,
  REC_INPUT_HEIGHT,
  REC_MAX_WIDTH,
  REC_MEAN,
  REC_PAD_VALUE,
  REC_STD,
  REC_WIDTH_MULTIPLE,
} from '@/lib/warranty/ocr/onnx/constants';
import type { Crop } from '@/lib/warranty/ocr/onnx/crop';
import type { OnnxOcrSessions } from '@/lib/warranty/ocr/onnx/session';

export interface RecognizedLine {
  boxIndex: number;
  text: string;
  score: number;
}

const aspect = (crop: Crop) => crop.width / crop.height;

/** Sorting first means each batch's crops need similar padding, which is where the batching
 *  win comes from. The original index rides along on the crop. */
export function orderByAspect(crops: readonly Crop[]): Crop[] {
  return [...crops].sort((a, b) => aspect(a) - aspect(b));
}

export function batchWidth(crops: readonly Crop[]): number {
  const maxRatio = crops.reduce((best, crop) => Math.max(best, aspect(crop)), REC_BASE_WIDTH / REC_INPUT_HEIGHT);
  const raw = Math.min(Math.ceil(REC_INPUT_HEIGHT * maxRatio), REC_MAX_WIDTH);
  const snapped = Math.ceil(raw / REC_WIDTH_MULTIPLE) * REC_WIDTH_MULTIPLE;
  return Math.min(snapped, REC_MAX_WIDTH);
}

/**
 * REC_PAD_VALUE is applied in NORMALISED space, not pixel space. 0 after
 * (pixel / 255 - 0.5) / 0.5 is mid-grey, which is what PaddleOCR pads with. Padding with
 * normalised -1 (black) puts a black bar after every short line and the CTC head reads
 * characters into it.
 */
export function buildRecTensor(crops: readonly Crop[], width: number): Float32Array {
  const plane = REC_INPUT_HEIGHT * width;
  const tensor = new Float32Array(crops.length * 3 * plane).fill(REC_PAD_VALUE);
  for (let n = 0; n < crops.length; n += 1) {
    const crop = crops[n];
    const base = n * 3 * plane;
    const cols = Math.min(width, crop.width);
    for (let y = 0; y < Math.min(REC_INPUT_HEIGHT, crop.height); y += 1) {
      for (let x = 0; x < cols; x += 1) {
        const source = (y * crop.width + x) * 3;
        for (let c = 0; c < 3; c += 1) {
          tensor[base + c * plane + y * width + x] = (crop.data[source + c] * PIXEL_SCALE - REC_MEAN) / REC_STD;
        }
      }
    }
  }
  return tensor;
}

/**
 * PP-OCR recognition heads emit post-softmax probabilities, so no softmax is applied here.
 * Repeat collapsing comes AFTER blank skipping is decided per timestep, because the blank
 * between two genuine repeated characters is what separates them.
 */
export function ctcGreedyDecode(
  rowData: Float32Array,
  timesteps: number,
  classCount: number,
  dictionary: readonly string[],
): { text: string; score: number } {
  let text = '';
  let sum = 0;
  let kept = 0;
  let previous = -1;
  for (let t = 0; t < timesteps; t += 1) {
    let best = 0;
    let bestValue = -Infinity;
    for (let c = 0; c < classCount; c += 1) {
      const value = rowData[t * classCount + c];
      if (value > bestValue) {
        bestValue = value;
        best = c;
      }
    }
    if (best === REC_BLANK_INDEX) {
      previous = best;
      continue;
    }
    if (best === previous) continue;
    previous = best;
    text += dictionary[best] ?? '';
    sum += bestValue;
    kept += 1;
  }
  return { text, score: kept === 0 ? 0 : sum / kept };
}

async function fitCrop(crop: Crop, width: number): Promise<Crop> {
  const target = Math.max(1, Math.min(width, Math.ceil(REC_INPUT_HEIGHT * aspect(crop))));
  const { data } = await sharp(crop.data, { raw: { width: crop.width, height: crop.height, channels: 3 } })
    .resize({ width: target, height: REC_INPUT_HEIGHT, fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: target, height: REC_INPUT_HEIGHT, boxIndex: crop.boxIndex };
}

export async function recognizeCrops(
  crops: readonly Crop[],
  sessions: OnnxOcrSessions,
): Promise<RecognizedLine[]> {
  if (crops.length === 0) return [];
  const ordered = orderByAspect(crops);
  const lines: RecognizedLine[] = [];
  for (let start = 0; start < ordered.length; start += REC_BATCH_SIZE) {
    const batch = ordered.slice(start, start + REC_BATCH_SIZE);
    const width = batchWidth(batch);
    const fitted = await Promise.all(batch.map((crop) => fitCrop(crop, width)));
    const output = await sessions.runRec({
      data: buildRecTensor(fitted, width),
      dims: [batch.length, 3, REC_INPUT_HEIGHT, width],
    });
    const timesteps = output.dims[1];
    const classCount = output.dims[2];
    if (classCount !== sessions.recClassCount) {
      throw new Error(
        `Recognition output declares ${classCount} classes but the dictionary holds ${sessions.recClassCount}.`,
      );
    }
    for (let n = 0; n < batch.length; n += 1) {
      const offset = n * timesteps * classCount;
      const { text, score } = ctcGreedyDecode(
        output.data.subarray(offset, offset + timesteps * classCount),
        timesteps,
        classCount,
        sessions.dictionary,
      );
      const trimmed = text.trim();
      // The previous engine's failure mode was not silence, it was confident nonsense. A
      // confidence floor is the only mechanical defence, and it is what keeps the FTS5
      // index clean.
      if (trimmed.length === 0 || score < REC_DROP_SCORE) continue;
      lines.push({ boxIndex: batch[n].boxIndex, text: trimmed, score });
    }
    // 200 boxes is 34 batches with 34 yield points rather than one uninterruptible stretch.
    // session.run itself is off-thread on libuv; this pipeline's own JavaScript is not.
    await new Promise((resolve) => setImmediate(resolve));
  }
  return lines.sort((a, b) => a.boxIndex - b.boxIndex);
}

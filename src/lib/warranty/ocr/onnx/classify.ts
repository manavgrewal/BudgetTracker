import sharp from 'sharp';
import {
  CLS_BATCH_SIZE,
  CLS_FLIP_DEGREES,
  CLS_MEAN,
  CLS_PAD_VALUE,
  CLS_STD,
  CLS_THRESH,
  PIXEL_SCALE,
} from '@/lib/warranty/ocr/onnx/constants';
import type { Crop } from '@/lib/warranty/ocr/onnx/crop';
import type { OnnxOcrSessions } from '@/lib/warranty/ocr/onnx/session';

/** Aspect preserved, right-padded with CLS_PAD_VALUE in normalised space. */
export async function resizeCropForCls(crop: Crop, height: number, width: number): Promise<Crop> {
  const scaled = Math.max(1, Math.min(width, Math.round((crop.width / crop.height) * height)));
  const { data } = await sharp(crop.data, { raw: { width: crop.width, height: crop.height, channels: 3 } })
    .resize({ width: scaled, height, fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: scaled, height, boxIndex: crop.boxIndex };
}

export function buildClsTensor(crops: readonly Crop[], height: number, width: number): Float32Array {
  const plane = height * width;
  const tensor = new Float32Array(crops.length * 3 * plane).fill(CLS_PAD_VALUE);
  for (let n = 0; n < crops.length; n += 1) {
    const crop = crops[n];
    const base = n * 3 * plane;
    for (let y = 0; y < Math.min(height, crop.height); y += 1) {
      for (let x = 0; x < Math.min(width, crop.width); x += 1) {
        const source = (y * crop.width + x) * 3;
        for (let c = 0; c < 3; c += 1) {
          tensor[base + c * plane + y * width + x] = (crop.data[source + c] * PIXEL_SCALE - CLS_MEAN) / CLS_STD;
        }
      }
    }
  }
  return tensor;
}

async function flip(crop: Crop): Promise<Crop> {
  const { data, info } = await sharp(crop.data, { raw: { width: crop.width, height: crop.height, channels: 3 } })
    .rotate(CLS_FLIP_DEGREES)
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, boxIndex: crop.boxIndex };
}

/**
 * MUST-4.3's one exception to "no stage swallows an error": a wrong-way-up guess is worse
 * than no guess, but a crashed classifier should not cost the whole receipt.
 */
export async function classifyAndFlip(crops: readonly Crop[], sessions: OnnxOcrSessions): Promise<Crop[]> {
  if (crops.length === 0) return [];
  try {
    const out: Crop[] = [];
    for (let start = 0; start < crops.length; start += CLS_BATCH_SIZE) {
      const batch = crops.slice(start, start + CLS_BATCH_SIZE);
      const resized = await Promise.all(
        batch.map((crop) => resizeCropForCls(crop, sessions.clsInputHeight, sessions.clsInputWidth)),
      );
      const output = await sessions.runCls({
        data: buildClsTensor(resized, sessions.clsInputHeight, sessions.clsInputWidth),
        dims: [batch.length, 3, sessions.clsInputHeight, sessions.clsInputWidth],
      });
      const classes = output.dims[output.dims.length - 1];
      if (classes !== 2) throw new Error(`orientation output has ${classes} classes, expected 2`);
      // output.data is a Float32Array, so it holds CLS_THRESH's nearest float32 value, not the
      // JS double 0.9 itself. Comparing against the double directly rounds a genuinely
      // at-threshold model output down and misses it; Math.fround puts both sides through the
      // same rounding before the comparison.
      const flipThreshold = Math.fround(CLS_THRESH);
      for (let i = 0; i < batch.length; i += 1) {
        // Class index 1 means CLS_FLIP_DEGREES.
        out.push(output.data[i * 2 + 1] >= flipThreshold ? await flip(batch[i]) : batch[i]);
      }
    }
    return out;
  } catch (error) {
    console.warn('[ocr] orientation classifier failed, continuing with unflipped crops', error);
    return [...crops];
  }
}

import sharp from 'sharp';
import { CROP_ANGLE_LIMIT_DEG, CROP_MIN_ROTATE_DEG } from '@/lib/warranty/ocr/onnx/constants';
import type { DetectedBox, RotatedRect } from '@/lib/warranty/ocr/onnx/contours';
import type { RawImage } from '@/lib/warranty/ocr/onnx/preprocess';

export interface Crop extends RawImage {
  /** Index into the DetectedBox[] this crop came from. Carried through every later stage. */
  boxIndex: number;
}

/** A text line is wider than it is tall, but a min-area rectangle can report the same shape
 *  either way round, so an angle outside the limit means the two axes are swapped. */
export function normaliseCropAngle(rect: RotatedRect): { angleDeg: number; width: number; height: number } {
  let angleDeg = rect.angleDeg;
  let width = rect.width;
  let height = rect.height;
  while (angleDeg > CROP_ANGLE_LIMIT_DEG) {
    angleDeg -= 2 * CROP_ANGLE_LIMIT_DEG;
    [width, height] = [height, width];
  }
  while (angleDeg < -CROP_ANGLE_LIMIT_DEG) {
    angleDeg += 2 * CROP_ANGLE_LIMIT_DEG;
    [width, height] = [height, width];
  }
  if (height > width) {
    [width, height] = [height, width];
    angleDeg = angleDeg > 0 ? angleDeg - CROP_ANGLE_LIMIT_DEG * 2 : angleDeg + CROP_ANGLE_LIMIT_DEG * 2;
    if (angleDeg > CROP_ANGLE_LIMIT_DEG) angleDeg -= 2 * CROP_ANGLE_LIMIT_DEG;
    if (angleDeg < -CROP_ANGLE_LIMIT_DEG) angleDeg += 2 * CROP_ANGLE_LIMIT_DEG;
  }
  return { angleDeg, width, height };
}

function extractWindow(
  imageWidth: number,
  imageHeight: number,
  cx: number,
  cy: number,
  width: number,
  height: number,
): { left: number; top: number; width: number; height: number } | null {
  const left = Math.round(cx - width / 2);
  const top = Math.round(cy - height / 2);
  const right = left + Math.round(width);
  const bottom = top + Math.round(height);
  // A box that does not intersect the image at all is dropped BEFORE clamping. Clamping it
  // first would slide it onto the nearest corner and hand the recogniser a strip of margin
  // as if it were a line of text, which is a silent wrong answer rather than a crash.
  if (right <= 0 || bottom <= 0 || left >= imageWidth || top >= imageHeight) return null;
  const clampedLeft = Math.max(0, Math.min(imageWidth - 1, left));
  const clampedTop = Math.max(0, Math.min(imageHeight - 1, top));
  const clampedWidth = Math.min(right, imageWidth) - clampedLeft;
  const clampedHeight = Math.min(bottom, imageHeight) - clampedTop;
  // A crop whose width or height comes out as zero after clamping is dropped, not passed
  // on: a zero-width tensor is an ORT crash, not an exception.
  if (clampedWidth <= 0 || clampedHeight <= 0) return null;
  return { left: clampedLeft, top: clampedTop, width: clampedWidth, height: clampedHeight };
}

export async function cropBoxes(image: RawImage, boxes: readonly DetectedBox[]): Promise<Crop[]> {
  const raw = { width: image.width, height: image.height, channels: 3 as const };
  const crops: Crop[] = [];
  for (let boxIndex = 0; boxIndex < boxes.length; boxIndex += 1) {
    const { angleDeg, width, height } = normaliseCropAngle(boxes[boxIndex].rect);
    if (width <= 0 || height <= 0) continue;
    const rotate = Math.abs(angleDeg) >= CROP_MIN_ROTATE_DEG;
    // Most boxes after the deskew stage are within a fraction of a degree of level, and
    // skipping a no-op resample on 60 crops is the cheapest performance decision here.
    const source = rotate
      ? await sharp(image.data, { raw }).rotate(-angleDeg, { background: '#ffffff' }).raw().toBuffer({ resolveWithObject: true })
      : { data: image.data, info: { width: image.width, height: image.height } };
    const window = extractWindow(
      source.info.width,
      source.info.height,
      boxes[boxIndex].rect.cx + (source.info.width - image.width) / 2,
      boxes[boxIndex].rect.cy + (source.info.height - image.height) / 2,
      width,
      height,
    );
    if (window === null) continue;
    const { data, info } = await sharp(source.data, {
      raw: { width: source.info.width, height: source.info.height, channels: 3 },
    })
      .extract(window)
      .raw()
      .toBuffer({ resolveWithObject: true });
    crops.push({ data, width: info.width, height: info.height, boxIndex });
  }
  return crops;
}

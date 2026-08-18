import sharp from 'sharp';
import {
  DET_LIMIT_SIDE_LEN,
  DET_MEAN,
  DET_SCALE,
  DET_SIZE_MULTIPLE,
  DET_STD,
} from '@/lib/warranty/ocr/onnx/constants';
import { boxesFromProbMap, type DetectedBox, type Point, type Quad } from '@/lib/warranty/ocr/onnx/contours';
import type { RawImage } from '@/lib/warranty/ocr/onnx/preprocess';
import type { TensorRun } from '@/lib/warranty/ocr/onnx/session';

export interface DetResize {
  resizeW: number;
  resizeH: number;
  scaleX: number;
  scaleY: number;
}

/**
 * PaddleOCR's and RapidOCR's DetResizeForTest with limit_type = DET_LIMIT_TYPE = 'min'. When
 * the shorter side is below the floor, both dimensions scale up by the same ratio so the
 * shorter one lands exactly on the floor; a large image is left alone. There is no upper
 * bound of its own here, because preprocess.ts already caps the long side before this runs.
 * Round to NEAREST, not ceiling: PaddleOCR rounds, and using ceiling here shifts every box by
 * up to 31 pixels relative to the reference implementation.
 */
export function detResize(width: number, height: number): DetResize {
  const shortSide = Math.min(width, height);
  const ratio = shortSide < DET_LIMIT_SIDE_LEN ? DET_LIMIT_SIDE_LEN / shortSide : 1;
  const snap = (value: number) =>
    Math.max(Math.round((value * ratio) / DET_SIZE_MULTIPLE) * DET_SIZE_MULTIPLE, DET_SIZE_MULTIPLE);
  const resizeW = snap(width);
  const resizeH = snap(height);
  return { resizeW, resizeH, scaleX: width / resizeW, scaleY: height / resizeH };
}

/** float32, NCHW, RGB, value = (pixel * DET_SCALE - mean) / std. The `image` argument is
 *  present so the signature reads the same as the other tensor builders; the bytes come
 *  from `resized`. */
export function buildDetTensor(image: RawImage, resized: RawImage): Float32Array {
  void image;
  const plane = resized.width * resized.height;
  const tensor = new Float32Array(plane * 3);
  for (let i = 0; i < plane; i += 1) {
    for (let c = 0; c < 3; c += 1) {
      tensor[c * plane + i] = (resized.data[i * 3 + c] * DET_SCALE - DET_MEAN[c]) / DET_STD[c];
    }
  }
  return tensor;
}

export function scaleQuad(quad: Quad, scaleX: number, scaleY: number, width: number, height: number): Quad {
  const clamp = (point: Point): Point => ({
    x: Math.min(Math.max(point.x * scaleX, 0), width),
    y: Math.min(Math.max(point.y * scaleY, 0), height),
  });
  return [clamp(quad[0]), clamp(quad[1]), clamp(quad[2]), clamp(quad[3])] as const;
}

export async function detectBoxes(image: RawImage, runDet: TensorRun): Promise<DetectedBox[]> {
  const geometry = detResize(image.width, image.height);
  const { data } = await sharp(image.data, { raw: { width: image.width, height: image.height, channels: 3 } })
    .resize({ width: geometry.resizeW, height: geometry.resizeH, fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const resized: RawImage = { data, width: geometry.resizeW, height: geometry.resizeH };
  const output = await runDet({
    data: buildDetTensor(image, resized),
    dims: [1, 3, geometry.resizeH, geometry.resizeW],
  });
  // Read the shape from the returned tensor rather than assuming it.
  const dims = output.dims;
  const outH = dims[dims.length - 2];
  const outW = dims[dims.length - 1];
  if (outH !== geometry.resizeH || outW !== geometry.resizeW) {
    throw new Error(
      `Detection output spatial dimensions ${outH}x${outW} do not match the input ${geometry.resizeH}x${geometry.resizeW}.`,
    );
  }
  return boxesFromProbMap(output.data, outW, outH).map((box) => ({
    ...box,
    quad: scaleQuad(box.quad, geometry.scaleX, geometry.scaleY, image.width, image.height),
    rect: {
      ...box.rect,
      cx: box.rect.cx * geometry.scaleX,
      cy: box.rect.cy * geometry.scaleY,
      width: box.rect.width * geometry.scaleX,
      height: box.rect.height * geometry.scaleY,
    },
  }));
}

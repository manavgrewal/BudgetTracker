import sharp from 'sharp';
import {
  DESKEW_BACKGROUND,
  DESKEW_MIN_APPLY_DEG,
  DESKEW_PROFILE_LONG_SIDE_PX,
  DESKEW_SEARCH_MAX_DEG,
  DESKEW_SEARCH_STEP_DEG,
  NORMALISE_LOWER_PERCENTILE,
  NORMALISE_UPPER_PERCENTILE,
  PREPROCESS_MAX_INPUT_PIXELS,
  PREPROCESS_MAX_LONG_SIDE_PX,
  PREPROCESS_MAX_UPSCALE,
  PREPROCESS_MIN_LONG_SIDE_PX,
} from '@/lib/warranty/ocr/onnx/constants';

/** Raw RGB, 3 channels, 8 bits per channel, no alpha. */
export interface RawImage {
  data: Buffer;
  width: number;
  height: number;
}

export function otsuThreshold(grey: Uint8Array): number {
  const histogram = new Float64Array(256);
  for (const value of grey) histogram[value] += 1;
  const total = grey.length;
  let sum = 0;
  for (let i = 0; i < 256; i += 1) sum += i * histogram[i];
  let sumBackground = 0;
  let weightBackground = 0;
  let best = 0;
  let bestVariance = -1;
  for (let t = 0; t < 256; t += 1) {
    weightBackground += histogram[t];
    if (weightBackground === 0) continue;
    const weightForeground = total - weightBackground;
    if (weightForeground === 0) break;
    sumBackground += t * histogram[t];
    const meanBackground = sumBackground / weightBackground;
    const meanForeground = (sum - sumBackground) / weightForeground;
    const between = weightBackground * weightForeground * (meanBackground - meanForeground) ** 2;
    if (between > bestVariance) {
      bestVariance = between;
      best = t;
    }
  }
  return best;
}

/**
 * Skew is estimated by a horizontal projection profile search, not a Hough transform and
 * not a second detection pass: rotate the binary copy, sum dark pixels per row, and score
 * the angle as the VARIANCE of that row-sum vector. Horizontal text lines produce sharp
 * peaks and troughs, so the variance is maximal when the lines are level.
 */
export function bestSkewAngleDeg(binary: Uint8Array, width: number, height: number): number {
  const centreX = (width - 1) / 2;
  const centreY = (height - 1) / 2;

  /**
   * `skewDeg` is the SKEW OF THE CONTENT, positive meaning the text runs down to the right.
   * Levelling it means rotating by -skewDeg, which is exactly what the caller does, so the
   * profile is measured under that same -skewDeg rotation. Getting this sign backwards
   * produces a deskew that doubles the tilt instead of removing it, and the fixture at 4
   * degrees is what catches it.
   */
  function profileVariance(skewDeg: number): number {
    const radians = (-skewDeg * Math.PI) / 180;
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);
    const rows = new Float64Array(height);
    for (let y = 0; y < height; y += 1) {
      const dy = y - centreY;
      for (let x = 0; x < width; x += 1) {
        if (binary[y * width + x] === 0) continue;
        const dx = x - centreX;
        // Nearest-neighbour destination row for this source pixel under the rotation.
        const ry = Math.round(centreY + dx * sin + dy * cos);
        if (ry >= 0 && ry < height) rows[ry] += 1;
      }
    }
    let mean = 0;
    for (const value of rows) mean += value;
    mean /= height;
    let variance = 0;
    for (const value of rows) variance += (value - mean) ** 2;
    return variance;
  }

  // Seeded at 0 and replaced only on a STRICTLY greater score, so a degenerate input (a
  // blank page, a solid colour, anything whose row sums do not change with angle) returns 0
  // rather than whichever candidate the loop happened to try first. Seeding with -1 and
  // starting the sweep at -10 returns -10 on every uniform image, and the pipeline then
  // rotates a perfectly level receipt by ten degrees.
  let bestAngle = 0;
  let bestScore = profileVariance(0);
  for (let angle = -DESKEW_SEARCH_MAX_DEG; angle <= DESKEW_SEARCH_MAX_DEG; angle += DESKEW_SEARCH_STEP_DEG) {
    const candidate = Math.round(angle / DESKEW_SEARCH_STEP_DEG) * DESKEW_SEARCH_STEP_DEG;
    if (candidate === 0) continue;
    const variance = profileVariance(candidate);
    if (variance > bestScore) {
      bestScore = variance;
      bestAngle = candidate;
    }
  }
  return bestAngle;
}

/** Runs on a downsampled copy and never on the full image. */
export async function estimateSkewDeg(source: string | Buffer): Promise<number> {
  const { data, info } = await sharp(source)
    .rotate()
    .flatten({ background: DESKEW_BACKGROUND })
    .greyscale()
    .resize({
      width: DESKEW_PROFILE_LONG_SIDE_PX,
      height: DESKEW_PROFILE_LONG_SIDE_PX,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .raw()
    .toBuffer({ resolveWithObject: true });
  // .greyscale() gives one channel, but read the stride from the result rather than assuming
  // it: a future pipeline change that adds a channel would otherwise measure the skew of
  // every third byte.
  const stride = info.channels;
  const grey = new Uint8Array(info.width * info.height);
  for (let i = 0; i < grey.length; i += 1) grey[i] = data[i * stride];
  const threshold = otsuThreshold(grey);
  const binary = new Uint8Array(grey.length);
  for (let i = 0; i < grey.length; i += 1) binary[i] = grey[i] <= threshold ? 1 : 0;
  return bestSkewAngleDeg(binary, info.width, info.height);
}

function resizeTarget(width: number, height: number): { width: number; height: number } | null {
  const longSide = Math.max(width, height);
  if (longSide > PREPROCESS_MAX_LONG_SIDE_PX) {
    return { width: PREPROCESS_MAX_LONG_SIDE_PX, height: PREPROCESS_MAX_LONG_SIDE_PX };
  }
  if (longSide < PREPROCESS_MIN_LONG_SIDE_PX) {
    const factor = Math.min(PREPROCESS_MIN_LONG_SIDE_PX / longSide, PREPROCESS_MAX_UPSCALE);
    const target = Math.round(longSide * factor);
    return { width: target, height: target };
  }
  return null;
}

export async function preprocessReceipt(filePath: string): Promise<RawImage> {
  const base = sharp(filePath, { limitInputPixels: PREPROCESS_MAX_INPUT_PIXELS, failOn: 'error' })
    // No argument: applies the EXIF orientation tag and then strips it. A phone photo taken
    // in portrait is stored landscape with an orientation tag, and skipping this reads every
    // such receipt sideways.
    .rotate()
    .flatten({ background: '#ffffff' })
    .greyscale()
    // Percentile-bounded rather than absolute min and max, so one specular highlight from a
    // kitchen light does not anchor the stretch and flatten the rest of the receipt.
    .normalise({ lower: NORMALISE_LOWER_PERCENTILE, upper: NORMALISE_UPPER_PERCENTILE });

  const metadata = await sharp(filePath, { limitInputPixels: PREPROCESS_MAX_INPUT_PIXELS }).metadata();
  const rotated = metadata.orientation !== undefined && metadata.orientation >= 5;
  const width = (rotated ? metadata.height : metadata.width) ?? 0;
  const height = (rotated ? metadata.width : metadata.height) ?? 0;
  const target = resizeTarget(width, height);
  const sized = target === null ? base : base.resize({ ...target, fit: 'inside', kernel: 'lanczos3' });

  const staged = await sized.png().toBuffer();
  const angle = await estimateSkewDeg(staged);
  // Below the threshold the resample costs more than it gains, and skipping it is what the
  // no-op assertion in preprocess.test.ts proves.
  const deskewed =
    Math.abs(angle) < DESKEW_MIN_APPLY_DEG ? sharp(staged) : sharp(staged).rotate(-angle, { background: DESKEW_BACKGROUND });

  const { data, info } = await deskewed
    // Three identical channels. The models take 3; feeding them a greyscale-derived
    // 3-channel image is deliberate, because a colour cast on a thermal receipt carries no
    // signal and costs contrast.
    .toColourspace('srgb')
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

export interface ProbMap {
  data: Float32Array;
  width: number;
  height: number;
}

function blank(width: number, height: number): ProbMap {
  return { data: new Float32Array(width * height), width, height };
}

function fillRect(map: ProbMap, x0: number, y0: number, x1: number, y1: number, value: number): void {
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) map.data[y * map.width + x] = value;
  }
}

/** Two clean, well separated blobs. */
export function twoBoxMap(): ProbMap {
  const map = blank(40, 20);
  fillRect(map, 2, 3, 15, 8, 0.9);
  fillRect(map, 22, 11, 37, 16, 0.85);
  return map;
}

/** One blob split by a single background column, which the 2 by 2 dilation must close. */
export function oneGapMap(): ProbMap {
  const map = blank(40, 20);
  fillRect(map, 2, 4, 18, 9, 0.9);
  fillRect(map, 20, 4, 36, 9, 0.9);
  return map;
}

/**
 * Isolated single pixel components on a 100 by 100 grid, 3 pixels apart so the 2 by 2
 * dilation cannot merge them. `y` and `x` each take 34 values (0, 3, ... 99), so this is
 * 34 * 34 = 1156 components, comfortably past DET_MAX_CANDIDATES (1000), which is the only
 * thing it is for. The guard is an exact count so a grid change cannot silently make the
 * DET_MAX_CANDIDATES assertion vacuous.
 */
export const NOISE_MAP_COMPONENTS = 1156;

export function noiseMap(): ProbMap {
  const map = blank(100, 100);
  let placed = 0;
  for (let y = 0; y < 100; y += 3) {
    for (let x = 0; x < 100; x += 3) {
      map.data[y * 100 + x] = 0.95;
      placed += 1;
    }
  }
  if (placed !== NOISE_MAP_COMPONENTS) {
    throw new Error(`noiseMap placed ${placed} components, expected ${NOISE_MAP_COMPONENTS}`);
  }
  return map;
}

/**
 * 231 blocks of 5 by 5, spaced 7 apart so the dilation to 6 by 6 leaves a one pixel gap and
 * nothing merges. Every block survives DET_MIN_BOX_SIDE_PX (its rectangle is 5 by 5) and
 * DET_BOX_THRESH (score = v * 25 / 36, and the weakest v is 0.75, giving 0.5208), so all 231
 * reach the DET_MAX_BOXES cap. Values rise with the index so the cap's sort and slice has
 * something to order.
 */
export const MANY_BOXES_COUNT = 231;
export const MANY_BOXES_MIN_VALUE = 0.75;
export const MANY_BOXES_VALUE_STEP = 0.0008;
/** A 5 by 5 block dilates to 6 by 6, and boxScoreFast measures the dilated bounding box
 *  against the undilated map: 25 filled cells out of 36. */
export const MANY_BOXES_SCORE_RATIO = 25 / 36;

export function manyBoxesMap(): ProbMap {
  const map = blank(150, 80);
  let index = 0;
  for (let row = 0; row < 11; row += 1) {
    for (let col = 0; col < 21; col += 1) {
      const value = MANY_BOXES_MIN_VALUE + index * MANY_BOXES_VALUE_STEP;
      const x0 = col * 7 + 1;
      const y0 = row * 7 + 1;
      fillRect(map, x0, y0, x0 + 4, y0 + 4, value);
      index += 1;
    }
  }
  if (index !== MANY_BOXES_COUNT) throw new Error(`manyBoxesMap placed ${index} blocks`);
  return map;
}

import {
  DET_BINARY_THRESH,
  DET_BOX_THRESH,
  DET_DILATION_KERNEL,
  DET_MAX_BOXES,
  DET_MAX_CANDIDATES,
  DET_MIN_BOX_SIDE_PX,
  DET_UNCLIP_RATIO,
  DET_USE_DILATION,
} from '@/lib/warranty/ocr/onnx/constants';

/**
 * PURE. Takes a probability map and two integers, returns boxes. No node builtin, no sharp,
 * no onnxruntime, no database. That is what makes the whole DBNet post-process testable
 * without a model file, and it is where the bugs in this release would otherwise hide.
 */

export interface Point {
  x: number;
  y: number;
}
export type Quad = readonly [Point, Point, Point, Point];
export interface RotatedRect {
  cx: number;
  cy: number;
  width: number;
  height: number;
  angleDeg: number;
}
export interface DetectedBox {
  quad: Quad;
  rect: RotatedRect;
  score: number;
}

export function binarize(probMap: Float32Array, threshold: number): Uint8Array {
  const out = new Uint8Array(probMap.length);
  for (let i = 0; i < probMap.length; i += 1) out[i] = probMap[i] > threshold ? 1 : 0;
  return out;
}

/** A square of ones. Closes the one-pixel gaps that split a word into two components on
 *  faint thermal print. */
export function dilate(bitmap: Uint8Array, width: number, height: number, kernel: number): Uint8Array {
  const out = new Uint8Array(bitmap.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (bitmap[y * width + x] === 0) continue;
      for (let dy = 0; dy < kernel; dy += 1) {
        const ny = y + dy;
        if (ny >= height) break;
        for (let dx = 0; dx < kernel; dx += 1) {
          const nx = x + dx;
          if (nx >= width) break;
          out[ny * width + nx] = 1;
        }
      }
    }
  }
  return out;
}

/** Two-pass union-find, 8-connected. Components come back in label order. */
export function labelComponents(
  bitmap: Uint8Array,
  width: number,
  height: number,
  maxCandidates: number,
): { components: Point[][]; truncated: boolean } {
  const labels = new Int32Array(bitmap.length);
  const parent: number[] = [0];

  function find(a: number): number {
    let root = a;
    while (parent[root] !== root) root = parent[root];
    let walk = a;
    while (parent[walk] !== root) {
      const next = parent[walk];
      parent[walk] = root;
      walk = next;
    }
    return root;
  }

  function union(a: number, b: number): void {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  }

  let next = 1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      if (bitmap[index] === 0) continue;
      const neighbours: number[] = [];
      for (const [dx, dy] of [
        [-1, 0],
        [-1, -1],
        [0, -1],
        [1, -1],
      ] as const) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width) continue;
        const label = labels[ny * width + nx];
        if (label !== 0) neighbours.push(label);
      }
      if (neighbours.length === 0) {
        labels[index] = next;
        parent[next] = next;
        next += 1;
        continue;
      }
      const smallest = Math.min(...neighbours);
      labels[index] = smallest;
      for (const label of neighbours) union(smallest, label);
    }
  }

  const byRoot = new Map<number, Point[]>();
  const order: number[] = [];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const label = labels[y * width + x];
      if (label === 0) continue;
      const root = find(label);
      let bucket = byRoot.get(root);
      if (bucket === undefined) {
        bucket = [];
        byRoot.set(root, bucket);
        order.push(root);
      }
      bucket.push({ x, y });
    }
  }

  const components = order.slice(0, maxCandidates).map((root) => byRoot.get(root) as Point[]);
  return { components, truncated: order.length > maxCandidates };
}

/** Monotone chain. Returns the hull counter-clockwise with no repeated endpoint. */
export function convexHull(points: Point[]): Point[] {
  if (points.length < 3) return [...points];
  const sorted = [...points].sort((a, b) => (a.x === b.x ? a.y - b.y : a.x - b.x));
  const cross = (o: Point, a: Point, b: Point) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Point[] = [];
  for (const point of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], point) <= 0) lower.pop();
    lower.push(point);
  }
  const upper: Point[] = [];
  for (let i = sorted.length - 1; i >= 0; i -= 1) {
    const point = sorted[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], point) <= 0) upper.pop();
    upper.push(point);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/** Rotating calipers over the hull. */
export function minAreaRect(hull: Point[]): RotatedRect {
  if (hull.length === 0) return { cx: 0, cy: 0, width: 0, height: 0, angleDeg: 0 };
  if (hull.length < 3) {
    const xs = hull.map((p) => p.x);
    const ys = hull.map((p) => p.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    return { cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, width: maxX - minX + 1, height: maxY - minY + 1, angleDeg: 0 };
  }
  let best: RotatedRect | null = null;
  let bestArea = Number.POSITIVE_INFINITY;
  for (let i = 0; i < hull.length; i += 1) {
    const a = hull[i];
    const b = hull[(i + 1) % hull.length];
    const edgeLength = Math.hypot(b.x - a.x, b.y - a.y);
    if (edgeLength === 0) continue;
    const ux = (b.x - a.x) / edgeLength;
    const uy = (b.y - a.y) / edgeLength;
    let minU = Number.POSITIVE_INFINITY;
    let maxU = Number.NEGATIVE_INFINITY;
    let minV = Number.POSITIVE_INFINITY;
    let maxV = Number.NEGATIVE_INFINITY;
    for (const point of hull) {
      const u = point.x * ux + point.y * uy;
      const v = -point.x * uy + point.y * ux;
      if (u < minU) minU = u;
      if (u > maxU) maxU = u;
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }
    const width = maxU - minU;
    const height = maxV - minV;
    const area = width * height;
    if (area >= bestArea) continue;
    bestArea = area;
    const cu = (minU + maxU) / 2;
    const cv = (minV + maxV) / 2;
    best = {
      cx: cu * ux - cv * uy,
      cy: cu * uy + cv * ux,
      width,
      height,
      angleDeg: (Math.atan2(uy, ux) * 180) / Math.PI,
    };
  }
  return best ?? { cx: 0, cy: 0, width: 0, height: 0, angleDeg: 0 };
}

export function rectCorners(rect: RotatedRect): Quad {
  const radians = (rect.angleDeg * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const hw = rect.width / 2;
  const hh = rect.height / 2;
  const offsets: [number, number][] = [
    [-hw, -hh],
    [hw, -hh],
    [hw, hh],
    [-hw, hh],
  ];
  const points = offsets.map(([ox, oy]) => ({
    x: rect.cx + ox * cos - oy * sin,
    y: rect.cy + ox * sin + oy * cos,
  }));
  return [points[0], points[1], points[2], points[3]] as const;
}

/** DET_SCORE_MODE is 'fast': the arithmetic mean over the axis-aligned bounding box of the
 *  four corners, clipped to the map bounds. */
export function boxScoreFast(probMap: Float32Array, width: number, height: number, quad: Quad): number {
  const xs = quad.map((p) => p.x);
  const ys = quad.map((p) => p.y);
  const x0 = Math.max(0, Math.min(width - 1, Math.floor(Math.min(...xs))));
  const x1 = Math.max(0, Math.min(width - 1, Math.ceil(Math.max(...xs))));
  const y0 = Math.max(0, Math.min(height - 1, Math.floor(Math.min(...ys))));
  const y1 = Math.max(0, Math.min(height - 1, Math.ceil(Math.max(...ys))));
  let sum = 0;
  let count = 0;
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      sum += probMap[y * width + x];
      count += 1;
    }
  }
  return count === 0 ? 0 : sum / count;
}

/**
 * DBNet shrinks its training targets, so every surviving rectangle must be grown back.
 * The reference implementations run a Vatti polygon offset through pyclipper; this takes no
 * polygon-clipping dependency and expands the rectangle about its own centre instead. For a
 * rectangle that is exactly what a Vatti offset by the same distance produces, except at
 * the four corners, where Vatti with JT_ROUND rounds and this squares them off. A squared
 * corner on a text box is strictly more generous than a rounded one.
 */
export function unclipRect(rect: RotatedRect, ratio: number): RotatedRect {
  const area = rect.width * rect.height;
  const perimeter = 2 * (rect.width + rect.height);
  if (perimeter === 0) return rect;
  const distance = (area * ratio) / perimeter;
  return { ...rect, width: rect.width + 2 * distance, height: rect.height + 2 * distance };
}

export function boxesFromProbMap(probMap: Float32Array, width: number, height: number): DetectedBox[] {
  const binary = binarize(probMap, DET_BINARY_THRESH);
  const bitmap = DET_USE_DILATION ? dilate(binary, width, height, DET_DILATION_KERNEL) : binary;
  const { components } = labelComponents(bitmap, width, height, DET_MAX_CANDIDATES);
  const boxes: DetectedBox[] = [];
  for (const component of components) {
    const rect = minAreaRect(convexHull(component));
    if (Math.min(rect.width, rect.height) < DET_MIN_BOX_SIDE_PX) continue;
    const score = boxScoreFast(probMap, width, height, rectCorners(rect));
    if (score < DET_BOX_THRESH) continue;
    const grown = unclipRect(rect, DET_UNCLIP_RATIO);
    boxes.push({ quad: rectCorners(grown), rect: grown, score });
  }
  // A noisy photo of a patterned countertop can produce a thousand tiny components, each of
  // which would otherwise cost a recognition pass. A receipt is 30 to 80 lines.
  if (boxes.length <= DET_MAX_BOXES) return boxes;
  return [...boxes].sort((a, b) => b.score - a.score).slice(0, DET_MAX_BOXES);
}

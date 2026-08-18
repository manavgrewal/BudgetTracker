import { BLOCK_JOIN, LINE_JOIN, LINE_OVERLAP_RATIO } from '@/lib/warranty/ocr/onnx/constants';
import type { Quad } from '@/lib/warranty/ocr/onnx/contours';

/**
 * PURE. Takes boxes and strings, returns one string.
 *
 * The output must be newline-separated lines in top-to-bottom reading order, because
 * src/lib/warranty/suggest.ts depends on exactly that and is not being modified:
 * suggestVendor takes the first five non-empty lines, suggestPriceCents finds the total
 * line and reads the last currency number ON that line, and suggestPurchaseDate uses the
 * earliest occurrence index. One long line silently ruins all three.
 */

export interface AssemblyBox {
  quad: Quad;
  text: string;
  score: number;
}

interface Extent {
  box: AssemblyBox;
  minX: number;
  minY: number;
  maxY: number;
}

export function assembleText(boxes: readonly AssemblyBox[]): string {
  const extents: Extent[] = boxes.map((box) => {
    const ys = box.quad.map((point) => point.y);
    const xs = box.quad.map((point) => point.x);
    return { box, minX: Math.min(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
  });
  extents.sort((a, b) => a.minY - b.minY);

  const lines: Extent[][] = [];
  for (const extent of extents) {
    const current = lines[lines.length - 1];
    if (current === undefined) {
      lines.push([extent]);
      continue;
    }
    const previous = current[current.length - 1];
    const overlap = Math.min(previous.maxY, extent.maxY) - Math.max(previous.minY, extent.minY);
    const shorter = Math.min(previous.maxY - previous.minY, extent.maxY - extent.minY);
    // Grouping is transitive within this single pass: each box is compared against the last
    // box added to the open line, so a run of overlapping boxes stays one line.
    if (shorter > 0 && overlap >= shorter * LINE_OVERLAP_RATIO) current.push(extent);
    else lines.push([extent]);
  }

  return lines
    .map((line) =>
      [...line]
        .sort((a, b) => a.minX - b.minX)
        .map((entry) => entry.box.text)
        .join(LINE_JOIN),
    )
    .join(BLOCK_JOIN);
}

'use client';

import type { ScanQuad } from '@/lib/scanner/scan';

/**
 * The before and after pane. Each image is at most 160 pixels tall, matching the existing
 * receipt tiles. The countdown is visible for the whole four seconds, so nothing happens
 * without the owner having had the chance to see it; Use the original is framed as an undo
 * of something already decided rather than a step in a manual pipeline.
 */
export function ReceiptScanPreview({
  originalUrl,
  correctedUrl,
  quad,
  sourceWidth,
  sourceHeight,
  secondsLeft,
  onUseThis,
  onUseOriginal,
}: {
  originalUrl: string;
  correctedUrl: string;
  quad: ScanQuad;
  sourceWidth: number;
  sourceHeight: number;
  secondsLeft: number;
  onUseThis: () => void;
  onUseOriginal: () => void;
}) {
  const outline = [quad.topLeft, quad.topRight, quad.bottomRight, quad.bottomLeft]
    .map((point) => `${point.x},${point.y}`)
    .join(' ');

  return (
    <div className="flex flex-col gap-2 rounded-md border border-line bg-surface-2/50 p-3">
      <div className="flex flex-wrap gap-3">
        <span className="relative inline-block" data-testid="scan-preview-original">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={originalUrl} alt="The photo you took" className="max-h-40 w-auto rounded-xs" />
          <svg
            viewBox={`0 0 ${sourceWidth} ${sourceHeight}`}
            preserveAspectRatio="none"
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 h-full w-full"
          >
            <polygon points={outline} fill="none" stroke="currentColor" strokeWidth={sourceWidth / 120} />
          </svg>
        </span>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={correctedUrl}
          alt="The straightened receipt"
          data-testid="scan-preview-corrected"
          className="max-h-40 w-auto rounded-xs"
        />
      </div>
      <p className="text-sm text-muted" role="status">
        Using the straightened photo in {secondsLeft} {secondsLeft === 1 ? 'second' : 'seconds'}
      </p>
      <div className="flex gap-2">
        <button type="button" onClick={onUseThis} className="btn btn--primary btn--sm">
          Use this
        </button>
        <button type="button" onClick={onUseOriginal} className="btn btn--secondary btn--sm">
          Use the original
        </button>
      </div>
    </div>
  );
}

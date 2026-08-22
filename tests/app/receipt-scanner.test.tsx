// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { SCANNER_AUTO_ACCEPT_MS } from '@/lib/warranty/ocr/onnx/constants';
import { ReceiptUploader } from '@/components/warranty/ReceiptUploader';
import * as scanModule from '@/lib/scanner/scan';

const CORRECTED = new File(['corrected-bytes'], 'receipt.jpg', { type: 'image/jpeg' });

function stageResponse(mime = 'image/jpeg', name = 'receipt.jpg') {
  return {
    ok: true,
    json: async () => ({
      staged: [{ stagingId: 's1', originalFilename: name, mime, sizeBytes: 12, sha256: 'a'.repeat(64) }],
    }),
  } as Response;
}

function quad() {
  return {
    topLeft: { x: 10, y: 10 },
    topRight: { x: 90, y: 12 },
    bottomRight: { x: 92, y: 90 },
    bottomLeft: { x: 8, y: 88 },
  };
}

let urls = 0;
const revoked: string[] = [];

beforeEach(() => {
  urls = 0;
  revoked.length = 0;
  (URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = vi.fn(() => {
    urls += 1;
    return `blob:mock-${urls}`;
  });
  (URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL = vi.fn((url: string) => {
    revoked.push(url);
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function pick(container: HTMLElement, files: File[]): void {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(input, { target: { files } });
}

describe('MUST-8.11: the state machine between the pick and the upload', () => {
  it('sends a PDF straight to upload with the original file and never calls the scanner', async () => {
    const spy = vi.spyOn(scanModule, 'scanReceiptFile');
    const fetchMock = vi.fn().mockResolvedValue(stageResponse('application/pdf', 'manual.pdf'));
    vi.stubGlobal('fetch', fetchMock);
    const { container } = render(<ReceiptUploader onStagedChange={vi.fn()} />);
    const pdf = new File(['%PDF-1.4'], 'manual.pdf', { type: 'application/pdf' });
    pick(container, [pdf]);
    await screen.findByText('manual.pdf');
    expect(spy).not.toHaveBeenCalled();
    const body = fetchMock.mock.calls[0][1].body as FormData;
    expect(body.getAll('file')[0]).toBe(pdf);
  });

  it('renders both panes and a countdown for an image with a valid quad', async () => {
    vi.spyOn(scanModule, 'scanReceiptFile').mockResolvedValue({
      file: CORRECTED,
      corrected: { url: 'blob:corrected', quad: quad(), sourceWidth: 100, sourceHeight: 100 },
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(stageResponse()));
    const { container } = render(<ReceiptUploader onStagedChange={vi.fn()} />);
    pick(container, [new File(['jpeg'], 'receipt.jpg', { type: 'image/jpeg' })]);
    expect(await screen.findByTestId('scan-preview-original')).toBeTruthy();
    expect(screen.getByTestId('scan-preview-corrected')).toBeTruthy();
    expect(screen.getByText(/Using the straightened photo in \d seconds?/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Use this' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Use the original' })).toBeTruthy();
  });

  it('uploads the corrected blob when the countdown expires', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.spyOn(scanModule, 'scanReceiptFile').mockResolvedValue({
      file: CORRECTED,
      corrected: { url: 'blob:corrected', quad: quad(), sourceWidth: 100, sourceHeight: 100 },
    });
    const fetchMock = vi.fn().mockResolvedValue(stageResponse());
    vi.stubGlobal('fetch', fetchMock);
    const { container } = render(<ReceiptUploader onStagedChange={vi.fn()} />);
    pick(container, [new File(['jpeg'], 'receipt.jpg', { type: 'image/jpeg' })]);
    await vi.waitFor(() => expect(screen.queryByTestId('scan-preview-original')).toBeTruthy());
    await vi.advanceTimersByTimeAsync(SCANNER_AUTO_ACCEPT_MS + 50);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect((fetchMock.mock.calls[0][1].body as FormData).getAll('file')[0]).toBe(CORRECTED);
  });

  it('Use this uploads immediately and cancels the timer', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.spyOn(scanModule, 'scanReceiptFile').mockResolvedValue({
      file: CORRECTED,
      corrected: { url: 'blob:corrected', quad: quad(), sourceWidth: 100, sourceHeight: 100 },
    });
    const fetchMock = vi.fn().mockResolvedValue(stageResponse());
    vi.stubGlobal('fetch', fetchMock);
    const { container } = render(<ReceiptUploader onStagedChange={vi.fn()} />);
    pick(container, [new File(['jpeg'], 'receipt.jpg', { type: 'image/jpeg' })]);
    fireEvent.click(await screen.findByRole('button', { name: 'Use this' }));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(SCANNER_AUTO_ACCEPT_MS * 2);
    // Not toHaveBeenCalledTimes(1): the pre-existing OCR poll (POLL_INTERVAL_MS, unrelated
    // to and unmodified by this task) legitimately fires its own fetch to the polling
    // endpoint inside this 8-second window once the stage upload has completed. What this
    // test must prove is that the auto-accept timer, not the poll, was cancelled -- i.e. the
    // stage upload itself never happened a second time.
    const stageUploadCalls = fetchMock.mock.calls.filter(([url]) => url === '/api/warranties/receipts/stage');
    expect(stageUploadCalls).toHaveLength(1);
  });

  it('Use the original uploads the untouched File by identity', async () => {
    vi.spyOn(scanModule, 'scanReceiptFile').mockResolvedValue({
      file: CORRECTED,
      corrected: { url: 'blob:corrected', quad: quad(), sourceWidth: 100, sourceHeight: 100 },
    });
    const fetchMock = vi.fn().mockResolvedValue(stageResponse());
    vi.stubGlobal('fetch', fetchMock);
    const original = new File(['jpeg'], 'receipt.jpg', { type: 'image/jpeg' });
    const { container } = render(<ReceiptUploader onStagedChange={vi.fn()} />);
    pick(container, [original]);
    fireEvent.click(await screen.findByRole('button', { name: 'Use the original' }));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect((fetchMock.mock.calls[0][1].body as FormData).getAll('file')[0]).toBe(original);
  });
});

describe('MUST-8.15: an upload is never blocked by the scanner', () => {
  it('a scan that returns the original uploads it with NO error rendered', async () => {
    const original = new File(['jpeg'], 'receipt.jpg', { type: 'image/jpeg' });
    vi.spyOn(scanModule, 'scanReceiptFile').mockResolvedValue({ file: original });
    const fetchMock = vi.fn().mockResolvedValue(stageResponse());
    vi.stubGlobal('fetch', fetchMock);
    const { container } = render(<ReceiptUploader onStagedChange={vi.fn()} />);
    pick(container, [original]);
    await screen.findByText('receipt.jpg');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByTestId('scan-preview-original')).toBeNull();
    expect((fetchMock.mock.calls[0][1].body as FormData).getAll('file')[0]).toBe(original);
  });

  it('a scan that rejects still uploads the original with no error rendered', async () => {
    const original = new File(['jpeg'], 'receipt.jpg', { type: 'image/jpeg' });
    vi.spyOn(scanModule, 'scanReceiptFile').mockRejectedValue(new Error('wasm refused to compile'));
    const fetchMock = vi.fn().mockResolvedValue(stageResponse());
    vi.stubGlobal('fetch', fetchMock);
    const { container } = render(<ReceiptUploader onStagedChange={vi.fn()} />);
    pick(container, [original]);
    await screen.findByText('receipt.jpg');
    expect(screen.queryByRole('alert')).toBeNull();
    expect((fetchMock.mock.calls[0][1].body as FormData).getAll('file')[0]).toBe(original);
  });
});

describe('MUST-8.16 / MUST-8.17: several files, and cleanup', () => {
  it('scans three images one after another and never concurrently', async () => {
    let live = 0;
    let peak = 0;
    vi.spyOn(scanModule, 'scanReceiptFile').mockImplementation(async (file) => {
      live += 1;
      peak = Math.max(peak, live);
      await new Promise((resolve) => setTimeout(resolve, 5));
      live -= 1;
      return { file };
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(stageResponse()));
    const { container } = render(<ReceiptUploader onStagedChange={vi.fn()} />);
    pick(container, [
      new File(['a'], 'a.jpg', { type: 'image/jpeg' }),
      new File(['b'], 'b.jpg', { type: 'image/jpeg' }),
      new File(['c'], 'c.jpg', { type: 'image/jpeg' }),
    ]);
    await vi.waitFor(() => expect(scanModule.scanReceiptFile).toHaveBeenCalledTimes(3));
    expect(peak).toBe(1);
  });

  it('unmounting mid-preview revokes every preview URL and clears the countdown', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.spyOn(scanModule, 'scanReceiptFile').mockResolvedValue({
      file: CORRECTED,
      corrected: { url: 'blob:corrected', quad: quad(), sourceWidth: 100, sourceHeight: 100 },
    });
    const fetchMock = vi.fn().mockResolvedValue(stageResponse());
    vi.stubGlobal('fetch', fetchMock);
    const view = render(<ReceiptUploader onStagedChange={vi.fn()} />);
    pick(view.container, [new File(['jpeg'], 'receipt.jpg', { type: 'image/jpeg' })]);
    await vi.waitFor(() => expect(screen.queryByTestId('scan-preview-original')).toBeTruthy());
    view.unmount();
    await vi.advanceTimersByTimeAsync(SCANNER_AUTO_ACCEPT_MS * 2);
    expect(revoked).toContain('blob:corrected');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('MUST-8.13: quad validation', () => {
  const work = { width: 100, height: 100 };

  it('accepts a plausible quad', () => {
    expect(scanModule.isUsableQuad(quad(), work.width, work.height)).toBe(true);
  });

  it('rejects a quad whose area is under a quarter of the frame', () => {
    expect(
      scanModule.isUsableQuad(
        {
          topLeft: { x: 10, y: 10 },
          topRight: { x: 40, y: 10 },
          bottomRight: { x: 40, y: 40 },
          bottomLeft: { x: 10, y: 40 },
        },
        work.width,
        work.height,
      ),
    ).toBe(false);
  });

  it('rejects a sliver whose short side is under 5 percent of the long side', () => {
    expect(
      scanModule.isUsableQuad(
        {
          topLeft: { x: 0, y: 0 },
          topRight: { x: 100, y: 0 },
          bottomRight: { x: 100, y: 3 },
          bottomLeft: { x: 0, y: 3 },
        },
        work.width,
        work.height,
      ),
    ).toBe(false);
  });

  it('rejects a non-convex quad', () => {
    expect(
      scanModule.isUsableQuad(
        {
          topLeft: { x: 0, y: 0 },
          topRight: { x: 100, y: 0 },
          bottomRight: { x: 40, y: 40 },
          bottomLeft: { x: 0, y: 100 },
        },
        work.width,
        work.height,
      ),
    ).toBe(false);
  });

  it('rejects a quad with a NaN corner', () => {
    expect(
      scanModule.isUsableQuad({ ...quad(), topRight: { x: Number.NaN, y: 10 } }, work.width, work.height),
    ).toBe(false);
  });
});

// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ReceiptUploader } from '@/components/warranty/ReceiptUploader';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function stageResponse(overrides: Partial<{ stagingId: string; originalFilename: string; mime: string }> = {}) {
  return {
    ok: true,
    json: async () => ({
      staged: [
        {
          stagingId: 's1',
          originalFilename: 'receipt.jpg',
          mime: 'image/jpeg',
          sizeBytes: 12345,
          sha256: 'a'.repeat(64),
          ...overrides,
        },
      ],
    }),
  } as Response;
}

describe('ReceiptUploader', () => {
  beforeEach(() => {
    // jsdom does not implement these; the component calls them directly (no server-side
    // image processing anywhere in this feature -- §16.2 -- so this is the browser's own API).
    (URL as unknown as { createObjectURL: (file: File) => string }).createObjectURL = vi.fn(() => 'blob:mock-preview');
    (URL as unknown as { revokeObjectURL: (url: string) => void }).revokeObjectURL = vi.fn();
  });

  it(
    'still previews an image receipt after the input is cleared (CRITICAL 1 regression: ' +
      'the FileList captured at change-time must be snapshotted before event.target.value ' +
      'is reset, since browsers clear the live FileList in place rather than swapping it)',
    async () => {
      const onStagedChange = vi.fn();
      const fetchMock = vi.fn().mockResolvedValue(stageResponse());
      vi.stubGlobal('fetch', fetchMock);

      const { container } = render(<ReceiptUploader onStagedChange={onStagedChange} />);
      const input = container.querySelector('input[type="file"]') as HTMLInputElement;
      const file = new File(['fake-jpeg-bytes'], 'receipt.jpg', { type: 'image/jpeg' });

      fireEvent.change(input, { target: { files: [file] } });
      // The onChange handler resets the input's value synchronously, right after kicking
      // off upload() -- this is the exact sequence that reproduced the bug.
      expect(input.value).toBe('');

      const img = await screen.findByAltText('receipt.jpg');
      expect(img.getAttribute('src')).toBe('blob:mock-preview');

      // The staged array reaching the parent form must carry the real file, not an entry
      // whose previewUrl silently came back null/undefined because createObjectURL threw.
      const lastCall = onStagedChange.mock.calls.at(-1)?.[0];
      expect(lastCall).toHaveLength(1);
      expect(lastCall[0]).toMatchObject({ stagingId: 's1', previewUrl: 'blob:mock-preview' });
    },
  );

  it('does not preview a PDF (no createObjectURL call, just a placeholder tile)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      stageResponse({ originalFilename: 'manual.pdf', mime: 'application/pdf' }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { container } = render(<ReceiptUploader onStagedChange={vi.fn()} />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['%PDF-1.4'], 'manual.pdf', { type: 'application/pdf' });

    fireEvent.change(input, { target: { files: [file] } });

    await screen.findByText('manual.pdf');
    expect(screen.getByText('PDF')).toBeTruthy();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it('marks a receipt failed and surfaces a message when a poll response is not ok (IMPORTANT 3, e.g. a 401 on session expiry)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(stageResponse())
      .mockResolvedValue({ ok: false, json: async () => ({}) } as Response);
    vi.stubGlobal('fetch', fetchMock);

    const { container } = render(<ReceiptUploader onStagedChange={vi.fn()} />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['fake-jpeg-bytes'], 'receipt.jpg', { type: 'image/jpeg' });

    fireEvent.change(input, { target: { files: [file] } });
    // Let the (fake-timer-independent) stage upload's promise chain settle.
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    await vi.advanceTimersByTimeAsync(1500);

    expect(screen.getByText('Could not read')).toBeTruthy();
    expect(screen.getByText('That receipt could not be read.')).toBeTruthy();
  });
});

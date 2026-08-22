'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Notice } from '@/components/ui/Notice';
import { ReceiptScanPreview } from '@/components/warranty/ReceiptScanPreview';
import { scanReceiptFile, type ScanQuad } from '@/lib/scanner/scan';
import { SCANNER_AUTO_ACCEPT_MS } from '@/lib/warranty/ocr/onnx/constants';

/**
 * The only file control in the feature. MUST-6.1 fixes its exact shape; MUST-10.2 fixes its
 * behaviour: OCR NEVER blocks the form. The Save button stays enabled the whole time.
 */
export interface StagedFile {
  stagingId: string;
  originalFilename: string;
  mime: string;
  sizeBytes: number;
  sha256: string;
  /** URL.createObjectURL — the browser's own preview. No server-side image processing (§16.2). */
  previewUrl: string | null;
  ocr: 'pending' | 'done' | 'failed';
  error?: string;
}

export interface SuggestedFieldsDto {
  purchaseDate?: string;
  vendor?: string;
  priceCents?: number;
}

export const POLL_INTERVAL_MS = 1500;
export const POLL_GIVE_UP_MS = 180_000;
export const POLL_GIVE_UP_MESSAGE = 'Still processing — save now and re-run OCR from the item page.';
export const READING_MESSAGE =
  "Reading receipt… you can fill this in and save now; suggestions will appear when it's done.";

interface StageResponse {
  staged?: { stagingId: string; originalFilename: string; mime: string; sizeBytes: number; sha256: string }[];
  error?: string;
}

interface PollResponse {
  status: 'pending' | 'done' | 'failed';
  suggestions?: SuggestedFieldsDto;
  error?: string;
}

interface Pending {
  original: File;
  corrected: File;
  originalUrl: string;
  correctedUrl: string;
  quad: ScanQuad;
  sourceWidth: number;
  sourceHeight: number;
}

const COUNTDOWN_TICK_MS = 1000;

export function ReceiptUploader({
  onStagedChange,
  onSuggestions,
  label = 'Receipt photo or PDF',
}: {
  onStagedChange: (files: StagedFile[]) => void;
  onSuggestions?: (suggestions: SuggestedFieldsDto) => void;
  label?: string;
}) {
  const [files, setFiles] = useState<StagedFile[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const timers = useRef<ReturnType<typeof setInterval>[]>([]);
  // IMPORTANT 4: mirrors `files` so the unmount-cleanup effect below (which must run only
  // once, with empty deps, to avoid re-registering on every render) can still revoke
  // whatever object URLs exist AT UNMOUNT TIME rather than the ones captured in its stale
  // closure over the first render's (empty) `files` array.
  const filesRef = useRef<StagedFile[]>([]);
  // IMPORTANT 4's stale-closure reason applies here too: the unmount effect runs once with
  // empty deps, so it needs a ref to see whatever preview URLs exist AT UNMOUNT TIME.
  const previewUrlsRef = useRef<string[]>([]);
  const resolvePendingRef = useRef<((file: File) => void) | null>(null);

  useEffect(() => {
    filesRef.current = files;
    onStagedChange(files);
  }, [files, onStagedChange]);

  useEffect(
    () => () => {
      for (const timer of timers.current) clearInterval(timer);
      for (const file of filesRef.current) if (file.previewUrl) URL.revokeObjectURL(file.previewUrl);
      for (const url of previewUrlsRef.current) URL.revokeObjectURL(url);
      resolvePendingRef.current = null;
    },
    // Cleanup on unmount only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  useEffect(() => {
    if (pending === null) return;
    setSecondsLeft(Math.ceil(SCANNER_AUTO_ACCEPT_MS / COUNTDOWN_TICK_MS));
    const tick = setInterval(() => setSecondsLeft((left) => Math.max(0, left - 1)), COUNTDOWN_TICK_MS);
    const accept = setTimeout(() => resolvePendingRef.current?.(pending.corrected), SCANNER_AUTO_ACCEPT_MS);
    return () => {
      clearInterval(tick);
      clearTimeout(accept);
    };
  }, [pending]);

  const poll = useCallback(
    (stagingId: string) => {
      const startedAt = Date.now();
      const timer = setInterval(async () => {
        // IMPORTANT 2: a rejected fetch/json (offline, transient network blip) must not
        // become an unhandled promise rejection, and must not kill this interval either --
        // just skip this tick and retry at the next one. POLL_GIVE_UP_MS above still bounds
        // how long that can go on.
        try {
          if (Date.now() - startedAt > POLL_GIVE_UP_MS) {
            clearInterval(timer);
            setNotice(POLL_GIVE_UP_MESSAGE);
            return;
          }
          const response = await fetch(`/api/warranties/receipts/stage/${stagingId}`);
          if (!response.ok) {
            // IMPORTANT 3: a non-ok response (e.g. a 401 on session expiry) must not leave
            // this tile reading "Reading…" forever -- mark it failed and stop polling it.
            clearInterval(timer);
            setFiles((prev) =>
              prev.map((file) => (file.stagingId === stagingId ? { ...file, ocr: 'failed' } : file)),
            );
            setNotice('That receipt could not be read.');
            return;
          }
          const body = (await response.json()) as PollResponse;
          if (body.status === 'pending') return;
          clearInterval(timer);
          setFiles((prev) =>
            prev.map((file) =>
              file.stagingId === stagingId ? { ...file, ocr: body.status, error: body.error } : file,
            ),
          );
          if (body.status === 'done') {
            setNotice(null);
            if (onSuggestions && body.suggestions) onSuggestions(body.suggestions);
          } else {
            // MUST-10.2 step 4: show the error and carry on. Rendered as a text node only
            // (MUST-13.3) — never dangerouslySetInnerHTML.
            setNotice(body.error ?? 'That receipt could not be read.');
          }
        } catch {
          // Transient failure this tick only -- leave the timer running.
        }
      }, POLL_INTERVAL_MS);
      timers.current.push(timer);
    },
    [onSuggestions],
  );

  async function upload(chosen: File[]): Promise<void> {
    setError(null);
    setBusy(true);
    try {
      const form = new FormData();
      for (const file of chosen) form.append('file', file);
      const response = await fetch('/api/warranties/receipts/stage', { method: 'POST', body: form });
      const body = (await response.json()) as StageResponse;
      if (!response.ok || !body.staged) {
        setError(body.error ?? 'That upload did not work.');
        return;
      }
      // CRITICAL fix: `chosen` is a plain array snapshot taken BEFORE the input's value was
      // reset, unlike the live FileList the input exposes -- browsers clear (not swap) that
      // FileList in place, so by the time this line ran against the original FileList
      // reference, `list[index]` would already be undefined and URL.createObjectURL() would
      // throw, silently dropping every image receipt (PDFs were unaffected only because
      // their branch never calls createObjectURL).
      const staged: StagedFile[] = body.staged.map((entry, index) => ({
        ...entry,
        previewUrl: entry.mime.startsWith('image/') ? URL.createObjectURL(chosen[index]) : null,
        ocr: 'pending' as const,
      }));
      setFiles((prev) => [...prev, ...staged]);
      setNotice(READING_MESSAGE);
      for (const entry of staged) poll(entry.stagingId);
    } finally {
      setBusy(false);
    }
  }

  function releasePreview(entry: Pending): void {
    for (const url of [entry.originalUrl, entry.correctedUrl]) {
      URL.revokeObjectURL(url);
      previewUrlsRef.current = previewUrlsRef.current.filter((value) => value !== url);
    }
  }

  async function decide(original: File): Promise<File> {
    if (!original.type.startsWith('image/')) return original;
    setScanning(true);
    let result;
    try {
      result = await scanReceiptFile(original);
    } catch {
      // scanReceiptFile is documented never to reject, and this is the belt for that brace:
      // an upload is never blocked by the scanner.
      return original;
    } finally {
      setScanning(false);
    }
    if (result.corrected === undefined) return result.file;

    const originalUrl = URL.createObjectURL(original);
    previewUrlsRef.current = [...previewUrlsRef.current, originalUrl, result.corrected.url];
    const entry: Pending = {
      original,
      corrected: result.file,
      originalUrl,
      correctedUrl: result.corrected.url,
      quad: result.corrected.quad,
      sourceWidth: result.corrected.sourceWidth,
      sourceHeight: result.corrected.sourceHeight,
    };
    const chosen = await new Promise<File>((resolve) => {
      resolvePendingRef.current = resolve;
      setPending(entry);
    });
    resolvePendingRef.current = null;
    setPending(null);
    releasePreview(entry);
    return chosen;
  }

  async function handlePicked(chosen: File[]): Promise<void> {
    // Sequentially, never in parallel: three simultaneous warps is how a mid-range Android
    // tab crashes.
    for (const original of chosen) {
      const file = await decide(original);
      await upload([file]);
    }
  }

  function remove(stagingId: string): void {
    setFiles((prev) => {
      const target = prev.find((file) => file.stagingId === stagingId);
      if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((file) => file.stagingId !== stagingId);
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <label className="flex flex-col gap-1.5">
        <span className="field-label">{label}</span>
        {/* MUST-6.1, exactly: capture="environment" opens a phone's rear camera directly and
            is ignored by a desktop browser. There is no native app and no live camera stream
            requested from the page -- the still image the camera app hands back is then
            straightened with an in-browser canvas crop, never a live viewfinder. */}
        <input
          type="file"
          name="file"
          accept="image/*,application/pdf"
          capture="environment"
          multiple
          disabled={busy}
          onChange={(event) => {
            // CRITICAL fix: snapshot the FileList into a plain array FIRST. Resetting
            // event.target.value below clears the browser's underlying FileList object (it
            // does not swap in a new, separate one) -- any reference to `list` taken after
            // that point sees an empty list once the async upload() resumes past its first
            // await, which is exactly what silently dropped every image receipt before.
            const list = event.target.files;
            const chosen = list ? Array.from(list) : [];
            if (chosen.length > 0) void handlePicked(chosen);
            event.target.value = '';
          }}
          className="text-sm text-muted file:mr-3 file:rounded-md file:border-0 file:bg-accent-soft file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-accent-soft-fg"
        />
      </label>

      {error ? <Notice tone="error">{error}</Notice> : null}
      {notice ? <p className="text-sm text-muted">{notice}</p> : null}

      {scanning ? (
        <p className="text-sm text-muted" role="status">
          Finding the receipt…
        </p>
      ) : null}
      {pending !== null ? (
        <ReceiptScanPreview
          originalUrl={pending.originalUrl}
          correctedUrl={pending.correctedUrl}
          quad={pending.quad}
          sourceWidth={pending.sourceWidth}
          sourceHeight={pending.sourceHeight}
          secondsLeft={secondsLeft}
          onUseThis={() => resolvePendingRef.current?.(pending.corrected)}
          onUseOriginal={() => resolvePendingRef.current?.(pending.original)}
        />
      ) : null}

      {files.length > 0 ? (
        <ul className="flex flex-wrap gap-3">
          {files.map((file) => (
            <li
              key={file.stagingId}
              className="flex w-40 flex-col gap-1.5 rounded-md border border-line bg-surface-2/50 p-2 text-xs"
            >
              <span className="flex h-24 items-center justify-center overflow-hidden rounded-xs bg-surface">
                {file.previewUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={file.previewUrl} alt={file.originalFilename} className="max-h-24 w-full object-contain" />
                ) : (
                  <span className="text-subtle">PDF</span>
                )}
              </span>
              <span className="truncate font-medium text-ink" title={file.originalFilename}>{file.originalFilename}</span>
              <span className={file.ocr === 'failed' ? 'money-neg' : 'text-subtle'}>
                {file.ocr === 'pending' ? 'Reading…' : file.ocr === 'done' ? 'Read' : 'Could not read'}
              </span>
              <button
                type="button"
                onClick={() => remove(file.stagingId)}
                aria-label={`Remove ${file.originalFilename}`}
                className="btn btn--ghost btn--sm w-fit px-1.5 text-xs"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

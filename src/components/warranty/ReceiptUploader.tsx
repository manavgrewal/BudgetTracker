'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

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
  const timers = useRef<ReturnType<typeof setInterval>[]>([]);
  // IMPORTANT 4: mirrors `files` so the unmount-cleanup effect below (which must run only
  // once, with empty deps, to avoid re-registering on every render) can still revoke
  // whatever object URLs exist AT UNMOUNT TIME rather than the ones captured in its stale
  // closure over the first render's (empty) `files` array.
  const filesRef = useRef<StagedFile[]>([]);

  useEffect(() => {
    filesRef.current = files;
    onStagedChange(files);
  }, [files, onStagedChange]);

  useEffect(
    () => () => {
      for (const timer of timers.current) clearInterval(timer);
      for (const file of filesRef.current) if (file.previewUrl) URL.revokeObjectURL(file.previewUrl);
    },
    // Cleanup on unmount only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

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

  function remove(stagingId: string): void {
    setFiles((prev) => {
      const target = prev.find((file) => file.stagingId === stagingId);
      if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((file) => file.stagingId !== stagingId);
    });
  }

  return (
    <div className="flex flex-col gap-2">
      <label className="flex flex-col gap-1 text-sm">
        {label}
        {/* MUST-6.1, exactly: capture="environment" opens a phone's rear camera directly and
            is ignored by a desktop browser. No native app, no getUserMedia, no canvas. */}
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
            if (chosen.length > 0) void upload(chosen);
            event.target.value = '';
          }}
          className="text-sm"
        />
      </label>

      {error ? <p role="alert" className="text-sm text-red-700 dark:text-red-300">{error}</p> : null}
      {notice ? <p className="text-sm text-slate-600 dark:text-slate-300">{notice}</p> : null}

      {files.length > 0 ? (
        <ul className="flex flex-wrap gap-3">
          {files.map((file) => (
            <li key={file.stagingId} className="flex w-40 flex-col gap-1 rounded border p-2 text-xs dark:border-slate-700">
              {file.previewUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={file.previewUrl} alt={file.originalFilename} className="max-h-24 w-full object-contain" />
              ) : (
                <span className="text-slate-500">PDF</span>
              )}
              <span className="truncate" title={file.originalFilename}>{file.originalFilename}</span>
              <span className="text-slate-500">
                {file.ocr === 'pending' ? 'Reading…' : file.ocr === 'done' ? 'Read' : 'Could not read'}
              </span>
              <button type="button" onClick={() => remove(file.stagingId)} className="w-fit underline">
                Remove
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

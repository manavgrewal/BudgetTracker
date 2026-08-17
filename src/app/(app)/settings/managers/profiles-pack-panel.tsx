'use client';

import { useState } from 'react';
import { Notice } from '@/components/ui/Notice';
import type { ProfilesExportRow } from '@/lib/packs';

const fileInputClass =
  'text-sm text-muted file:mr-3 file:rounded-md file:border-0 file:bg-accent-soft file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-accent-soft-fg';

export function ProfilesPackPanel({ rows }: { rows: ProfilesExportRow[] }) {
  const [selected, setSelected] = useState<number[]>(rows.map((row) => row.profileId));
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<{ totalProfiles: number; willRename: { from: string; to: string }[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const toggle = (id: number) => setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  const exportHref = `/api/packs/profiles/export?ids=${selected.join(',')}`;

  async function send(mode: 'preview' | 'apply') {
    if (!file) {
      setError('Choose a pack file first.');
      return;
    }
    setError(null);
    setNotice(null);
    const form = new FormData();
    form.append('file', file);
    form.append('mode', mode);
    const response = await fetch('/api/packs/profiles/import', { method: 'POST', body: form });
    const body = await response.json();
    if (!response.ok) {
      setError(body.error ?? 'Import failed.');
      setPreview(null);
      return;
    }
    if (mode === 'preview') {
      setPreview(body as { totalProfiles: number; willRename: { from: string; to: string }[] });
      return;
    }
    setPreview(null);
    setNotice(`Imported ${body.added.length} profiles.`);
    window.location.reload();
  }

  return (
    <section className="flex flex-col gap-4 rounded-lg border border-line bg-surface-2/50 p-4 text-sm">
      <div className="flex flex-col gap-1">
        <h3 className="text-sm font-semibold text-ink">Share bank column layouts</h3>
        <p className="text-xs text-muted">
          A profile pack carries only the name, institution and column mapping — pure layout knowledge, with no personal data by construction.
        </p>
      </div>
      {error ? <Notice tone="error">{error}</Notice> : null}
      {notice ? <Notice tone="success">{notice}</Notice> : null}

      <div className="flex flex-col gap-2">
        <h4 className="eyebrow">Export</h4>
        <ul className="max-h-48 overflow-y-auto rounded-md border border-line bg-surface p-2">
          {rows.map((row) => (
            <li key={row.profileId} className="flex items-center gap-2 py-0.5">
              <input
                type="checkbox"
                checked={selected.includes(row.profileId)}
                onChange={() => toggle(row.profileId)}
                aria-label={`Include ${row.name}`}
                className="accent-accent"
              />
              <span className="text-xs text-ink">
                {row.name} <span className="text-subtle">{row.institution}{row.isBuiltin ? ' · built-in' : ''}</span>
              </span>
            </li>
          ))}
          {rows.length === 0 ? <li className="px-1 py-2 text-xs text-subtle">No profiles to export yet.</li> : null}
        </ul>
        <a href={exportHref} className="btn btn--primary w-fit">
          Download profile pack ({selected.length})
        </a>
      </div>

      <div className="flex flex-col gap-2 border-t border-line pt-4">
        <h4 className="eyebrow">Import</h4>
        <input
          type="file"
          accept="application/json,.json"
          aria-label="Profile pack file"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          className={fileInputClass}
        />
        <div className="flex gap-2">
          <button type="button" onClick={() => void send('preview')} className="btn btn--secondary">Preview</button>
          <button type="button" onClick={() => void send('apply')} disabled={preview === null} className="btn btn--primary">
            Import
          </button>
        </div>
        {preview ? (
          <p className="rounded-md border border-line bg-surface p-3 text-xs text-muted">
            {preview.totalProfiles} profiles in the file.{' '}
            {preview.willRename.length > 0
              ? `These names are taken and will be renamed: ${preview.willRename.map((r) => `${r.from} → ${r.to}`).join(', ')}.`
              : 'No name collisions.'}
          </p>
        ) : null}
      </div>
    </section>
  );
}

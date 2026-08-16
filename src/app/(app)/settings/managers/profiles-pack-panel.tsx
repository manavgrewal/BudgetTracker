'use client';

import { useState } from 'react';
import type { ProfilesExportRow } from '@/lib/packs';

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
    <section className="flex flex-col gap-3 rounded border border-slate-200 p-3 text-sm dark:border-slate-800">
      <h3 className="font-medium">Share bank column layouts</h3>
      <p className="text-xs text-slate-500">
        A profile pack carries only the name, institution and column mapping — pure layout knowledge, with no personal data by construction.
      </p>
      {error ? <p role="alert" className="rounded bg-red-50 px-3 py-2 text-red-700 dark:bg-red-950 dark:text-red-300">{error}</p> : null}
      {notice ? <p className="text-green-700 dark:text-green-400">{notice}</p> : null}

      <ul className="max-h-48 overflow-y-auto rounded border border-slate-100 p-2 dark:border-slate-900">
        {rows.map((row) => (
          <li key={row.profileId} className="flex items-center gap-2 py-0.5">
            <input type="checkbox" checked={selected.includes(row.profileId)} onChange={() => toggle(row.profileId)} aria-label={`Include ${row.name}`} />
            <span className="text-xs">{row.name} <span className="text-slate-500">{row.institution}{row.isBuiltin ? ' · built-in' : ''}</span></span>
          </li>
        ))}
      </ul>
      <a href={exportHref} className="w-fit rounded bg-slate-900 px-3 py-2 text-white dark:bg-slate-100 dark:text-slate-900">
        Download profile pack ({selected.length})
      </a>

      <div className="flex flex-col gap-2 border-t border-slate-100 pt-3 dark:border-slate-900">
        <input type="file" accept="application/json,.json" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        <div className="flex gap-2">
          <button type="button" onClick={() => void send('preview')} className="rounded border px-3 py-2 dark:border-slate-700">Preview</button>
          <button type="button" onClick={() => void send('apply')} disabled={preview === null} className="rounded bg-slate-900 px-3 py-2 text-white disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900">
            Import
          </button>
        </div>
        {preview ? (
          <p className="text-xs">
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

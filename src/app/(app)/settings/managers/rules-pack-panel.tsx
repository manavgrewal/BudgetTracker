'use client';

import { useState } from 'react';
import type { RulesExportRow } from '@/lib/packs';

interface ImportPreview {
  applied: false;
  totalRules: number;
  newRules: number;
  unchanged: number;
  transferRules: number;
  skippedRules: number;
  conflicts: { pattern: string; matchType: string; existingCategory: string | null; incomingCategory: string | null }[];
  newCategories: string[];
}

export function RulesPackPanel({ rows }: { rows: RulesExportRow[] }) {
  const [includeTransfers, setIncludeTransfers] = useState(false);
  const [excluded, setExcluded] = useState<number[]>([]);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [onConflict, setOnConflict] = useState<'keep' | 'overwrite'>('keep');
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const visible = rows.filter((row) => (row.ruleKind === 'transfer' ? includeTransfers : true));
  const exportHref = `/api/packs/rules/export?includeTransfers=${includeTransfers ? '1' : '0'}&exclude=${excluded.join(',')}`;
  const toggle = (id: number) => setExcluded((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

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
    form.append('onConflict', onConflict);
    const response = await fetch('/api/packs/rules/import', { method: 'POST', body: form });
    const body = await response.json();
    if (!response.ok) {
      setError(body.error ?? 'Import failed.');
      setPreview(null);
      return;
    }
    if (mode === 'preview') {
      setPreview(body as ImportPreview);
      return;
    }
    setPreview(null);
    setNotice(
      `Added ${body.rulesAdded} rules, overwrote ${body.rulesOverwritten}, kept ${body.rulesKept} existing, created ${body.categoriesCreated} categories.` +
        (body.rulesSkipped > 0 ? ` Skipped ${body.rulesSkipped} rules this install can't import.` : ''),
    );
    window.location.reload();
  }

  return (
    <section className="flex flex-col gap-3 rounded border border-slate-200 p-3 text-sm dark:border-slate-800">
      <h3 className="font-medium">Share rules with another install</h3>
      <p className="text-xs text-slate-500">
        A rules pack carries only category names and merchant patterns. It never contains transactions, amounts, accounts, users, or the
        classifier&apos;s learned statistics.
      </p>
      {error ? <p role="alert" className="rounded bg-red-50 px-3 py-2 text-red-700 dark:bg-red-950 dark:text-red-300">{error}</p> : null}
      {notice ? <p className="text-green-700 dark:text-green-400">{notice}</p> : null}

      <div className="flex flex-col gap-2">
        <h4 className="text-xs font-medium uppercase tracking-wide text-slate-500">Export</h4>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={includeTransfers} onChange={(e) => setIncludeTransfers(e.target.checked)} />
          Include transfer rules (they can contain personal names from e-transfer descriptions)
        </label>
        <p className="text-xs text-slate-500">Everything ticked below will be written into the file. Untick anything you would rather not share.</p>
        <ul className="max-h-64 overflow-y-auto rounded border border-slate-100 p-2 dark:border-slate-900">
          {visible.map((row) => (
            <li key={row.ruleId} className="flex items-center gap-2 py-0.5">
              <input type="checkbox" checked={!excluded.includes(row.ruleId)} onChange={() => toggle(row.ruleId)} aria-label={`Include ${row.pattern}`} />
              <code className="text-xs">{row.pattern}</code>
              <span className="text-xs text-slate-500">
                {row.matchType}
                {row.ruleKind === 'transfer' ? ' · transfer' : ` → ${row.categoryLabel ?? 'Uncategorized'}`}
              </span>
            </li>
          ))}
          {visible.length === 0 ? <li className="text-xs text-slate-500">No rules to export yet.</li> : null}
        </ul>
        <a href={exportHref} className="w-fit rounded bg-slate-900 px-3 py-2 text-white dark:bg-slate-100 dark:text-slate-900">
          Download rules pack ({visible.length - excluded.filter((id) => visible.some((row) => row.ruleId === id)).length} rules)
        </a>
      </div>

      <div className="flex flex-col gap-2 border-t border-slate-100 pt-3 dark:border-slate-900">
        <h4 className="text-xs font-medium uppercase tracking-wide text-slate-500">Import</h4>
        <input type="file" accept="application/json,.json" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        <label className="flex items-center gap-2">
          When a pattern already exists with a different category:
          <select value={onConflict} onChange={(e) => setOnConflict(e.target.value as 'keep' | 'overwrite')} className="rounded border px-2 py-1 dark:bg-slate-900">
            <option value="keep">keep mine</option>
            <option value="overwrite">use theirs</option>
          </select>
        </label>
        <div className="flex gap-2">
          <button type="button" onClick={() => void send('preview')} className="rounded border px-3 py-2 dark:border-slate-700">Preview</button>
          <button type="button" onClick={() => void send('apply')} disabled={preview === null} className="rounded bg-slate-900 px-3 py-2 text-white disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900">
            Import
          </button>
        </div>
        {preview ? (
          <div className="rounded bg-slate-50 p-3 text-xs dark:bg-slate-900">
            <p>
              {preview.totalRules} rules in the file: <strong>{preview.newRules} new</strong>, {preview.conflicts.length} conflicts,{' '}
              {preview.unchanged} already identical, {preview.transferRules} transfer rules.
            </p>
            {preview.skippedRules > 0 ? (
              <p>{preview.skippedRules} rules use a kind this install doesn&apos;t import (e.g. rename) and will be skipped.</p>
            ) : null}
            {preview.newCategories.length > 0 ? <p>Categories to create: {preview.newCategories.join(', ')}</p> : null}
            {preview.conflicts.length > 0 ? (
              <ul className="mt-1 list-inside list-disc">
                {preview.conflicts.map((conflict) => (
                  <li key={`${conflict.pattern}-${conflict.matchType}`}>
                    <code>{conflict.pattern}</code>: mine {conflict.existingCategory ?? 'none'} · theirs {conflict.incomingCategory ?? 'none'}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}

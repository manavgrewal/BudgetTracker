'use client';

import { useState } from 'react';
import { Notice } from '@/components/ui/Notice';
import { selectClass } from '@/components/ui/form';
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

const fileInputClass =
  'text-sm text-muted file:mr-3 file:rounded-md file:border-0 file:bg-accent-soft file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-accent-soft-fg';

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
    <section className="flex flex-col gap-4 rounded-lg border border-line bg-surface-2/50 p-4 text-sm">
      <div className="flex flex-col gap-1">
        <h3 className="text-sm font-semibold text-ink">Share rules with another install</h3>
        <p className="text-xs text-muted">
          A rules pack carries only category names and merchant patterns. It never contains transactions, amounts, accounts, users, or the
          classifier&apos;s learned statistics.
        </p>
      </div>
      {error ? <Notice tone="error">{error}</Notice> : null}
      {notice ? <Notice tone="success">{notice}</Notice> : null}

      <div className="flex flex-col gap-2">
        <h4 className="eyebrow">Export</h4>
        <label className="flex items-start gap-2 text-muted">
          <input
            type="checkbox"
            checked={includeTransfers}
            onChange={(e) => setIncludeTransfers(e.target.checked)}
            className="mt-0.5 accent-accent"
          />
          Include transfer rules (they can contain personal names from e-transfer descriptions)
        </label>
        <p className="text-xs text-subtle">Everything ticked below will be written into the file. Untick anything you would rather not share.</p>
        <ul className="max-h-64 overflow-y-auto rounded-md border border-line bg-surface p-2">
          {visible.map((row) => (
            <li key={row.ruleId} className="flex items-center gap-2 py-0.5">
              <input
                type="checkbox"
                checked={!excluded.includes(row.ruleId)}
                onChange={() => toggle(row.ruleId)}
                aria-label={`Include ${row.pattern}`}
                className="accent-accent"
              />
              <code className="font-mono text-xs text-ink">{row.pattern}</code>
              <span className="text-xs text-subtle">
                {row.matchType}
                {row.ruleKind === 'transfer' ? ' · transfer' : ` → ${row.categoryLabel ?? 'Uncategorized'}`}
              </span>
            </li>
          ))}
          {visible.length === 0 ? <li className="px-1 py-2 text-xs text-subtle">No rules to export yet.</li> : null}
        </ul>
        <a href={exportHref} className="btn btn--primary w-fit">
          Download rules pack ({visible.length - excluded.filter((id) => visible.some((row) => row.ruleId === id)).length} rules)
        </a>
      </div>

      <div className="flex flex-col gap-2 border-t border-line pt-4">
        <h4 className="eyebrow">Import</h4>
        <input
          type="file"
          accept="application/json,.json"
          aria-label="Rules pack file"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          className={fileInputClass}
        />
        <label className="flex flex-wrap items-center gap-2 text-muted">
          When a pattern already exists with a different category:
          <select
            value={onConflict}
            onChange={(e) => setOnConflict(e.target.value as 'keep' | 'overwrite')}
            className={`${selectClass} w-auto px-2 py-1 text-xs`}
          >
            <option value="keep">keep mine</option>
            <option value="overwrite">use theirs</option>
          </select>
        </label>
        <div className="flex gap-2">
          <button type="button" onClick={() => void send('preview')} className="btn btn--secondary">Preview</button>
          <button type="button" onClick={() => void send('apply')} disabled={preview === null} className="btn btn--primary">
            Import
          </button>
        </div>
        {preview ? (
          <div className="flex flex-col gap-1 rounded-md border border-line bg-surface p-3 text-xs text-muted">
            <p>
              {preview.totalRules} rules in the file: <strong className="font-semibold text-ink">{preview.newRules} new</strong>,{' '}
              {preview.conflicts.length} conflicts, {preview.unchanged} already identical, {preview.transferRules} transfer rules.
            </p>
            {preview.skippedRules > 0 ? (
              <p>{preview.skippedRules} rules use a kind this install doesn&apos;t import (e.g. rename) and will be skipped.</p>
            ) : null}
            {preview.newCategories.length > 0 ? <p>Categories to create: {preview.newCategories.join(', ')}</p> : null}
            {preview.conflicts.length > 0 ? (
              <ul className="mt-1 list-inside list-disc">
                {preview.conflicts.map((conflict) => (
                  <li key={`${conflict.pattern}-${conflict.matchType}`}>
                    <code className="font-mono">{conflict.pattern}</code>: mine {conflict.existingCategory ?? 'none'} · theirs{' '}
                    {conflict.incomingCategory ?? 'none'}
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

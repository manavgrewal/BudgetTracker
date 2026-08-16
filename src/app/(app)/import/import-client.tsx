'use client';

import { useState } from 'react';
import { MappingEditor } from '@/components/MappingEditor';
import { formatCents } from '@/lib/money';
import type { ImportMapping } from '@/lib/import/mapping';
import type { PreviewResult } from '@/lib/import/preview';
import type { ImportHistoryRow } from '@/lib/import/commit';

interface AccountOption { id: number; name: string; importProfileId: number | null }
interface ProfileOption { id: number; name: string; isBuiltin: boolean; mapping: ImportMapping }

export function ImportClient({
  accounts,
  profiles,
  history,
  simplefinManaged,
}: {
  accounts: AccountOption[];
  profiles: ProfileOption[];
  history: ImportHistoryRow[];
  simplefinManaged: string[];
}) {
  const [accountId, setAccountId] = useState<number>(accounts[0]?.id ?? 0);
  const [profileId, setProfileId] = useState<number>(accounts[0]?.importProfileId ?? profiles[0]?.id ?? 0);
  const [mapping, setMapping] = useState<ImportMapping | null>(profiles[0]?.mapping ?? null);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [historyRows, setHistoryRows] = useState<ImportHistoryRow[]>(history);

  async function upload(formData: FormData) {
    setBusy(true);
    setError(null);
    setSummary(null);
    formData.set('accountId', String(accountId));
    formData.set('profileId', String(profileId));
    const response = await fetch('/api/import/preview', { method: 'POST', body: formData });
    const body = await response.json();
    setBusy(false);
    if (!response.ok) {
      setError(body.error ?? 'Upload failed');
      return;
    }
    setPreview(body as PreviewResult);
    setMapping((body as PreviewResult).mapping);
  }

  async function rePreview(next: ImportMapping) {
    if (!preview) return;
    setMapping(next);
    setBusy(true);
    const response = await fetch('/api/import/preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stagingId: preview.stagingId, filename: preview.filename, accountId, profileId, mapping: next }),
    });
    const body = await response.json();
    setBusy(false);
    if (!response.ok) {
      setError(body.error ?? 'Preview failed');
      return;
    }
    setPreview(body as PreviewResult);
  }

  async function commit() {
    if (!preview || !mapping) return;
    setBusy(true);
    const response = await fetch('/api/import/commit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stagingId: preview.stagingId, filename: preview.filename, accountId, profileId, mapping }),
    });
    const body = await response.json();
    setBusy(false);
    if (!response.ok) {
      setError(body.error ?? 'Import failed');
      return;
    }
    setPreview(null);
    // The rows are always committed by this point, even when categorization
    // itself failed (flow.ts catches runEngine and reports engineFailed
    // instead of throwing) — they're categoryless, so the review queue
    // picks them up regardless of whether the engine ran.
    setSummary(
      body.engineFailed
        ? `${body.rowsAdded} imported, categorization failed — rows are in the review queue.`
        : `${body.rowsAdded} added, ${body.rowsDuplicate} duplicates skipped, ${body.rowsError} errors, ${body.needsReview} need review.`,
    );
  }

  async function undo(importId: number) {
    setError(null);
    const dialogResponse = await fetch('/api/import/undo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ importId }),
    });
    const counts = await dialogResponse.json();
    if (!dialogResponse.ok) {
      setError(counts.error ?? 'Could not look up this import.');
      return;
    }
    const ok = window.confirm(`Undo this import?\n\nWill delete ${counts.willDelete} transactions.\nWill keep ${counts.willKeep} shared with other imports.`);
    if (!ok) return;

    const undoResponse = await fetch('/api/import/undo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ importId, confirm: true }),
    });
    const result = await undoResponse.json();
    if (!undoResponse.ok) {
      setError(result.error ?? 'Undo failed.');
      return;
    }
    setSummary(`Undo complete: ${result.deleted} deleted, ${result.kept} kept.`);
    setHistoryRows((rows) => rows.filter((row) => row.id !== importId));
  }

  return (
    <div className="flex flex-col gap-8">
      <h1 className="text-xl font-semibold">Import</h1>
      {error ? <p role="alert" className="rounded bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">{error}</p> : null}
      {summary ? (
        <p className="rounded bg-green-50 px-3 py-2 text-sm text-green-800 dark:bg-green-950 dark:text-green-300">
          {summary} <a className="underline" href="/review">Go to the review queue</a>
        </p>
      ) : null}

      {simplefinManaged.length > 0 ? (
        <p className="rounded bg-slate-100 px-3 py-2 text-sm dark:bg-slate-900">
          {simplefinManaged.join(', ')} {simplefinManaged.length === 1 ? 'is' : 'are'} synced from SimpleFIN, so CSV import is turned off for{' '}
          {simplefinManaged.length === 1 ? 'it' : 'them'}. Unlink under <a className="underline" href="/settings/connections">Settings → Connections</a>{' '}
          to switch back to CSV.
        </p>
      ) : null}

      {accounts.length === 0 ? (
        <section className="flex flex-col gap-2 rounded border border-slate-200 p-4 text-sm dark:border-slate-800">
          <h2 className="font-medium">No accounts to import into yet</h2>
          <p className="text-slate-600 dark:text-slate-400">
            {simplefinManaged.length > 0
              ? 'Every account you have is synced from SimpleFIN, so there is nothing here to upload a CSV for. Add a CSV account to import one.'
              : 'A CSV has to land somewhere, so add the bank account first — name, type, and whether it is joint or one person’s.'}{' '}
            <a className="underline" href="/settings/accounts">
              Add a bank account
            </a>
            {' '}(Settings → Bank accounts).
          </p>
          <div className="flex flex-wrap items-end gap-3">
            <input type="file" accept=".csv,text/csv" disabled aria-label="Upload a CSV" className="text-sm" />
            <button type="button" disabled className="rounded bg-slate-900 px-3 py-2 text-white disabled:opacity-60 dark:bg-slate-100 dark:text-slate-900">
              Preview
            </button>
          </div>
        </section>
      ) : (
      <form action={upload} className="flex flex-wrap items-end gap-3 text-sm">
        <label className="flex flex-col gap-1">
          Account
          <select
            value={accountId}
            onChange={(e) => {
              const id = Number(e.target.value);
              setAccountId(id);
              // Switching accounts switches banks: the previous account's
              // remembered profile, its column mapping and any preview built
              // from it all belong to the file that is no longer selected.
              // Fall back to the first profile when this account has never
              // been imported into, rather than silently keeping the old one.
              const remembered = accounts.find((a) => a.id === id)?.importProfileId ?? profiles[0]?.id ?? 0;
              setProfileId(remembered);
              setMapping(profiles.find((p) => p.id === remembered)?.mapping ?? null);
              setPreview(null);
              setSummary(null);
              setError(null);
            }}
            className="rounded border px-2 py-1 dark:bg-slate-900"
          >
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          Import profile
          <select
            value={profileId}
            onChange={(e) => {
              const id = Number(e.target.value);
              setProfileId(id);
              setMapping(profiles.find((p) => p.id === id)?.mapping ?? null);
            }}
            className="rounded border px-2 py-1 dark:bg-slate-900"
          >
            {profiles.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.name}
                {profile.isBuiltin ? ' (built-in)' : ''}
              </option>
            ))}
          </select>
        </label>
        <input type="file" name="file" accept=".csv,text/csv" required className="text-sm" />
        <button type="submit" disabled={busy} className="rounded bg-slate-900 px-3 py-2 text-white disabled:opacity-60 dark:bg-slate-100 dark:text-slate-900">
          {busy ? 'Working…' : 'Preview'}
        </button>
      </form>
      )}

      {preview && mapping ? (
        <section className="flex flex-col gap-3">
          <h2 className="font-medium">
            Preview — {preview.totalRows} rows, {preview.duplicateCount} duplicates, {preview.errorCount} errors, encoding {preview.encoding}
          </h2>
          <MappingEditor mapping={mapping} onChange={(next) => void rePreview(next)} />
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b dark:border-slate-800">
                  <th className="py-1">Date</th>
                  <th>Description</th>
                  <th>Merchant</th>
                  <th className="text-right">Amount</th>
                  <th>Category</th>
                  <th>Flags</th>
                </tr>
              </thead>
              <tbody>
                {preview.rows.map((row) => (
                  <tr key={`${row.rowIndex}-${row.dedupHash}`} className={row.isDuplicate ? 'opacity-50' : ''}>
                    <td className="py-1">{row.date}</td>
                    <td>{row.rawDescription}</td>
                    <td>{row.normalizedMerchant}</td>
                    <td className="text-right">{formatCents(row.amountCents)}</td>
                    <td>{row.predictedCategoryName ?? '—'}{row.predictedSource === 'bayes' ? ' (guess)' : ''}</td>
                    <td>{[row.isDuplicate ? 'duplicate' : null, row.isTransfer ? 'transfer' : null].filter(Boolean).join(', ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {preview.errors.length > 0 ? (
            <details>
              <summary className="cursor-pointer text-sm">{preview.errors.length} rows could not be parsed</summary>
              <ul className="mt-2 list-inside list-disc text-xs">
                {preview.errors.map((rowError) => (
                  <li key={rowError.rowIndex}>
                    Row {rowError.rowIndex + 1}: {rowError.reason} — {rowError.cells.join(' | ')}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
          <button type="button" onClick={() => void commit()} disabled={busy} className="w-fit rounded bg-slate-900 px-3 py-2 text-sm text-white disabled:opacity-60 dark:bg-slate-100 dark:text-slate-900">
            Import {preview.totalRows - preview.duplicateCount} transactions
          </button>
        </section>
      ) : null}

      <section className="flex flex-col gap-2">
        <h2 className="font-medium">History</h2>
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b dark:border-slate-800">
              <th className="py-1">When</th>
              <th>Account</th>
              <th>File</th>
              <th>By</th>
              <th className="text-right">Added</th>
              <th className="text-right">Dupes</th>
              <th className="text-right">Errors</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {historyRows.map((row) => (
              <tr key={row.id} className="border-b border-slate-100 dark:border-slate-900">
                <td className="py-1">{row.createdAt.slice(0, 16).replace('T', ' ')}</td>
                <td>{row.accountName}</td>
                <td>{row.filename}</td>
                <td>{row.importedByName}</td>
                <td className="text-right">{row.rowsAdded}</td>
                <td className="text-right">{row.rowsDuplicate}</td>
                <td className="text-right">{row.rowsError}</td>
                <td>
                  <button type="button" onClick={() => void undo(row.id)} className="rounded border px-2 py-1 text-xs dark:border-slate-700">
                    Undo
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <p className="text-sm text-slate-600 dark:text-slate-400">
        Importing from a bank that is not listed? Either adjust the columns in the preview editor above (editing a built-in profile automatically saves a
        copy for this account and leaves the shared preset untouched), or <a className="underline" href="/import/wizard">set up a new bank profile from a
        sample file</a>.
      </p>
    </div>
  );
}

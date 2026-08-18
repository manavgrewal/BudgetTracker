'use client';

import { useState } from 'react';
import { MappingEditor } from '@/components/MappingEditor';
import { SubmitButton } from '@/components/SubmitButton';
import { ImportIcon } from '@/components/icons';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Money } from '@/components/ui/Money';
import { Notice } from '@/components/ui/Notice';
import { PageHeader } from '@/components/ui/PageHeader';
import { TableWrap } from '@/components/ui/Table';
import { Field, selectClass } from '@/components/ui/form';
import type { ImportMapping } from '@/lib/import/mapping';
import type { PreviewResult } from '@/lib/import/preview';
import type { ImportHistoryRow } from '@/lib/import/commit';

interface AccountOption { id: number; name: string; importProfileId: number | null }
interface ProfileOption { id: number; name: string; isBuiltin: boolean; mapping: ImportMapping }

/** Import really is a three-step sequence, so the numbers carry information here. */
function StepMark({ n, state = 'todo' }: { n: number; state?: 'todo' | 'active' }) {
  return (
    <span
      aria-hidden="true"
      className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
        state === 'active' ? 'bg-accent text-accent-fg' : 'bg-surface-2 text-subtle'
      }`}
    >
      {n}
    </span>
  );
}

function StepTitle({ n, state, children }: { n: number; state?: 'todo' | 'active'; children: React.ReactNode }) {
  return (
    <span className="flex items-center gap-2.5">
      <StepMark n={n} state={state} />
      {children}
    </span>
  );
}

const fileInputClass =
  'text-sm text-muted file:mr-3 file:rounded-md file:border-0 file:bg-accent-soft file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-accent-soft-fg';

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

  /**
   * The Preview button is guarded by SubmitButton's useFormStatus, not by `busy`.
   *
   * This is a form ACTION, and React 19 holds state updates made inside an async action
   * until that action settles — so the `setBusy(true)` that used to open this function
   * never rendered, and the button it was meant to disable stayed clickable for the whole
   * upload. useFormStatus reads the form's real pending state instead. `busy` is still the
   * right mechanism for commit(), rePreview() and undo(), which are plain onClick/onChange
   * handlers and therefore render their state updates immediately.
   */
  async function upload(formData: FormData) {
    setError(null);
    setSummary(null);
    formData.set('accountId', String(accountId));
    formData.set('profileId', String(profileId));
    const response = await fetch('/api/import/preview', { method: 'POST', body: formData });
    const body = await response.json();
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
    try {
      const response = await fetch('/api/import/preview', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ stagingId: preview.stagingId, filename: preview.filename, accountId, profileId, mapping: next }),
      });
      const body = await response.json();
      if (!response.ok) {
        setError(body.error ?? 'Preview failed');
        return;
      }
      setPreview(body as PreviewResult);
    } finally {
      setBusy(false);
    }
  }

  // The Import button is a plain onClick, not a form action, so `busy` really does render
  // here — but it has to be released in a `finally`: a thrown fetch (a dropped connection
  // mid-import is the realistic case) would otherwise leave the button disabled forever,
  // with rows possibly already committed and no way to find out from this screen.
  async function commit() {
    if (!preview || !mapping) return;
    setBusy(true);
    try {
      const response = await fetch('/api/import/commit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ stagingId: preview.stagingId, filename: preview.filename, accountId, profileId, mapping }),
      });
      const body = await response.json();
      if (!response.ok) {
        setError(body.error ?? 'Import failed');
        return;
      }
      setPreview(null);
      // The rows are always committed by this point, even when categorization
      // itself failed (flow.ts catches runEngine and reports engineFailed
      // instead of throwing) — they're categoryless, so the review queue
      // picks them up regardless of whether the engine ran.
      const base = body.engineFailed
        ? `${body.rowsAdded} imported, categorization failed — rows are in the review queue.`
        : `${body.rowsAdded} added, ${body.rowsDuplicate} duplicates skipped, ${body.rowsError} errors, ${body.needsReview} need review.`;
      // NEW-5 fix-round: applyLoanMatchers is internally guarded (MUST-13.5) the same way
      // runEngine is caught above, so a matcher failure never fails the import either — it
      // just needs the same honest note engineFailed already gets.
      setSummary(body.loanMatchFailed ? `${base} Loan payment matching failed for these rows.` : base);
    } finally {
      setBusy(false);
    }
  }

  // Undo is a two-request dance around a confirm() dialog, and the second request
  // deletes rows. Without a busy guard a double-click fires the whole sequence twice:
  // the second pass finds the import already gone and reports a confusing failure over
  // a successful undo. `busy` is released in a finally so an early return cannot strand
  // every other button on the page in a disabled state.
  async function undo(importId: number) {
    setError(null);
    setBusy(true);
    try {
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
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Import"
        description="Upload a statement, check what it found, then add it. Nothing is written until you say so."
        actions={
          <a href="/import/wizard" className="btn btn--secondary">
            Add a bank
          </a>
        }
      />

      {error ? <Notice tone="error">{error}</Notice> : null}
      {summary ? (
        <Notice tone="success">
          {summary}{' '}
          <a className="font-semibold underline underline-offset-2" href="/review">Go to the review queue</a>
        </Notice>
      ) : null}

      {simplefinManaged.length > 0 ? (
        <Notice tone="info">
          {simplefinManaged.join(', ')} {simplefinManaged.length === 1 ? 'is' : 'are'} synced from SimpleFIN, so CSV import is turned off for{' '}
          {simplefinManaged.length === 1 ? 'it' : 'them'}. Unlink under <a className="underline underline-offset-2" href="/settings/connections">Settings → Connections</a>{' '}
          to switch back to CSV.
        </Notice>
      ) : null}

      {accounts.length === 0 ? (
        <Card>
          <CardHeader
            title={<StepTitle n={1} state="active">No accounts to import into yet</StepTitle>}
            description={
              <>
                {simplefinManaged.length > 0
                  ? 'Every account you have is synced from SimpleFIN, so there is nothing here to upload a CSV for. Add a CSV account to import one.'
                  : 'A CSV has to land somewhere, so add the bank account first — name, type, and whether it is joint or one person’s.'}{' '}
                <a className="font-medium text-accent-text underline underline-offset-2" href="/settings/accounts">
                  Add a bank account
                </a>
                {' '}(Settings → Bank accounts).
              </>
            }
          />
          <CardBody>
            <div className="flex flex-wrap items-center gap-3">
              <input type="file" accept=".csv,text/csv" disabled aria-label="Upload a CSV" className={fileInputClass} />
              <button type="button" disabled className="btn btn--primary">
                Preview
              </button>
            </div>
          </CardBody>
        </Card>
      ) : (
        <Card>
          <CardHeader
            title={<StepTitle n={1} state="active">Choose a file</StepTitle>}
            description="Pick the account it belongs to and the profile that matches the bank's column layout."
          />
          <CardBody>
            <form action={upload} className="flex flex-wrap items-end gap-4">
              <Field label="Account">
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
                  className={selectClass}
                >
                  {accounts.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Import profile">
                <select
                  value={profileId}
                  onChange={(e) => {
                    const id = Number(e.target.value);
                    setProfileId(id);
                    setMapping(profiles.find((p) => p.id === id)?.mapping ?? null);
                  }}
                  className={selectClass}
                >
                  {profiles.map((profile) => (
                    <option key={profile.id} value={profile.id}>
                      {profile.name}
                      {profile.isBuiltin ? ' (built-in)' : ''}
                    </option>
                  ))}
                </select>
              </Field>
              <input type="file" name="file" accept=".csv,text/csv" required className={`${fileInputClass} py-2`} />
              <SubmitButton>Preview</SubmitButton>
            </form>
          </CardBody>
        </Card>
      )}

      {preview && mapping ? (
        <Card>
          <CardHeader
            title={
              <StepTitle n={2} state="active">
                Preview — {preview.totalRows} rows, {preview.duplicateCount} duplicates, {preview.errorCount} errors,
                {/* Rows dropped by the profile's skipRules never appear in the table below and
                    were counted nowhere on screen, so a mis-typed skip rule that swallowed half
                    the file looked exactly like a short file. */}
                {preview.skipped > 0 ? ` ${preview.skipped} skipped by profile rules,` : ''} encoding {preview.encoding}
              </StepTitle>
            }
            description="Wrong columns? Fix the mapping and the preview re-reads the same file."
          />
          <CardBody className="flex flex-col gap-4">
            <MappingEditor mapping={mapping} onChange={(next) => void rePreview(next)} />

            <TableWrap className="max-h-96 overflow-y-auto">
              <thead>
                <tr>
                  <th scope="col">Date</th>
                  <th scope="col">Description</th>
                  <th scope="col">Merchant</th>
                  <th scope="col" className="text-right">Amount</th>
                  <th scope="col">Category</th>
                  <th scope="col">Flags</th>
                </tr>
              </thead>
              <tbody>
                {preview.rows.map((row) => (
                  <tr key={`${row.rowIndex}-${row.dedupHash}`} className={row.isDuplicate ? 'opacity-50' : ''}>
                    <td className="tabnum whitespace-nowrap text-muted">{row.date}</td>
                    <td>{row.rawDescription}</td>
                    <td className="text-muted">{row.normalizedMerchant}</td>
                    <td className="text-right"><Money cents={row.amountCents} /></td>
                    <td className="text-muted">{row.predictedCategoryName ?? '—'}{row.predictedSource === 'bayes' ? ' (guess)' : ''}</td>
                    <td>
                      <span className="flex flex-wrap gap-1">
                        {row.isDuplicate ? <span className="badge badge--slate">duplicate</span> : null}
                        {row.isTransfer ? <span className="badge badge--blue">transfer</span> : null}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </TableWrap>

            {preview.errors.length > 0 ? (
              <details className="rounded-md border border-line bg-surface-2/50 px-3 py-2">
                <summary className="cursor-pointer text-sm font-medium text-ink">{preview.errors.length} rows could not be parsed</summary>
                <ul className="mt-2 list-inside list-disc text-xs text-muted">
                  {preview.errors.map((rowError) => (
                    <li key={rowError.rowIndex}>
                      Row {rowError.rowIndex + 1}: {rowError.reason} — {rowError.cells.join(' | ')}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}

            <div className="flex items-center gap-3 border-t border-line pt-4">
              <StepMark n={3} state="active" />
              <button type="button" onClick={() => void commit()} disabled={busy} className="btn btn--primary btn--lg">
                Import {preview.totalRows - preview.duplicateCount} transactions
              </button>
            </div>
          </CardBody>
        </Card>
      ) : null}

      <Card>
        <CardHeader title="History" description="Every import, and the button that takes one back out." />
        {historyRows.length === 0 ? (
          <EmptyState icon={ImportIcon} title="Nothing imported yet">
            Once you upload a statement it lands here, with an undo next to it.
          </EmptyState>
        ) : (
          <TableWrap bare>
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Account</th>
                <th scope="col">File</th>
                <th scope="col">By</th>
                <th scope="col" className="text-right">Added</th>
                <th scope="col" className="text-right">Dupes</th>
                <th scope="col" className="text-right">Errors</th>
                <th scope="col" />
              </tr>
            </thead>
            <tbody>
              {historyRows.map((row) => (
                <tr key={row.id}>
                  <td className="tabnum whitespace-nowrap text-muted">{row.createdAt.slice(0, 16).replace('T', ' ')}</td>
                  <td className="whitespace-nowrap">{row.accountName}</td>
                  <td className="font-mono text-xs">{row.filename}</td>
                  <td className="text-muted">{row.importedByName}</td>
                  <td className="tabnum text-right">{row.rowsAdded}</td>
                  <td className="tabnum text-right text-muted">{row.rowsDuplicate}</td>
                  <td className="tabnum text-right text-muted">{row.rowsError}</td>
                  <td className="text-right">
                    <button
                      type="button"
                      onClick={() => void undo(row.id)}
                      disabled={busy}
                      className="btn btn--secondary btn--sm"
                    >
                      Undo
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}
      </Card>

      <p className="text-sm text-muted">
        Importing from a bank that is not listed? Either adjust the columns in the preview editor above (editing a built-in profile automatically saves a
        copy for this account and leaves the shared preset untouched), or <a className="font-medium text-accent-text underline underline-offset-2" href="/import/wizard">set up a new bank profile from a
        sample file</a>.
      </p>
    </div>
  );
}

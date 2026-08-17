'use client';

import { useActionState, useState } from 'react';
import { FormError } from '@/components/FormError';
import { SubmitButton } from '@/components/SubmitButton';
import { ImportIcon } from '@/components/icons';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Notice } from '@/components/ui/Notice';
import { PageHeader } from '@/components/ui/PageHeader';
import { Field } from '@/components/ui/form';
import type { RestoreOutcome, RestoreRequest } from '@/lib/backup/restore';
import { runBackupNowAction, setRetentionAction, stageRestoreAction, type BackupActionState } from './actions';

const initial: BackupActionState = {};

function formatStamp(iso: string): string {
  return iso.slice(0, 16).replace('T', ' ');
}

/**
 * MUST-20.35 / MUST-20.30: an inline confirm panel, not `window.confirm` — the latter is
 * untestable in jsdom and cannot carry this much wording. Every phrase below is worded
 * distinctly enough that it cannot also match the "Restore and restart" submit button's own
 * label (which itself contains the word "restart").
 *
 * It REPLACES the row rather than expanding under it: this is a destructive step, and the
 * row's own Restore button has no business staying clickable behind the confirmation.
 */
function RestorePanel({
  backup,
  confirmed,
  onConfirmedChange,
  onCancel,
  action,
  disabled,
  error,
}: {
  backup: { name: string };
  confirmed: boolean;
  onConfirmedChange: (value: boolean) => void;
  onCancel: () => void;
  action: (formData: FormData) => void;
  disabled: boolean;
  error?: string;
}) {
  return (
    <div className="flex flex-col gap-3 border-l-2 border-warning bg-warning-soft/40 px-4 py-4 text-sm sm:px-5">
      <p className="text-ink">
        Restore <strong className="font-semibold">{backup.name}</strong>? This replaces all data currently in the app with the contents of
        that backup. The current database is kept as <code className="rounded bg-surface px-1 font-mono text-xs">data/budget.pre-restore-&lt;timestamp&gt;.db</code>.
      </p>
      <p className="text-xs text-muted">
        The app restarts to apply this. If your container has no restart policy (this install&apos;s{' '}
        <code className="font-mono">docker-compose.yml</code> ships <code className="font-mono">restart: unless-stopped</code>), the restore still takes effect
        the next time the app starts — nothing is lost, only the automatic part.
      </p>
      {/* IMPORTANT (review): a restore refusal (F5/F6/F7) must surface right where the admin is
          looking, not only in a top-level banner a stale retention/backup-now message could be
          masking. */}
      <FormError message={error} />
      <label className="flex items-center gap-2 text-ink">
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(event) => onConfirmedChange(event.target.checked)}
          disabled={disabled}
          className="accent-accent"
        />
        I understand this replaces the current data.
      </label>
      <form action={action} className="flex items-center gap-2">
        <input type="hidden" name="name" value={backup.name} />
        <input type="hidden" name="confirm" value={confirmed ? 'on' : ''} />
        <SubmitButton variant="danger" disabled={disabled || !confirmed}>Restore and restart</SubmitButton>
        <button type="button" onClick={onCancel} disabled={disabled} className="btn btn--secondary">
          Cancel
        </button>
      </form>
    </div>
  );
}

function ResultBanner({ result }: { result: RestoreOutcome }) {
  if (result.status === 'failed') {
    return <FormError message={result.error ?? 'The last restore failed.'} />;
  }
  return (
    <Notice tone="success">
      <p>
        Restored {result.sourceName} on {formatStamp(result.finishedAt)} — {result.receiptsRestored} receipt files
        restored.
        {/* M4 (review): a success outcome should never say "no safety copy" — that phrase implied
            nothing was replaced, contradicting the banner it sits in. Omit the clause instead. */}
        {result.safetyCopy ? <> The previous database was kept as {result.safetyCopy}.</> : null}
      </p>
    </Notice>
  );
}

export function BackupsClient({
  backups,
  retention,
  restore,
}: {
  backups: { name: string; bytes: number; modifiedAt: string }[];
  retention: number;
  restore: { staged: RestoreRequest | null; result: RestoreOutcome | null };
}) {
  const [retentionState, retentionAction] = useActionState(setRetentionAction, initial);
  const [restoreState, restoreAction] = useActionState(stageRestoreAction, initial);
  const [notice, setNotice] = useState<BackupActionState | null>(null);
  const [running, setRunning] = useState(false);
  const [openFor, setOpenFor] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);

  // MUST-20.30/20.35: once the stage succeeds the process is about to exit — nothing else on
  // the page is worth rendering, let alone clicking.
  if (restoreState.restarting) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader eyebrow="Settings" title="Backups" />
        <Notice tone="info" role="status">
          {restoreState.message}
        </Notice>
      </div>
    );
  }

  function openRow(name: string) {
    setOpenFor(name);
    setConfirmed(false);
  }
  function closeRow() {
    setOpenFor(null);
    setConfirmed(false);
  }

  const stagedElsewhere = restore.staged !== null;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Settings"
        title="Backups"
        description="A nightly archive of the database and every receipt, kept on this machine."
        actions={
          <a href="/api/backup/download" className="btn btn--primary">
            Download backup now
          </a>
        }
      />

      {/* IMPORTANT (review): restoreState.error is deliberately NOT included here — a stale
          retention/backup-now error would otherwise permanently mask a restore refusal. It is
          rendered inside RestorePanel instead, where the admin is actually looking. */}
      <FormError message={retentionState.error ?? notice?.error} />
      {retentionState.message ?? notice?.message ? (
        <Notice tone="success">{retentionState.message ?? notice?.message}</Notice>
      ) : null}
      {restore.result ? <ResultBanner result={restore.result} /> : null}
      {stagedElsewhere ? (
        <Notice tone="warning">A restore is staged and will be applied the next time the app starts.</Notice>
      ) : null}

      <Card>
        <CardHeader title="Schedule" description="The job runs at 02:00 local time." />
        <CardBody className="flex flex-wrap items-end gap-6">
          <form action={retentionAction} className="flex items-end gap-2">
            <Field label="Keep this many nightly backups">
              <input
                type="number"
                name="retention"
                min={1}
                max={365}
                defaultValue={retention}
                className="field-control w-24"
              />
            </Field>
            <SubmitButton>Save</SubmitButton>
          </form>
          <button
            type="button"
            disabled={running}
            onClick={async () => {
              setRunning(true);
              try {
                const result = await runBackupNowAction();
                setNotice(result);
              } finally {
                setRunning(false);
              }
            }}
            className="btn btn--secondary"
          >
            {running ? 'Running…' : 'Run the nightly job now'}
          </button>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Nightly history" description={`${backups.length} archive${backups.length === 1 ? '' : 's'} on disk.`} />
        {backups.length === 0 ? (
          <EmptyState icon={ImportIcon} title="No backups yet. The job runs at 02:00 local time.">
            You can also make one right now with Download backup now.
          </EmptyState>
        ) : (
          <ul className="border-t border-line text-sm">
            {backups.map((backup) => (
              <li key={backup.name} className="border-b border-line last:border-b-0">
                {openFor === backup.name ? (
                  <RestorePanel
                    backup={backup}
                    confirmed={confirmed}
                    onConfirmedChange={setConfirmed}
                    onCancel={closeRow}
                    action={restoreAction}
                    disabled={stagedElsewhere}
                    error={restoreState.error}
                  />
                ) : (
                  <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 sm:px-6">
                    <span className="font-mono text-xs text-ink">{backup.name}</span>
                    <span className="tabnum text-xs text-subtle">
                      {(backup.bytes / 1024 / 1024).toFixed(2)} MB · {backup.modifiedAt.slice(0, 16).replace('T', ' ')}
                    </span>
                    <button
                      type="button"
                      onClick={() => openRow(backup.name)}
                      disabled={stagedElsewhere}
                      className="btn btn--secondary btn--sm"
                    >
                      Restore
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <p className="text-xs text-subtle">
        Each backup is a <code className="font-mono">.tar.gz</code> archive containing the database and every receipt file, stored unencrypted
        under <code className="font-mono">/data/backups</code>. Older <code className="font-mono">.db</code> backups from v1.0.0 are still listed and still restore.
        Offsite copies now carry receipt photographs too — these can show names, addresses and partial card numbers, so
        for offsite copies, point Hyper Backup (or your NAS equivalent) at the <code className="font-mono">/data</code> share and enable its
        client-side encryption there. Restoring under a live SQLite connection is how you corrupt a database, which is
        why Restore above stages the request and restarts the app instead of restoring in place; the{' '}
        <code className="font-mono">restore-backup</code> command-line tool remains available as a fallback for when the app will not start
        at all.
      </p>
    </div>
  );
}

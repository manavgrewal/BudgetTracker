'use client';

import { useActionState, useState } from 'react';
import { FormError } from '@/components/FormError';
import { SubmitButton } from '@/components/SubmitButton';
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
    <div className="flex flex-col gap-2 py-2 text-sm">
      <p>
        Restore <strong>{backup.name}</strong>? This replaces all data currently in the app with the contents of
        that backup. The current database is kept as <code>data/budget.pre-restore-&lt;timestamp&gt;.db</code>.
      </p>
      <p className="text-xs text-slate-500 dark:text-slate-400">
        The app restarts to apply this. If your container has no restart policy (this install's{' '}
        <code>docker-compose.yml</code> ships <code>restart: unless-stopped</code>), the restore still takes effect
        the next time the app starts — nothing is lost, only the automatic part.
      </p>
      {/* IMPORTANT (review): a restore refusal (F5/F6/F7) must surface right where the admin is
          looking, not only in a top-level banner a stale retention/backup-now message could be
          masking. */}
      <FormError message={error} />
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(event) => onConfirmedChange(event.target.checked)}
          disabled={disabled}
        />
        I understand this replaces the current data.
      </label>
      <form action={action} className="flex items-center gap-2">
        <input type="hidden" name="name" value={backup.name} />
        <input type="hidden" name="confirm" value={confirmed ? 'on' : ''} />
        <SubmitButton disabled={disabled || !confirmed}>Restore and restart</SubmitButton>
        <button
          type="button"
          onClick={onCancel}
          disabled={disabled}
          className="rounded border px-3 py-2 disabled:opacity-60 dark:border-slate-700"
        >
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
    <p className="rounded-md bg-green-50 px-3 py-2 text-sm text-green-800 dark:bg-green-950 dark:text-green-300">
      Restored {result.sourceName} on {formatStamp(result.finishedAt)} — {result.receiptsRestored} receipt files
      restored.
      {/* M4 (review): a success outcome should never say "no safety copy" — that phrase implied
          nothing was replaced, contradicting the banner it sits in. Omit the clause instead. */}
      {result.safetyCopy ? <> The previous database was kept as {result.safetyCopy}.</> : null}
    </p>
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
        <h1 className="text-xl font-semibold">Backups</h1>
        <p
          role="status"
          className="rounded-md bg-blue-50 px-3 py-2 text-sm text-blue-800 dark:bg-blue-950 dark:text-blue-200"
        >
          {restoreState.message}
        </p>
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
      <h1 className="text-xl font-semibold">Backups</h1>
      {/* IMPORTANT (review): restoreState.error is deliberately NOT included here — a stale
          retention/backup-now error would otherwise permanently mask a restore refusal. It is
          rendered inside RestorePanel instead, where the admin is actually looking. */}
      <FormError message={retentionState.error ?? notice?.error} />
      {retentionState.message ?? notice?.message ? (
        <p className="text-sm text-green-700 dark:text-green-400">{retentionState.message ?? notice?.message}</p>
      ) : null}
      {restore.result ? <ResultBanner result={restore.result} /> : null}
      {stagedElsewhere ? (
        <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-950 dark:text-amber-200">
          A restore is staged and will be applied the next time the app starts.
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-3 text-sm">
        <a href="/api/backup/download" className="rounded bg-slate-900 px-3 py-2 text-white dark:bg-slate-100 dark:text-slate-900">
          Download backup now
        </a>
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
          className="rounded border px-3 py-2 disabled:opacity-60 dark:border-slate-700"
        >
          {running ? 'Running…' : 'Run the nightly job now'}
        </button>
      </div>

      <form action={retentionAction} className="flex items-end gap-2 text-sm">
        <label className="flex flex-col gap-1">
          Keep this many nightly backups
          <input type="number" name="retention" min={1} max={365} defaultValue={retention} className="w-24 rounded border px-2 py-1 dark:bg-slate-900" />
        </label>
        <SubmitButton>Save</SubmitButton>
      </form>

      <section className="flex flex-col gap-2">
        <h2 className="font-medium">Nightly history</h2>
        {backups.length === 0 ? <p className="text-sm text-slate-500">No backups yet. The job runs at 02:00 local time.</p> : null}
        <ul className="text-sm">
          {backups.map((backup) => (
            <li key={backup.name} className="border-b border-slate-100 dark:border-slate-900">
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
                <div className="flex items-center justify-between gap-3 py-1">
                  <span>{backup.name}</span>
                  <span className="tabular-nums">
                    {(backup.bytes / 1024 / 1024).toFixed(2)} MB · {backup.modifiedAt.slice(0, 16).replace('T', ' ')}
                  </span>
                  <button
                    type="button"
                    onClick={() => openRow(backup.name)}
                    disabled={stagedElsewhere}
                    className="rounded border px-3 py-1 disabled:opacity-60 dark:border-slate-700"
                  >
                    Restore
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      </section>

      <p className="text-xs text-slate-500 dark:text-slate-400">
        Each backup is a <code>.tar.gz</code> archive containing the database and every receipt file, stored unencrypted
        under <code>/data/backups</code>. Older <code>.db</code> backups from v1.0.0 are still listed and still restore.
        Offsite copies now carry receipt photographs too — these can show names, addresses and partial card numbers, so
        for offsite copies, point Hyper Backup (or your NAS equivalent) at the <code>/data</code> share and enable its
        client-side encryption there. Restoring under a live SQLite connection is how you corrupt a database, which is
        why Restore above stages the request and restarts the app instead of restoring in place; the{' '}
        <code>restore-backup</code> command-line tool remains available as a fallback for when the app will not start
        at all.
      </p>
    </div>
  );
}

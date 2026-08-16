'use client';

import { useActionState, useState } from 'react';
import { FormError } from '@/components/FormError';
import { SubmitButton } from '@/components/SubmitButton';
import { runBackupNowAction, setRetentionAction, type BackupActionState } from './actions';

const initial: BackupActionState = {};

export function BackupsClient({
  backups,
  retention,
}: {
  backups: { name: string; bytes: number; modifiedAt: string }[];
  retention: number;
}) {
  const [state, action] = useActionState(setRetentionAction, initial);
  const [notice, setNotice] = useState<BackupActionState | null>(null);
  const [running, setRunning] = useState(false);

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-xl font-semibold">Backups</h1>
      <FormError message={state.error ?? notice?.error} />
      {state.message ?? notice?.message ? (
        <p className="text-sm text-green-700 dark:text-green-400">{state.message ?? notice?.message}</p>
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

      <form action={action} className="flex items-end gap-2 text-sm">
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
            <li key={backup.name} className="flex justify-between border-b border-slate-100 py-1 dark:border-slate-900">
              <span>{backup.name}</span>
              <span className="tabular-nums">
                {(backup.bytes / 1024 / 1024).toFixed(2)} MB · {backup.modifiedAt.slice(0, 16).replace('T', ' ')}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <p className="text-xs text-slate-500 dark:text-slate-400">
        Backups are unencrypted SQLite copies stored under <code>/data/backups</code>. For offsite copies, point Hyper Backup (or your NAS
        equivalent) at the <code>/data</code> share and enable its client-side encryption there.
      </p>
    </div>
  );
}

'use client';

import { useActionState, useState } from 'react';
import { MappingEditor } from '@/components/MappingEditor';
import { FormError } from '@/components/FormError';
import { SubmitButton } from '@/components/SubmitButton';
import type { ImportMapping } from '@/lib/import/mapping';
import { saveWizardProfileAction, type WizardState } from '../actions';

const initial: WizardState = {};

export function WizardClient({ starterMapping }: { starterMapping: ImportMapping }) {
  const [mapping, setMapping] = useState<ImportMapping>(starterMapping);
  const [rows, setRows] = useState<string[][] | null>(null);
  const [stagingId, setStagingId] = useState<string>('');
  const [encoding, setEncoding] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [state, save] = useActionState(saveWizardProfileAction, initial);

  async function upload(formData: FormData) {
    setError(null);
    const response = await fetch('/api/import/raw-preview', { method: 'POST', body: formData });
    const body = await response.json();
    if (!response.ok) {
      setError(body.error ?? 'Upload failed');
      return;
    }
    setRows(body.rows as string[][]);
    setStagingId(body.stagingId as string);
    setEncoding(body.encoding as string);
  }

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-xl font-semibold">Add a bank</h1>
      <p className="text-sm text-slate-600 dark:text-slate-400">
        Upload a sample export from the bank. The first rows are shown with their column numbers so you can say which column holds the date, the
        description and the amount. Nothing is imported here — this only saves a reusable profile.
      </p>
      <FormError message={error ?? state.error} />
      {state.message ? <p className="text-sm text-green-700 dark:text-green-400">{state.message}</p> : null}

      <form action={upload} className="flex items-end gap-3 text-sm">
        <input type="file" name="file" accept=".csv,text/csv" required />
        <button type="submit" className="rounded bg-slate-900 px-3 py-2 text-white dark:bg-slate-100 dark:text-slate-900">Show the first rows</button>
      </form>

      {rows ? (
        <>
          <p className="text-xs text-slate-500">Detected encoding: {encoding}</p>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b dark:border-slate-800">
                  {(rows[0] ?? []).map((_, index) => (
                    <th key={index} className="py-1">col {index}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, rowIndex) => (
                  <tr key={rowIndex} className="border-b border-slate-100 dark:border-slate-900">
                    {row.map((cell, cellIndex) => (
                      <td key={cellIndex} className="max-w-40 truncate py-1 pr-2">{cell}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <MappingEditor mapping={mapping} onChange={setMapping} />

          <form action={save} className="flex max-w-md flex-col gap-3 text-sm">
            <input type="hidden" name="mapping" value={JSON.stringify(mapping)} />
            <input type="hidden" name="stagingId" value={stagingId} />
            <input name="name" placeholder="Profile name, e.g. Tangerine Chequing" required className="rounded border px-2 py-1 dark:bg-slate-900" />
            <input name="institution" placeholder="Institution, e.g. Tangerine" required className="rounded border px-2 py-1 dark:bg-slate-900" />
            <SubmitButton>Save profile</SubmitButton>
          </form>
        </>
      ) : null}
    </div>
  );
}

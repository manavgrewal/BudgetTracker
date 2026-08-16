'use client';

import { useActionState, useState } from 'react';
import Link from 'next/link';
import { FormError } from '@/components/FormError';
import { SubmitButton } from '@/components/SubmitButton';
import { saveSetupAccountsAction, type SetupAccountsState } from './actions';

interface Row {
  name: string;
  type: 'chequing' | 'credit' | 'cash';
  owner: string;
}

const initialState: SetupAccountsState = {};
const emptyRow: Row = { name: '', type: 'chequing', owner: '' };
const inputClass = 'rounded-md border border-slate-300 px-3 py-2 dark:border-slate-700 dark:bg-slate-900';

export function AccountsStep({ admin }: { admin: { id: number; name: string } }) {
  const [state, action] = useActionState(saveSetupAccountsAction, initialState);
  const [rows, setRows] = useState<Row[]>([{ ...emptyRow }]);

  function update(index: number, patch: Partial<Row>) {
    setRows((current) => current.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }

  // Blank rows are dropped rather than rejected: the last row is usually a
  // half-finished afterthought, and this step is optional anyway.
  const filled = rows.filter((row) => row.name.trim().length > 0);

  return (
    <form action={action} className="mx-auto mt-16 flex w-full max-w-xl flex-col gap-4 px-4">
      <h1 className="text-2xl font-semibold">Add your bank accounts</h1>
      <p className="text-sm text-slate-600 dark:text-slate-400">
        Optional, and you can do it later under <strong>Settings → Bank accounts</strong>. Every CSV import lands in one of these, so it is the
        one thing worth doing now. One row per bank account.
      </p>
      <FormError message={state.error} />

      <input type="hidden" name="accounts" value={JSON.stringify(filled)} />

      <div className="flex flex-col gap-3">
        {rows.map((row, index) => (
          <div key={index} className="flex flex-wrap items-end gap-2">
            <label className="flex flex-1 flex-col gap-1 text-sm">
              Name
              <input
                value={row.name}
                onChange={(event) => update(index, { name: event.target.value })}
                placeholder="Joint Chequing"
                aria-label={`Account ${index + 1} name`}
                className={inputClass}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              Type
              <select
                value={row.type}
                onChange={(event) => update(index, { type: event.target.value as Row['type'] })}
                aria-label={`Account ${index + 1} type`}
                className={inputClass}
              >
                <option value="chequing">Chequing</option>
                <option value="credit">Credit</option>
                <option value="cash">Cash</option>
              </select>
            </label>
            <label className="flex flex-col gap-1 text-sm">
              Owner
              <select
                value={row.owner}
                onChange={(event) => update(index, { owner: event.target.value })}
                aria-label={`Account ${index + 1} owner`}
                className={inputClass}
              >
                <option value="">Joint</option>
                <option value={admin.id}>{admin.name}</option>
              </select>
            </label>
            {rows.length > 1 ? (
              <button
                type="button"
                onClick={() => setRows((current) => current.filter((_, i) => i !== index))}
                className="rounded border border-slate-300 px-3 py-2 text-sm dark:border-slate-700"
              >
                Remove
              </button>
            ) : null}
          </div>
        ))}
      </div>

      <button
        type="button"
        onClick={() => setRows((current) => [...current, { ...emptyRow }])}
        className="w-fit rounded border border-slate-300 px-3 py-2 text-sm dark:border-slate-700"
      >
        Add another
      </button>

      <div className="flex items-center gap-4">
        <SubmitButton>{filled.length === 0 ? 'Continue' : `Create ${filled.length} account${filled.length === 1 ? '' : 's'}`}</SubmitButton>
        <Link href="/dashboard" className="text-sm underline">
          Skip for now
        </Link>
      </div>
    </form>
  );
}

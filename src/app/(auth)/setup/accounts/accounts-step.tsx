'use client';

import { useActionState, useState } from 'react';
import Link from 'next/link';
import { FormError } from '@/components/FormError';
import { SubmitButton } from '@/components/SubmitButton';
import { AuthCard } from '@/components/auth/AuthCard';
import { CloseIcon } from '@/components/icons';
import { Field, inputClass, selectClass } from '@/components/ui/form';
import { saveSetupAccountsAction, type SetupAccountsState } from './actions';

interface Row {
  name: string;
  type: 'chequing' | 'credit' | 'cash';
  owner: string;
}

const initialState: SetupAccountsState = {};
const emptyRow: Row = { name: '', type: 'chequing', owner: '' };

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
    <AuthCard
      title="Add your bank accounts"
      width="lg"
      description={
        <>
          Optional, and you can do it later under <strong className="font-semibold text-ink">Settings → Bank accounts</strong>.
          Every CSV import lands in one of these, so it is the one thing worth doing now. One row per bank account.
        </>
      }
      footer="Step 2 of 2"
    >
      <form action={action} className="flex flex-col gap-5">
        <FormError message={state.error} />

        <input type="hidden" name="accounts" value={JSON.stringify(filled)} />

        <div className="flex flex-col gap-3">
          {rows.map((row, index) => (
            <div
              key={index}
              className="flex flex-wrap items-end gap-3 rounded-md border border-line bg-surface-2/50 p-3"
            >
              <Field label="Name" className="min-w-[10rem] flex-1">
                <input
                  value={row.name}
                  onChange={(event) => update(index, { name: event.target.value })}
                  placeholder="Joint Chequing"
                  aria-label={`Account ${index + 1} name`}
                  className={inputClass}
                />
              </Field>
              <Field label="Type">
                <select
                  value={row.type}
                  onChange={(event) => update(index, { type: event.target.value as Row['type'] })}
                  aria-label={`Account ${index + 1} type`}
                  className={selectClass}
                >
                  <option value="chequing">Chequing</option>
                  <option value="credit">Credit</option>
                  <option value="cash">Cash</option>
                </select>
              </Field>
              <Field label="Owner">
                <select
                  value={row.owner}
                  onChange={(event) => update(index, { owner: event.target.value })}
                  aria-label={`Account ${index + 1} owner`}
                  className={selectClass}
                >
                  <option value="">Joint</option>
                  <option value={admin.id}>{admin.name}</option>
                </select>
              </Field>
              {rows.length > 1 ? (
                <button
                  type="button"
                  onClick={() => setRows((current) => current.filter((_, i) => i !== index))}
                  className="btn btn--ghost p-2"
                  aria-label={`Remove account ${index + 1}`}
                >
                  <CloseIcon className="h-4 w-4" />
                </button>
              ) : null}
            </div>
          ))}
        </div>

        <button
          type="button"
          onClick={() => setRows((current) => [...current, { ...emptyRow }])}
          className="btn btn--secondary btn--sm w-fit"
        >
          Add another
        </button>

        <div className="flex flex-wrap items-center gap-4 border-t border-line pt-5">
          <SubmitButton size="lg">
            {filled.length === 0 ? 'Continue' : `Create ${filled.length} account${filled.length === 1 ? '' : 's'}`}
          </SubmitButton>
          <Link href="/dashboard" className="text-sm text-muted underline underline-offset-2 hover:text-ink">
            Skip for now
          </Link>
        </div>
      </form>
    </AuthCard>
  );
}

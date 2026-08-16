'use client';

import { useActionState } from 'react';
import { FormError } from '@/components/FormError';
import { SubmitButton } from '@/components/SubmitButton';
import {
  createAccountAction,
  renameAccountAction,
  setAccountActiveAction,
  setAccountOwnerAction,
  type AccountsFormState,
} from './actions';

export interface AccountRow {
  id: number;
  name: string;
  institution: string;
  type: 'chequing' | 'credit' | 'cash';
  ownerUserId: number | null;
  isActive: boolean;
  isSimplefinManaged: boolean;
}

export interface PersonRow {
  id: number;
  name: string;
  isActive: boolean;
}

const initialState: AccountsFormState = {};

const inputClass = 'rounded-md border border-slate-300 px-3 py-2 dark:border-slate-700 dark:bg-slate-900';
const smallInputClass = 'rounded border border-slate-300 px-2 py-1 dark:border-slate-700 dark:bg-slate-900';
const buttonClass = 'rounded border border-slate-300 px-2 py-1 dark:border-slate-700';

export function AccountsManager({ accounts, people }: { accounts: AccountRow[]; people: PersonRow[] }) {
  const [createState, create] = useActionState(createAccountAction, initialState);
  const [renameState, rename] = useActionState(renameAccountAction, initialState);
  const [ownerState, setOwner] = useActionState(setAccountOwnerAction, initialState);
  const [activeState, setActive] = useActionState(setAccountActiveAction, initialState);

  const rowError = renameState.error ?? ownerState.error ?? activeState.error;
  const rowMessage = renameState.message ?? ownerState.message ?? activeState.message;

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold">Bank accounts</h1>
        <p className="text-sm text-slate-600 dark:text-slate-400">
          Every import needs an account to land in. Add one per bank account you export a CSV from (or plan to link to SimpleFIN). Accounts are
          deactivated, never deleted — the transactions and import history that point at them have to keep working.
        </p>
      </div>

      <form action={create} className="flex max-w-md flex-col gap-3">
        <h2 className="text-sm font-medium">Add an account</h2>
        <FormError message={createState.error} />
        {createState.message ? <p className="text-sm text-green-700 dark:text-green-400">{createState.message}</p> : null}
        <input name="name" placeholder="Name (for example: Joint Chequing)" required className={inputClass} />
        <input name="institution" placeholder="Institution (optional)" className={inputClass} />
        <label className="flex flex-col gap-1 text-sm">
          Type
          <select name="type" defaultValue="chequing" className={inputClass}>
            <option value="chequing">Chequing</option>
            <option value="credit">Credit</option>
            <option value="cash">Cash</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Owner
          <select name="owner" defaultValue="" className={inputClass}>
            <option value="">Joint (household)</option>
            {people.map((person) => (
              <option key={person.id} value={person.id}>
                {person.name}
              </option>
            ))}
          </select>
        </label>
        <SubmitButton>Add account</SubmitButton>
      </form>

      <FormError message={rowError} />
      {rowMessage ? <p className="text-sm text-green-700 dark:text-green-400">{rowMessage}</p> : null}

      {accounts.length === 0 ? (
        <p className="text-sm text-slate-600 dark:text-slate-400">No accounts yet. Add the first one above.</p>
      ) : (
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-slate-200 dark:border-slate-800">
              <th className="py-2">Name</th>
              <th>Institution</th>
              <th>Type</th>
              <th>Owner</th>
              <th>Source</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {accounts.map((account) => (
              <tr key={account.id} className="border-b border-slate-100 align-top dark:border-slate-900">
                <td className="py-2">{account.name}</td>
                <td>{account.institution === '' ? '—' : account.institution}</td>
                <td>{account.type}</td>
                <td>{account.ownerUserId === null ? 'Joint' : (people.find((p) => p.id === account.ownerUserId)?.name ?? 'Joint')}</td>
                <td>
                  <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs dark:bg-slate-800">
                    {account.isSimplefinManaged ? 'SimpleFIN' : 'CSV'}
                  </span>
                </td>
                <td>{account.isActive ? 'active' : 'deactivated'}</td>
                <td className="flex flex-wrap gap-2 py-2">
                  <form action={rename} className="flex gap-1">
                    <input type="hidden" name="accountId" value={account.id} />
                    <input name="name" defaultValue={account.name} aria-label={`Rename ${account.name}`} className={`w-40 ${smallInputClass}`} />
                    <button type="submit" className={buttonClass}>
                      Rename
                    </button>
                  </form>
                  <form action={setOwner} className="flex gap-1">
                    <input type="hidden" name="accountId" value={account.id} />
                    <select
                      name="owner"
                      defaultValue={account.ownerUserId === null ? '' : String(account.ownerUserId)}
                      aria-label={`Owner of ${account.name}`}
                      className={smallInputClass}
                    >
                      <option value="">Joint</option>
                      {people.map((person) => (
                        <option key={person.id} value={person.id}>
                          {person.name}
                        </option>
                      ))}
                    </select>
                    <button type="submit" className={buttonClass}>
                      Set owner
                    </button>
                  </form>
                  <form action={setActive}>
                    <input type="hidden" name="accountId" value={account.id} />
                    <input type="hidden" name="active" value={account.isActive ? '0' : '1'} />
                    <button type="submit" className={buttonClass}>
                      {account.isActive ? 'Deactivate' : 'Reactivate'}
                    </button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

'use client';

import { useActionState } from 'react';
import { FormError } from '@/components/FormError';
import { SubmitButton } from '@/components/SubmitButton';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Notice } from '@/components/ui/Notice';
import { PageHeader } from '@/components/ui/PageHeader';
import { TableWrap } from '@/components/ui/Table';
import { Field, inputClass, selectClass } from '@/components/ui/form';
import { SettingsIcon } from '@/components/icons';
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

const rowInput = 'field-control w-auto px-2 py-1 text-xs';
const rowButton = 'btn btn--secondary btn--sm';

export function AccountsManager({ accounts, people }: { accounts: AccountRow[]; people: PersonRow[] }) {
  const [createState, create] = useActionState(createAccountAction, initialState);
  const [renameState, rename] = useActionState(renameAccountAction, initialState);
  const [ownerState, setOwner] = useActionState(setAccountOwnerAction, initialState);
  const [activeState, setActive] = useActionState(setAccountActiveAction, initialState);

  const rowError = renameState.error ?? ownerState.error ?? activeState.error;
  const rowMessage = renameState.message ?? ownerState.message ?? activeState.message;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Settings"
        title="Bank accounts"
        description="Every import needs an account to land in. Add one per bank account you export a CSV from (or plan to link to SimpleFIN). Accounts are deactivated, never deleted — the transactions and import history that point at them have to keep working."
      />

      <Card className="max-w-md">
        <CardHeader title="Add an account" />
        <CardBody>
          <form action={create} className="flex flex-col gap-4">
            <FormError message={createState.error} />
            {createState.message ? <Notice tone="success">{createState.message}</Notice> : null}
            <Field label="Name">
              <input name="name" placeholder="Joint Chequing" required className={inputClass} />
            </Field>
            <Field label="Institution (optional)">
              <input name="institution" placeholder="TD" className={inputClass} />
            </Field>
            <Field label="Type">
              <select name="type" defaultValue="chequing" className={selectClass}>
                <option value="chequing">Chequing</option>
                <option value="credit">Credit</option>
                <option value="cash">Cash</option>
              </select>
            </Field>
            <Field label="Owner">
              <select name="owner" defaultValue="" className={selectClass}>
                <option value="">Joint (household)</option>
                {people.map((person) => (
                  <option key={person.id} value={person.id}>
                    {person.name}
                  </option>
                ))}
              </select>
            </Field>
            <SubmitButton className="w-fit">Add account</SubmitButton>
          </form>
        </CardBody>
      </Card>

      <FormError message={rowError} />
      {rowMessage ? <Notice tone="success">{rowMessage}</Notice> : null}

      <Card>
        <CardHeader title="Accounts" description={`${accounts.length} account${accounts.length === 1 ? '' : 's'}.`} />
        {accounts.length === 0 ? (
          <EmptyState icon={SettingsIcon} title="No accounts yet. Add the first one above." />
        ) : (
          <TableWrap bare>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Institution</th>
                <th scope="col">Type</th>
                <th scope="col">Owner</th>
                <th scope="col">Source</th>
                <th scope="col">Status</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((account) => (
                <tr key={account.id} className="align-top">
                  <td className="font-medium text-ink">{account.name}</td>
                  <td className="text-muted">{account.institution === '' ? '—' : account.institution}</td>
                  <td className="text-muted capitalize">{account.type}</td>
                  <td className="text-muted">
                    {account.ownerUserId === null ? 'Joint' : (people.find((p) => p.id === account.ownerUserId)?.name ?? 'Joint')}
                  </td>
                  <td>
                    <span className={account.isSimplefinManaged ? 'badge badge--blue' : 'badge badge--slate'}>
                      {account.isSimplefinManaged ? 'SimpleFIN' : 'CSV'}
                    </span>
                  </td>
                  <td>
                    <span className={account.isActive ? 'badge badge--green' : 'badge badge--muted'}>
                      {account.isActive ? 'active' : 'deactivated'}
                    </span>
                  </td>
                  <td>
                    <div className="flex flex-wrap gap-2">
                      <form action={rename} className="flex gap-1">
                        <input type="hidden" name="accountId" value={account.id} />
                        <input name="name" defaultValue={account.name} aria-label={`Rename ${account.name}`} className={`w-36 ${rowInput}`} />
                        <button type="submit" className={rowButton}>
                          Rename
                        </button>
                      </form>
                      <form action={setOwner} className="flex gap-1">
                        <input type="hidden" name="accountId" value={account.id} />
                        <select
                          name="owner"
                          defaultValue={account.ownerUserId === null ? '' : String(account.ownerUserId)}
                          aria-label={`Owner of ${account.name}`}
                          className={rowInput}
                        >
                          <option value="">Joint</option>
                          {people.map((person) => (
                            <option key={person.id} value={person.id}>
                              {person.name}
                            </option>
                          ))}
                        </select>
                        <button type="submit" className={rowButton}>
                          Set owner
                        </button>
                      </form>
                      <form action={setActive}>
                        <input type="hidden" name="accountId" value={account.id} />
                        <input type="hidden" name="active" value={account.isActive ? '0' : '1'} />
                        <button type="submit" className={rowButton}>
                          {account.isActive ? 'Deactivate' : 'Reactivate'}
                        </button>
                      </form>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}
      </Card>
    </div>
  );
}

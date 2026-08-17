'use client';

import { useActionState } from 'react';
import { FormError } from '@/components/FormError';
import { SubmitButton } from '@/components/SubmitButton';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Notice } from '@/components/ui/Notice';
import { PageHeader } from '@/components/ui/PageHeader';
import { TableWrap } from '@/components/ui/Table';
import { Field, inputClass, selectClass } from '@/components/ui/form';
import { createUserAction, resetMfaAction, resetPasswordAction, setActiveAction, type UsersFormState } from './actions';
import type { UserRecord } from '@/lib/auth/users';

const initialState: UsersFormState = {};

const rowInput = 'field-control w-auto px-2 py-1 text-xs';
const rowButton = 'btn btn--secondary btn--sm';

export function UsersManager({ users }: { users: UserRecord[] }) {
  const [createState, create] = useActionState(createUserAction, initialState);
  const [rowState, rowAction] = useActionState(setActiveAction, initialState);
  const [pwState, resetPassword] = useActionState(resetPasswordAction, initialState);
  const [mfaState, resetMfa] = useActionState(resetMfaAction, initialState);

  const rowMessage = rowState.message ?? pwState.message ?? mfaState.message;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Settings"
        title="Users"
        description="Everyone who can sign in. Members see the whole household; admins can also change these settings."
      />

      <Card className="max-w-md">
        <CardHeader title="Add a user" description="They pick their own password the first time they sign in." />
        <CardBody>
          <form action={create} className="flex flex-col gap-4">
            <FormError message={createState.error} />
            {createState.message ? <Notice tone="success">{createState.message}</Notice> : null}
            <Field label="Name">
              <input name="name" placeholder="Alex" required className={inputClass} />
            </Field>
            <Field label="Username">
              <input name="username" placeholder="alex" required className={inputClass} />
            </Field>
            <Field label="Temporary password" hint="At least 10 characters.">
              <input name="password" placeholder="At least 10 characters" required className={inputClass} />
            </Field>
            <Field label="Role">
              <select name="role" defaultValue="member" className={selectClass}>
                <option value="member">Member</option>
                <option value="admin">Admin</option>
              </select>
            </Field>
            <SubmitButton className="w-fit">Create user</SubmitButton>
          </form>
        </CardBody>
      </Card>

      <FormError message={rowState.error ?? pwState.error ?? mfaState.error} />
      {rowMessage ? <Notice tone="success">{rowMessage}</Notice> : null}

      <Card>
        <CardHeader title="Household" description={`${users.length} account${users.length === 1 ? '' : 's'}.`} />
        <TableWrap bare>
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Username</th>
              <th scope="col">Role</th>
              <th scope="col">MFA</th>
              <th scope="col">Status</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {users.map((user) => (
              <tr key={user.id} className="align-top">
                <td className="font-medium text-ink">{user.name}</td>
                <td className="font-mono text-xs text-muted">{user.username}</td>
                <td>
                  <span className={user.role === 'admin' ? 'badge badge--accent' : 'badge badge--slate'}>{user.role}</span>
                </td>
                <td>
                  <span className={user.totpEnabled ? 'badge badge--green' : 'badge badge--muted'}>
                    {user.totpEnabled ? 'on' : 'off'}
                  </span>
                </td>
                <td>
                  <span className={user.isActive ? 'badge badge--green' : 'badge badge--muted'}>
                    {user.isActive ? 'active' : 'deactivated'}
                  </span>
                </td>
                <td>
                  <div className="flex flex-wrap gap-2">
                    <form action={rowAction}>
                      <input type="hidden" name="userId" value={user.id} />
                      <input type="hidden" name="active" value={user.isActive ? '0' : '1'} />
                      <button type="submit" className={rowButton}>
                        {user.isActive ? 'Deactivate' : 'Reactivate'}
                      </button>
                    </form>
                    <form action={resetPassword} className="flex gap-1">
                      <input type="hidden" name="userId" value={user.id} />
                      <input
                        name="password"
                        placeholder="New password"
                        aria-label={`New password for ${user.name}`}
                        className={`w-36 ${rowInput}`}
                      />
                      <button type="submit" className={rowButton}>
                        Reset password
                      </button>
                    </form>
                    <form action={resetMfa}>
                      <input type="hidden" name="userId" value={user.id} />
                      <button type="submit" className={rowButton}>
                        Reset MFA
                      </button>
                    </form>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      </Card>
    </div>
  );
}

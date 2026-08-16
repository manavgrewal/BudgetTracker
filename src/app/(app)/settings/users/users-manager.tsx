'use client';

import { useActionState } from 'react';
import { FormError } from '@/components/FormError';
import { SubmitButton } from '@/components/SubmitButton';
import { createUserAction, resetMfaAction, resetPasswordAction, setActiveAction, type UsersFormState } from './actions';
import type { UserRecord } from '@/lib/auth/users';

const initialState: UsersFormState = {};

export function UsersManager({ users }: { users: UserRecord[] }) {
  const [createState, create] = useActionState(createUserAction, initialState);
  const [rowState, rowAction] = useActionState(setActiveAction, initialState);
  const [pwState, resetPassword] = useActionState(resetPasswordAction, initialState);
  const [mfaState, resetMfa] = useActionState(resetMfaAction, initialState);

  return (
    <div className="flex flex-col gap-8">
      <h1 className="text-xl font-semibold">Users</h1>

      <form action={create} className="flex max-w-md flex-col gap-3">
        <h2 className="text-sm font-medium">Add a user</h2>
        <FormError message={createState.error} />
        {createState.message ? <p className="text-sm text-green-700 dark:text-green-400">{createState.message}</p> : null}
        <input name="name" placeholder="Name" required className="rounded-md border border-slate-300 px-3 py-2 dark:border-slate-700 dark:bg-slate-900" />
        <input name="username" placeholder="Username" required className="rounded-md border border-slate-300 px-3 py-2 dark:border-slate-700 dark:bg-slate-900" />
        <input name="password" placeholder="Temporary password (10+ characters)" required className="rounded-md border border-slate-300 px-3 py-2 dark:border-slate-700 dark:bg-slate-900" />
        <select name="role" defaultValue="member" className="rounded-md border border-slate-300 px-3 py-2 dark:border-slate-700 dark:bg-slate-900">
          <option value="member">Member</option>
          <option value="admin">Admin</option>
        </select>
        <SubmitButton>Create user</SubmitButton>
      </form>

      <FormError message={rowState.error ?? pwState.error ?? mfaState.error} />
      {rowState.message ?? pwState.message ?? mfaState.message ? (
        <p className="text-sm text-green-700 dark:text-green-400">{rowState.message ?? pwState.message ?? mfaState.message}</p>
      ) : null}

      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-slate-200 dark:border-slate-800">
            <th className="py-2">Name</th>
            <th>Username</th>
            <th>Role</th>
            <th>MFA</th>
            <th>Status</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {users.map((user) => (
            <tr key={user.id} className="border-b border-slate-100 align-top dark:border-slate-900">
              <td className="py-2">{user.name}</td>
              <td>{user.username}</td>
              <td>{user.role}</td>
              <td>{user.totpEnabled ? 'on' : 'off'}</td>
              <td>{user.isActive ? 'active' : 'deactivated'}</td>
              <td className="flex flex-wrap gap-2 py-2">
                <form action={rowAction}>
                  <input type="hidden" name="userId" value={user.id} />
                  <input type="hidden" name="active" value={user.isActive ? '0' : '1'} />
                  <button type="submit" className="rounded border border-slate-300 px-2 py-1 dark:border-slate-700">
                    {user.isActive ? 'Deactivate' : 'Reactivate'}
                  </button>
                </form>
                <form action={resetPassword} className="flex gap-1">
                  <input type="hidden" name="userId" value={user.id} />
                  <input name="password" placeholder="New password" className="w-40 rounded border border-slate-300 px-2 py-1 dark:border-slate-700 dark:bg-slate-900" />
                  <button type="submit" className="rounded border border-slate-300 px-2 py-1 dark:border-slate-700">
                    Reset password
                  </button>
                </form>
                <form action={resetMfa}>
                  <input type="hidden" name="userId" value={user.id} />
                  <button type="submit" className="rounded border border-slate-300 px-2 py-1 dark:border-slate-700">
                    Reset MFA
                  </button>
                </form>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

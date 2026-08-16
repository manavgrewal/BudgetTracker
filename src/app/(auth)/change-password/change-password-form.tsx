'use client';

import { useActionState } from 'react';
import { FormError } from '@/components/FormError';
import { SubmitButton } from '@/components/SubmitButton';
import { forcedChangePasswordAction, type ForcedChangeState } from './actions';

const initialState: ForcedChangeState = {};

/**
 * `minLength` arrives as a prop rather than importing MIN_PASSWORD_LENGTH directly:
 * that constant lives in @/lib/auth/password, which also pulls in argon2, and a client
 * component importing it drags node:crypto into the browser bundle (the build fails
 * outright). The server page reads the real constant and passes the number down.
 */
export function ChangePasswordForm({ name, minLength }: { name: string; minLength: number }) {
  const [state, action] = useActionState(forcedChangePasswordAction, initialState);

  return (
    <div className="mx-auto mt-24 flex w-full max-w-sm flex-col gap-4 px-4">
      <h1 className="text-2xl font-semibold">Choose your own password</h1>
      <p className="text-sm text-slate-600 dark:text-slate-400">
        Hi {name} — the password you signed in with was set by an admin, so they know it. Pick one only you know before
        you carry on. Everywhere else you are signed in will be signed out.
      </p>
      <FormError message={state.error} />

      <form action={action} className="flex flex-col gap-4">
        <label className="flex flex-col gap-1 text-sm">
          Current password
          <input
            name="currentPassword"
            type="password"
            autoComplete="current-password"
            required
            className="rounded-md border border-slate-300 px-3 py-2 dark:border-slate-700 dark:bg-slate-900"
          />
        </label>

        <label className="flex flex-col gap-1 text-sm">
          New password (at least {minLength} characters)
          <input
            name="newPassword"
            type="password"
            autoComplete="new-password"
            minLength={minLength}
            required
            className="rounded-md border border-slate-300 px-3 py-2 dark:border-slate-700 dark:bg-slate-900"
          />
        </label>

        <SubmitButton>Save and continue</SubmitButton>
      </form>

      {/* Sibling, never nested: the only other thing a gated user may still do is leave. */}
      <form action="/api/auth/logout" method="post">
        <button type="submit" className="text-sm text-slate-600 underline dark:text-slate-400">
          Sign out instead
        </button>
      </form>
    </div>
  );
}

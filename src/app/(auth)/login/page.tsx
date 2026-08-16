'use client';

import { useActionState } from 'react';
import { FormError } from '@/components/FormError';
import { SubmitButton } from '@/components/SubmitButton';
import { loginAction, type LoginFormState } from './actions';

const initialState: LoginFormState = {};

export default function LoginPage() {
  const [state, action] = useActionState(loginAction, initialState);

  return (
    <form action={action} className="mx-auto mt-24 flex w-full max-w-sm flex-col gap-4 px-4">
      <h1 className="text-2xl font-semibold">Budget Tracker</h1>
      <FormError message={state.error} />

      <label className="flex flex-col gap-1 text-sm">
        Username
        <input
          name="username"
          defaultValue={state.username ?? ''}
          autoComplete="username"
          required
          className="rounded-md border border-slate-300 px-3 py-2 dark:border-slate-700 dark:bg-slate-900"
        />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        Password
        <input
          name="password"
          type="password"
          autoComplete="current-password"
          required
          className="rounded-md border border-slate-300 px-3 py-2 dark:border-slate-700 dark:bg-slate-900"
        />
      </label>

      {state.needsTotp ? (
        <>
          <p className="text-sm text-slate-600 dark:text-slate-400">
            Enter your password again along with the code from your authenticator app (or a recovery code).
          </p>
          <label className="flex flex-col gap-1 text-sm">
            Authenticator code
            <input
              name="totpCode"
              inputMode="numeric"
              autoComplete="one-time-code"
              className="rounded-md border border-slate-300 px-3 py-2 dark:border-slate-700 dark:bg-slate-900"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            …or a recovery code
            <input
              name="recoveryCode"
              className="rounded-md border border-slate-300 px-3 py-2 font-mono dark:border-slate-700 dark:bg-slate-900"
            />
          </label>
        </>
      ) : null}

      <SubmitButton>Sign in</SubmitButton>
    </form>
  );
}

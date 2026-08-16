'use client';

import { useActionState } from 'react';
import { FormError } from '@/components/FormError';
import { SubmitButton } from '@/components/SubmitButton';
import { setupAction, type SetupFormState } from './actions';

const initialState: SetupFormState = {};

export function SetupForm() {
  const [state, action] = useActionState(setupAction, initialState);
  return (
    <form action={action} className="mx-auto mt-24 flex w-full max-w-sm flex-col gap-4 px-4">
      <h1 className="text-2xl font-semibold">Create the first account</h1>
      <p className="text-sm text-slate-600 dark:text-slate-400">
        This account is the administrator. Categories and the four built-in bank import profiles are created at the same time.
      </p>
      <FormError message={state.error} />
      <label className="flex flex-col gap-1 text-sm">
        Your name
        <input name="name" required className="rounded-md border border-slate-300 px-3 py-2 dark:border-slate-700 dark:bg-slate-900" />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        Username
        <input name="username" required autoComplete="username" className="rounded-md border border-slate-300 px-3 py-2 dark:border-slate-700 dark:bg-slate-900" />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        Password (at least 10 characters)
        <input name="password" type="password" required autoComplete="new-password" className="rounded-md border border-slate-300 px-3 py-2 dark:border-slate-700 dark:bg-slate-900" />
      </label>
      <SubmitButton>Create account</SubmitButton>
    </form>
  );
}

'use client';

import { useActionState } from 'react';
import { FormError } from '@/components/FormError';
import { SubmitButton } from '@/components/SubmitButton';
import { AuthCard } from '@/components/auth/AuthCard';
import { Field, inputClass } from '@/components/ui/form';
import { setupAction, type SetupFormState } from './actions';

const initialState: SetupFormState = {};

export function SetupForm() {
  const [state, action] = useActionState(setupAction, initialState);
  return (
    <AuthCard
      title="Create the first account"
      description="This account is the administrator. Categories and the four built-in bank import profiles are created at the same time."
      footer="Step 1 of 2"
    >
      <form action={action} className="flex flex-col gap-4">
        <FormError message={state.error} />

        <Field label="Your name">
          <input name="name" required className={inputClass} />
        </Field>

        <Field label="Username">
          <input name="username" required autoComplete="username" className={inputClass} />
        </Field>

        <Field label="Password (at least 10 characters)">
          <input name="password" type="password" required autoComplete="new-password" className={inputClass} />
        </Field>

        <SubmitButton size="lg" className="mt-1 w-full">
          Create account
        </SubmitButton>
      </form>
    </AuthCard>
  );
}

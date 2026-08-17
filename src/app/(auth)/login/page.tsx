'use client';

import { useActionState } from 'react';
import { FormError } from '@/components/FormError';
import { SubmitButton } from '@/components/SubmitButton';
import { AuthCard } from '@/components/auth/AuthCard';
import { Field, inputClass } from '@/components/ui/form';
import { loginAction, type LoginFormState } from './actions';

const initialState: LoginFormState = {};

export default function LoginPage() {
  const [state, action] = useActionState(loginAction, initialState);

  return (
    <AuthCard title="Sign in" description="Welcome back.">
      <form action={action} className="flex flex-col gap-4">
        <FormError message={state.error} />

        <Field label="Username">
          <input
            name="username"
            defaultValue={state.username ?? ''}
            autoComplete="username"
            required
            className={inputClass}
          />
        </Field>

        <Field label="Password">
          <input name="password" type="password" autoComplete="current-password" required className={inputClass} />
        </Field>

        {state.needsTotp ? (
          <>
            <p className="text-sm text-muted">
              Enter your password again along with the code from your authenticator app (or a recovery code).
            </p>
            <Field label="Authenticator code">
              <input name="totpCode" inputMode="numeric" autoComplete="one-time-code" className={inputClass} />
            </Field>
            <Field label="…or a recovery code">
              <input name="recoveryCode" className={`${inputClass} font-mono`} />
            </Field>
          </>
        ) : null}

        <SubmitButton size="lg" className="mt-1 w-full">
          Sign in
        </SubmitButton>
      </form>
    </AuthCard>
  );
}

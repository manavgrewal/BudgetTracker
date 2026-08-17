'use client';

import { useActionState } from 'react';
import { FormError } from '@/components/FormError';
import { SubmitButton } from '@/components/SubmitButton';
import { AuthCard } from '@/components/auth/AuthCard';
import { Field, inputClass } from '@/components/ui/form';
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
    <AuthCard
      title="Choose your own password"
      description={`Hi ${name} — the password you signed in with was set by an admin, so they know it. Pick one only you know before you carry on. Everywhere else you are signed in will be signed out.`}
    >
      <div className="flex flex-col gap-4">
        <FormError message={state.error} />

        <form action={action} className="flex flex-col gap-4">
          <Field label="Current password">
            <input name="currentPassword" type="password" autoComplete="current-password" required className={inputClass} />
          </Field>

          <Field label={`New password (at least ${minLength} characters)`}>
            <input
              name="newPassword"
              type="password"
              autoComplete="new-password"
              minLength={minLength}
              required
              className={inputClass}
            />
          </Field>

          <SubmitButton size="lg" className="mt-1 w-full">
            Save and continue
          </SubmitButton>
        </form>

        {/* Sibling, never nested: the only other thing a gated user may still do is leave. */}
        <form action="/api/auth/logout" method="post" className="border-t border-line pt-4 text-center">
          <button type="submit" className="text-sm text-muted underline underline-offset-2 hover:text-ink">
            Sign out instead
          </button>
        </form>
      </div>
    </AuthCard>
  );
}

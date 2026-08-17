'use client';

import { useActionState, useState } from 'react';
import { FormError } from '@/components/FormError';
import { SubmitButton } from '@/components/SubmitButton';
import { Notice } from '@/components/ui/Notice';
import { Field, inputClass } from '@/components/ui/form';
import {
  beginTotpEnrollmentAction,
  changePasswordAction,
  confirmTotpEnrollmentAction,
  disableTotpAction,
  type ProfileFormState,
} from './actions';

const initialState: ProfileFormState = {};

export function ProfileForms({ totpEnabled, recoveryLeft }: { totpEnabled: boolean; recoveryLeft: number }) {
  const [passwordState, passwordAction] = useActionState(changePasswordAction, initialState);
  const [totpState, totpAction] = useActionState(confirmTotpEnrollmentAction, initialState);
  const [enrollment, setEnrollment] = useState<ProfileFormState['enrollment']>(undefined);
  const [notice, setNotice] = useState<string | null>(null);

  return (
    <div className="grid gap-8 lg:grid-cols-2">
      <form action={passwordAction} className="flex max-w-sm flex-col gap-4">
        <h3 className="text-sm font-semibold text-ink">Change password</h3>
        <FormError message={passwordState.error} />
        {passwordState.message ? <Notice tone="success">{passwordState.message}</Notice> : null}
        <Field label="Current password">
          <input name="currentPassword" type="password" autoComplete="current-password" required className={inputClass} />
        </Field>
        <Field label="New password" hint="At least 10 characters.">
          <input name="newPassword" type="password" autoComplete="new-password" required className={inputClass} />
        </Field>
        <SubmitButton className="w-fit">Update password</SubmitButton>
      </form>

      <div className="flex max-w-sm flex-col gap-4">
        <h3 className="text-sm font-semibold text-ink">Two-factor authentication</h3>
        {totpEnabled ? (
          <>
            <p className="text-sm text-muted">On — {recoveryLeft} recovery codes remaining.</p>
            {totpState.recoveryCodes ? (
              // Found in manual QA: `totpEnabled` flips true (via revalidatePath) the
              // instant confirmTotpEnrollmentAction succeeds, which — if this branch
              // didn't also check totpState.recoveryCodes — would swap away from the
              // form that displayed them before the user ever got to read or copy
              // them. useActionState's local state survives that prop change, so
              // showing it here (once, right after enrollment) is what actually
              // surfaces the one-time codes instead of silently discarding them.
              <Notice tone="warning" title="Save these recovery codes now — they will not be shown again.">
                <ul className="mt-1 rounded-md bg-surface/70 p-3 font-mono text-xs">
                  {totpState.recoveryCodes.map((code) => (
                    <li key={code}>{code}</li>
                  ))}
                </ul>
              </Notice>
            ) : null}
            <button
              type="button"
              onClick={async () => setNotice((await disableTotpAction()).message ?? null)}
              className="btn btn--secondary w-fit"
            >
              Turn off
            </button>
          </>
        ) : enrollment ? (
          <form action={totpAction} className="flex flex-col gap-3">
            <p className="text-sm text-muted">Scan this with your authenticator app, then enter the code it shows.</p>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={enrollment.qrDataUri}
              alt="TOTP enrollment QR code"
              width={240}
              height={240}
              className="rounded-md border border-line bg-white p-2"
            />
            <code className="break-all rounded-md bg-surface-2 px-2 py-1.5 font-mono text-xs text-muted">{enrollment.secret}</code>
            {/*
              No hidden "secret" field: per controller ruling (d), the server holds
              the candidate secret out-of-band (an encrypted, short-lived cookie —
              see actions.ts) and never trusts a client-resubmitted value. This form
              only ever needs to send the 6-digit code.
            */}
            <FormError message={totpState.error} />
            <Field label="6-digit code">
              <input name="code" inputMode="numeric" placeholder="123456" required className={inputClass} />
            </Field>
            <SubmitButton className="w-fit">Confirm</SubmitButton>
          </form>
        ) : (
          <>
            <p className="text-sm text-muted">
              Off. Turning it on asks for a code from your phone whenever you sign in.
            </p>
            <button
              type="button"
              onClick={async () => setEnrollment((await beginTotpEnrollmentAction()).enrollment)}
              className="btn btn--secondary w-fit"
            >
              Set up authenticator app
            </button>
          </>
        )}
        {notice ? <Notice tone="success">{notice}</Notice> : null}
      </div>
    </div>
  );
}

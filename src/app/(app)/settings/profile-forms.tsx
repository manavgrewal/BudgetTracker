'use client';

import { useActionState, useState } from 'react';
import { FormError } from '@/components/FormError';
import { SubmitButton } from '@/components/SubmitButton';
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
    <div className="flex flex-col gap-6">
      <form action={passwordAction} className="flex max-w-sm flex-col gap-3">
        <h3 className="text-sm font-medium">Change password</h3>
        <FormError message={passwordState.error} />
        {passwordState.message ? <p className="text-sm text-green-700 dark:text-green-400">{passwordState.message}</p> : null}
        <input name="currentPassword" type="password" placeholder="Current password" autoComplete="current-password" required className="rounded-md border border-slate-300 px-3 py-2 dark:border-slate-700 dark:bg-slate-900" />
        <input name="newPassword" type="password" placeholder="New password (10+ characters)" autoComplete="new-password" required className="rounded-md border border-slate-300 px-3 py-2 dark:border-slate-700 dark:bg-slate-900" />
        <SubmitButton>Update password</SubmitButton>
      </form>

      <div className="flex max-w-sm flex-col gap-3">
        <h3 className="text-sm font-medium">Two-factor authentication</h3>
        {totpEnabled ? (
          <>
            <p className="text-sm text-slate-600 dark:text-slate-400">On — {recoveryLeft} recovery codes remaining.</p>
            {totpState.recoveryCodes ? (
              // Found in manual QA: `totpEnabled` flips true (via revalidatePath) the
              // instant confirmTotpEnrollmentAction succeeds, which — if this branch
              // didn't also check totpState.recoveryCodes — would swap away from the
              // form that displayed them before the user ever got to read or copy
              // them. useActionState's local state survives that prop change, so
              // showing it here (once, right after enrollment) is what actually
              // surfaces the one-time codes instead of silently discarding them.
              <div className="flex flex-col gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950">
                <p className="text-sm font-medium text-amber-800 dark:text-amber-300">
                  Save these recovery codes now — they will not be shown again.
                </p>
                <ul className="rounded-md bg-slate-100 p-3 font-mono text-xs dark:bg-slate-900">
                  {totpState.recoveryCodes.map((code) => (
                    <li key={code}>{code}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            <button
              type="button"
              onClick={async () => setNotice((await disableTotpAction()).message ?? null)}
              className="w-fit rounded-md border border-slate-300 px-3 py-2 text-sm dark:border-slate-700"
            >
              Turn off
            </button>
          </>
        ) : enrollment ? (
          <form action={totpAction} className="flex flex-col gap-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={enrollment.qrDataUri} alt="TOTP enrollment QR code" width={240} height={240} />
            <code className="break-all text-xs">{enrollment.secret}</code>
            {/*
              No hidden "secret" field: per controller ruling (d), the server holds
              the candidate secret out-of-band (an encrypted, short-lived cookie —
              see actions.ts) and never trusts a client-resubmitted value. This form
              only ever needs to send the 6-digit code.
            */}
            <FormError message={totpState.error} />
            <input name="code" inputMode="numeric" placeholder="6-digit code" required className="rounded-md border border-slate-300 px-3 py-2 dark:border-slate-700 dark:bg-slate-900" />
            <SubmitButton>Confirm</SubmitButton>
          </form>
        ) : (
          <button
            type="button"
            onClick={async () => setEnrollment((await beginTotpEnrollmentAction()).enrollment)}
            className="w-fit rounded-md border border-slate-300 px-3 py-2 text-sm dark:border-slate-700"
          >
            Set up authenticator app
          </button>
        )}
        {notice ? <p className="text-sm text-green-700 dark:text-green-400">{notice}</p> : null}
      </div>
    </div>
  );
}

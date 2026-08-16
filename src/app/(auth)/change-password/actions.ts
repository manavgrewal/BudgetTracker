'use server';

import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { isSameOrigin } from '@/lib/auth/csrf';
import { passwordSchema, verifyPassword } from '@/lib/auth/password';
import { SESSION_COOKIE_NAME, destroyOtherSessionsForUser, requireUser } from '@/lib/auth/session';
import { findUserByUsername, setMustChangePassword, setUserPassword } from '@/lib/auth/users';

export interface ForcedChangeState {
  error?: string;
}

const CROSS_ORIGIN_ERROR = 'Cross-origin request rejected';

const schema = z.object({
  currentPassword: z.string().min(1, 'Enter the password you just signed in with.'),
  newPassword: passwordSchema,
});

/**
 * The forced first-login password change (spec v1.5).
 *
 * Same shape as the Settings self-service change — same-origin check first, then
 * requireUser, then zod — with two additions: it clears must_change_password, and it
 * destroys every OTHER session for this user. Keeping the current session alive is
 * deliberate: the whole point of the interstitial is to let the user carry on, and
 * signing out the browser they are typing in would just bounce them to /login.
 */
export async function forcedChangePasswordAction(
  _prev: ForcedChangeState,
  formData: FormData,
): Promise<ForcedChangeState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };

  const user = await requireUser();
  const parsed = schema.safeParse({
    currentPassword: formData.get('currentPassword') ?? '',
    newPassword: formData.get('newPassword') ?? '',
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Please check the form.' };

  const record = findUserByUsername(user.username);
  if (!record || !(await verifyPassword(record.passwordHash, parsed.data.currentPassword))) {
    return { error: 'Current password is incorrect.' };
  }
  if (await verifyPassword(record.passwordHash, parsed.data.newPassword)) {
    return { error: 'Choose a password you have not used here before.' };
  }

  await setUserPassword(user.id, parsed.data.newPassword);
  setMustChangePassword(user.id, false);

  const token = (await cookies()).get(SESSION_COOKIE_NAME)?.value;
  if (token) destroyOtherSessionsForUser(user.id, token);

  redirect('/dashboard');
}

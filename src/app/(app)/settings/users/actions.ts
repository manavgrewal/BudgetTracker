'use server';

import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { isSameOrigin } from '@/lib/auth/csrf';
import { requireAdmin } from '@/lib/auth/session';
import { destroyAllSessionsForUser } from '@/lib/auth/session';
import { clearAttemptsFor } from '@/lib/auth/ratelimit';
import { clearTotpEnrollment } from '@/lib/auth/totp';
import {
  createUser,
  createUserSchema,
  findUserById,
  setMustChangePassword,
  setUserActive,
  setUserPassword,
} from '@/lib/auth/users';
import { passwordSchema } from '@/lib/auth/password';

export interface UsersFormState {
  error?: string;
  message?: string;
}

const CROSS_ORIGIN_ERROR = 'Cross-origin request rejected';

export async function createUserAction(_prev: UsersFormState, formData: FormData): Promise<UsersFormState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };

  await requireAdmin();
  const parsed = createUserSchema.safeParse({
    name: formData.get('name') ?? '',
    username: formData.get('username') ?? '',
    password: formData.get('password') ?? '',
    role: formData.get('role') ?? 'member',
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Please check the form.' };
  try {
    // Spec v1.5: the admin typed this password, so the new user is gated on
    // /change-password until they replace it with one only they know.
    await createUser({ ...parsed.data, mustChangePassword: true });
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Could not create the user.' };
  }
  revalidatePath('/settings/users');
  return {
    message: `Created ${parsed.data.username}. Share the temporary password privately — they must change it at first sign-in.`,
  };
}

export async function setActiveAction(_prev: UsersFormState, formData: FormData): Promise<UsersFormState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };

  await requireAdmin();
  const parsed = z.object({ userId: z.coerce.number().int().positive(), active: z.enum(['0', '1']) }).safeParse({
    userId: formData.get('userId'),
    active: formData.get('active'),
  });
  if (!parsed.success) return { error: 'Invalid request.' };
  try {
    setUserActive(parsed.data.userId, parsed.data.active === '1');
    if (parsed.data.active === '0') destroyAllSessionsForUser(parsed.data.userId);
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Could not update the user.' };
  }
  revalidatePath('/settings/users');
  return { message: 'User updated.' };
}

export async function resetPasswordAction(_prev: UsersFormState, formData: FormData): Promise<UsersFormState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };

  await requireAdmin();
  const parsed = z.object({ userId: z.coerce.number().int().positive(), password: passwordSchema }).safeParse({
    userId: formData.get('userId'),
    password: formData.get('password') ?? '',
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Invalid request.' };
  await setUserPassword(parsed.data.userId, parsed.data.password);
  // Same reasoning as createUserAction: an admin-known password is a temporary one.
  setMustChangePassword(parsed.data.userId, true);
  destroyAllSessionsForUser(parsed.data.userId);
  const target = findUserById(parsed.data.userId);
  if (target) clearAttemptsFor(target.username);
  revalidatePath('/settings/users');
  return { message: 'Password reset. All their sessions were signed out, and they must choose a new password to sign in.' };
}

export async function resetMfaAction(_prev: UsersFormState, formData: FormData): Promise<UsersFormState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };

  await requireAdmin();
  const parsed = z.object({ userId: z.coerce.number().int().positive() }).safeParse({ userId: formData.get('userId') });
  if (!parsed.success) return { error: 'Invalid request.' };
  clearTotpEnrollment(parsed.data.userId);
  // Mirrors resetPasswordAction: an admin action that lowers this account's
  // authentication bar must not leave already-open sessions running behind it —
  // a live session on a lost phone would otherwise outlive the MFA it was granted under.
  destroyAllSessionsForUser(parsed.data.userId);
  revalidatePath('/settings/users');
  return { message: 'MFA cleared and their sessions were signed out. They can enroll a new authenticator at their next sign-in.' };
}

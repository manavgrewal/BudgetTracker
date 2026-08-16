'use server';

import { cookies, headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { isSameOrigin } from '@/lib/auth/csrf';
import { passwordSchema, verifyPassword } from '@/lib/auth/password';
import { requireUser } from '@/lib/auth/session';
import {
  clearTotpEnrollment,
  countUnusedRecoveryCodes,
  decryptTotpSecret,
  enableTotpForUser,
  encryptTotpSecret,
  generateRecoveryCodes,
  generateTotpSecret,
  storeRecoveryCodes,
  totpKeyUri,
  totpQrDataUri,
  verifyTotp,
} from '@/lib/auth/totp';
import { findUserByUsername, setUserPassword } from '@/lib/auth/users';

export interface ProfileFormState {
  error?: string;
  message?: string;
  enrollment?: { secret: string; qrDataUri: string };
  recoveryCodes?: string[];
}

const CROSS_ORIGIN_ERROR = 'Cross-origin request rejected';

// Ruling (d): the candidate secret is held out-of-band, server-side, and
// enableTotpForUser is only ever called with the secret this server generated —
// never with whatever a client resubmits in a form field. totp.ts deliberately
// has no pending-enrollment storage of its own, so this module owns it: the
// candidate is AES-GCM-encrypted with the same encryptTotpSecret/decryptTotpSecret
// helpers used for the at-rest secret, stashed in a short-lived httpOnly cookie,
// and discarded once enrollment is confirmed (or abandoned past its TTL).
const PENDING_TOTP_COOKIE = 'bt_pending_totp';
const PENDING_TOTP_TTL_SECONDS = 10 * 60;

const confirmTotpSchema = z.object({
  code: z.string().trim().regex(/^\d{6,8}$/, 'Enter the code from your authenticator app.'),
});

async function stashPendingTotpSecret(secret: string): Promise<void> {
  const store = await cookies();
  store.set(PENDING_TOTP_COOKIE, encryptTotpSecret(secret), {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: PENDING_TOTP_TTL_SECONDS,
  });
}

async function readPendingTotpSecret(): Promise<string | null> {
  const store = await cookies();
  const raw = store.get(PENDING_TOTP_COOKIE)?.value;
  if (!raw) return null;
  try {
    return decryptTotpSecret(raw);
  } catch {
    // Expired/corrupt/rotated-SECRET_KEY: treat as "no pending enrollment", not a crash.
    return null;
  }
}

async function clearPendingTotpSecret(): Promise<void> {
  const store = await cookies();
  store.delete(PENDING_TOTP_COOKIE);
}

export async function changePasswordAction(_prev: ProfileFormState, formData: FormData): Promise<ProfileFormState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };

  const user = await requireUser();
  const parsed = z
    .object({ currentPassword: z.string().min(1), newPassword: passwordSchema })
    .safeParse({ currentPassword: formData.get('currentPassword') ?? '', newPassword: formData.get('newPassword') ?? '' });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Please check the form.' };

  const record = findUserByUsername(user.username);
  if (!record || !(await verifyPassword(record.passwordHash, parsed.data.currentPassword))) {
    return { error: 'Current password is incorrect.' };
  }
  await setUserPassword(user.id, parsed.data.newPassword);
  revalidatePath('/settings');
  return { message: 'Password updated.' };
}

export async function beginTotpEnrollmentAction(): Promise<ProfileFormState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };

  const user = await requireUser();
  const secret = generateTotpSecret();
  await stashPendingTotpSecret(secret);
  const qrDataUri = await totpQrDataUri(totpKeyUri(user.username, secret));
  return { enrollment: { secret, qrDataUri } };
}

export async function confirmTotpEnrollmentAction(_prev: ProfileFormState, formData: FormData): Promise<ProfileFormState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };

  const user = await requireUser();
  const parsed = confirmTotpSchema.safeParse({ code: formData.get('code') ?? '' });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Please check the form.' };
  }
  const secret = await readPendingTotpSecret();
  if (!secret) {
    return { error: 'That enrollment expired. Start over and scan a fresh QR code.' };
  }
  if (!verifyTotp(secret, parsed.data.code)) {
    return { error: 'That code did not match. Try the next one your app shows.' };
  }
  enableTotpForUser(user.id, secret);
  await clearPendingTotpSecret();
  const codes = generateRecoveryCodes();
  storeRecoveryCodes(user.id, codes);
  revalidatePath('/settings');
  return { message: 'Two-factor authentication is on. Save these recovery codes now.', recoveryCodes: codes };
}

export async function disableTotpAction(): Promise<ProfileFormState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };

  const user = await requireUser();
  clearTotpEnrollment(user.id);
  await clearPendingTotpSecret();
  revalidatePath('/settings');
  return { message: 'Two-factor authentication is off.' };
}

export async function remainingRecoveryCodes(): Promise<number> {
  const user = await requireUser();
  return countUnusedRecoveryCodes(user.id);
}

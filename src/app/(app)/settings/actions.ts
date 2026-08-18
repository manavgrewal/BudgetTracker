'use server';

import { cookies, headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { isSameOrigin } from '@/lib/auth/csrf';
import { passwordSchema, verifyPassword } from '@/lib/auth/password';
import { requireAdmin, requireUser } from '@/lib/auth/session';
import {
  clearTotpEnrollment,
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
import { parseChangelog } from '@/lib/changelog';
import type { ChangelogRelease } from '@/lib/changelog';
import { applyUpdate, runUpdateCheck } from '@/lib/update/check';
import { boundRelease, fetchRemoteChangelog } from '@/lib/update/github';
import { checkUpdateApply, checkUpdateCheckNow, checkUpdateReview } from '@/lib/update/ratelimit';
import { dismissVersion, readUpdateState, setAutoApply, setUpdateChecksEnabled } from '@/lib/update/state';
import { watchtowerConfig } from '@/lib/update/watchtower';

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

export interface UpdateActionState {
  error?: string;
  message?: string;
}

export interface ReviewUpdateState {
  error?: string;
  release?: ChangelogRelease;
  version?: string;
}

const UPDATE_PATH = '/settings';
const STALE_VERSION_ERROR = 'That version is no longer the one on offer. Press Check now and read the notes again.';
const NO_UPDATE_ERROR = 'There is no update on offer right now.';

/**
 * MUST-10.3 (the ownership rule): no update action accepts a userId. The only parameters any
 * of them take are `enabled` (a checkbox) and `version` (a semver string), and the version is
 * re-checked against the server's own state before anything acts on it (MUST-9.7).
 */
const versionSchema = z.string().regex(/^\d+\.\d+\.\d+$/, 'That is not a version this app can act on.');

/**
 * MUST-10.2: origin FIRST, before auth, before validation, before any read — exactly the
 * shape settings/notifications/actions.ts's guard() uses.
 */
async function updateGuard(): Promise<UpdateActionState | null> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };
  return null;
}

export async function enableUpdateChecksAction(): Promise<UpdateActionState> {
  const blocked = await updateGuard();
  if (blocked) return blocked;
  const user = await requireAdmin();
  // MUST-10.3: the caller's id comes from the session, never from a field.
  setUpdateChecksEnabled({ enabled: true, userId: user.id });
  revalidatePath(UPDATE_PATH);
  return { message: 'Update checks are on. This app will ask GitHub once a day whether a newer version is published.' };
}

export async function disableUpdateChecksAction(): Promise<UpdateActionState> {
  const blocked = await updateGuard();
  if (blocked) return blocked;
  const user = await requireAdmin();
  // MUST-3.4: this wipes every update. key but the flag. Off means off.
  setUpdateChecksEnabled({ enabled: false, userId: user.id });
  revalidatePath(UPDATE_PATH);
  return { message: 'Update checks are off. Nothing about updates leaves this machine now.' };
}

export async function setAutoApplyAction(_prev: UpdateActionState, formData: FormData): Promise<UpdateActionState> {
  const blocked = await updateGuard();
  if (blocked) return blocked;
  await requireAdmin();
  if (!readUpdateState().enabled) return { error: 'Turn update checks on first.' };
  // An HTML checkbox posts 'on' when ticked and nothing at all when not.
  setAutoApply(formData.get('autoApply') !== null);
  revalidatePath(UPDATE_PATH);
  return { message: 'Saved.' };
}

export async function checkForUpdateNowAction(): Promise<UpdateActionState> {
  const blocked = await updateGuard();
  if (blocked) return blocked;
  await requireAdmin();
  if (!readUpdateState().enabled) return { error: 'Turn update checks on first.' };

  // MUST-10.9: quota is spent only once every configuration guard has passed.
  const verdict = checkUpdateCheckNow();
  if (!verdict.allowed) return { error: `Too many attempts. Try again in ${verdict.retryAfterMinutes} minutes.` };

  // MUST-5.6 / MUST-10.5 / MUST-10.6: a manual check ignores the daily interval but still
  // refreshes the stamp, and still applies a small update when auto-apply is on. Pressing
  // Check now on an install configured to install small updates automatically installs the
  // small update; anything else would be a surprising second policy.
  const result = await runUpdateCheck({ now: new Date(), manual: true });
  revalidatePath(UPDATE_PATH);
  if (result.error !== null) return { error: result.error };
  if (result.applied) return { message: `Version ${result.latestVersion} is being installed now.` };
  if (result.latestVersion === null) return { message: 'You are on the newest published version.' };
  return { message: `Version ${result.latestVersion} is available.` };
}

/**
 * MUST-10.2: this action mutates nothing and does not revalidate — but it takes the STRICT
 * isSameOrigin(), not the relaxed isSameOriginOrHeaderless(), because it causes outbound
 * egress on the server. Same reasoning notify MUST-12.8 gives for detectTelegramChatIdAction.
 */
export async function reviewUpdateAction(formData: FormData): Promise<ReviewUpdateState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };
  await requireAdmin();

  const parsed = versionSchema.safeParse(String(formData.get('version') ?? ''));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Invalid request.' };
  const state = readUpdateState();
  if (state.latestVersion === null) return { error: NO_UPDATE_ERROR };
  if (state.latestVersion !== parsed.data) return { error: STALE_VERSION_ERROR };

  const verdict = checkUpdateReview();
  if (!verdict.allowed) return { error: `Too many attempts. Try again in ${verdict.retryAfterMinutes} minutes.` };

  try {
    const markdown = await fetchRemoteChangelog(parsed.data);
    const release = parseChangelog(markdown).find((entry) => entry.heading.startsWith(`[${parsed.data}]`));
    // MUST-9.6: a failed or missing changelog must not become a wall that stops an admin
    // updating — the panel renders its fallback sentence and still offers the confirm button.
    if (release === undefined) return { version: parsed.data };
    return { version: parsed.data, release: boundRelease(release) };
  } catch {
    return { version: parsed.data };
  }
}

export async function applyUpdateAction(formData: FormData): Promise<UpdateActionState> {
  const blocked = await updateGuard();
  if (blocked) return blocked;
  await requireAdmin();

  const parsed = versionSchema.safeParse(String(formData.get('version') ?? ''));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Invalid request.' };

  const state = readUpdateState();
  if (!state.enabled) return { error: 'Turn update checks on first.' };
  if (state.latestVersion === null) return { error: NO_UPDATE_ERROR };
  // MUST-9.7: the version travels in the form so a stale tab cannot install a version its
  // reader never saw — and it is checked against the server's own state, never trusted.
  if (state.latestVersion !== parsed.data) return { error: STALE_VERSION_ERROR };
  // MUST-10.9: no Watchtower means no apply path, and burning apply quota while doing
  // nothing would be the wrong order.
  if (watchtowerConfig() === null) return { error: 'This install has no Watchtower companion to ask.' };

  const verdict = checkUpdateApply();
  if (!verdict.allowed) return { error: `Too many attempts. Try again in ${verdict.retryAfterMinutes} minutes.` };

  try {
    const outcome = await applyUpdate({ version: parsed.data, now: new Date() });
    revalidatePath(UPDATE_PATH);
    // MUST-9.8: two of the three fixed sentences. The third is the scrubbed error below.
    return {
      message:
        outcome === 'accepted'
          ? `Update requested. Watchtower is pulling ${parsed.data} and will restart this app in a moment. Reload this page in a minute or two.`
          : `Update requested. This app is being replaced right now, so it could not wait for a reply. Reload this page in a minute or two — the version at the bottom of this card will tell you whether it worked.`,
    };
  } catch (error) {
    revalidatePath(UPDATE_PATH);
    // MUST-7.3 / MUST-10.11: applyUpdate already scrubbed this with the token in the secret
    // list before it was written to update.last_apply_error; it is returned as-is.
    return { error: error instanceof Error ? error.message : 'The update could not be requested.' };
  }
}

/** §9.3 item 6 / MUST-5.9. Suppresses only the card's prominence — never the check, never the dedup. */
export async function dismissUpdateAction(formData: FormData): Promise<UpdateActionState> {
  const blocked = await updateGuard();
  if (blocked) return blocked;
  await requireAdmin();
  const raw = String(formData.get('version') ?? '');
  if (raw.length === 0) {
    dismissVersion('');
    revalidatePath(UPDATE_PATH);
    return { message: 'Showing this again.' };
  }
  const parsed = versionSchema.safeParse(raw);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Invalid request.' };
  dismissVersion(parsed.data);
  revalidatePath(UPDATE_PATH);
  return { message: `Skipping ${parsed.data} for now. You will still be told when a newer version is published.` };
}

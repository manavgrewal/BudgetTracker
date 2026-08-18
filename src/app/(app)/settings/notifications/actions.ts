'use server';

import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { CROSS_ORIGIN_ERROR, isSameOrigin } from '@/lib/auth/csrf';
import { requireAdmin, requireUser } from '@/lib/auth/session';
import {
  getSmtp,
  getSmtpPassword,
  getTarget,
  getTelegramToken,
  getUserSettings,
  recordSmtpOutcome,
  recordTargetOutcome,
  removeSmtp,
  removeTarget,
  saveEmailTarget,
  saveSmtp,
  saveTelegramTarget,
  saveUserSettings,
  applyPref,
} from '@/lib/notify/config';
import { NotifyCredentialError, scrubSecrets } from '@/lib/notify/crypto';
import { CHANNELS, eventsFor, isChannel, type Channel } from '@/lib/notify/events';
import { checkDetectChat, checkTestSend } from '@/lib/notify/ratelimit';
import { deliver, NotifyError } from '@/lib/notify/send';
import { fetchTelegramChats, type TelegramChat } from '@/lib/notify/send/telegram';

export interface NotificationsState {
  error?: string;
  message?: string;
}

export interface DetectChatIdState {
  error?: string;
  chats?: TelegramChat[];
}

const TOKEN_FIRST = 'Save your bot token first.';
const PATH = '/settings/notifications';

/** MUST-12.5: a host, not a URL. No scheme, no whitespace, no path. */
const hostSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z0-9.:_-]+$/, 'Server must be a hostname, not a URL: no scheme (like https) in front of it.');

const smtpSchema = z
  .object({
    preset: z.enum(['brevo', 'smtp2go', 'gmail', 'custom']),
    host: hostSchema,
    port: z.coerce.number().int().min(1).max(65535),
    security: z.enum(['tls', 'starttls', 'none']),
    username: z.string().min(1).max(254),
    password: z.string().max(512),
    fromEmail: z.string().email().max(254),
    fromName: z.string().min(1).max(64),
    enabled: z.boolean(),
  })
  // MUST-8.16: plaintext is accepted only for a relay on the user's own LAN.
  .refine((value) => value.security !== 'none' || value.preset === 'custom', {
    message: 'Unencrypted SMTP is only available with the Custom SMTP preset.',
    path: ['security'],
  });

const telegramSchema = z.object({
  destination: z.string().regex(/^-?\d{1,20}$/, 'Chat ID must be a number, optionally starting with a minus sign.'),
  botToken: z
    .string()
    .regex(/^\d{5,15}:[A-Za-z0-9_-]{20,80}$/, 'That does not look like a bot token. Copy the whole line BotFather sent.')
    .or(z.literal('')),
  enabled: z.boolean(),
});

const emailTargetSchema = z.object({
  destination: z.string().email().max(254),
  enabled: z.boolean(),
});

const knobsSchema = z.object({
  comingDueDays: z.coerce.number().int().min(1).max(365),
  budgetThresholdPct: z.coerce.number().int().min(1).max(99),
  staleImportWeeks: z.coerce.number().int().min(1).max(52),
  dailyHour: z.coerce.number().int().min(0).max(23),
  digestWeekday: z.coerce.number().int().min(0).max(6),
  digestHour: z.coerce.number().int().min(0).max(23),
});

function text(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === 'string' ? value.trim() : '';
}

function checkbox(formData: FormData, key: string): boolean {
  return formData.get(key) !== null;
}

function firstIssue(error: z.ZodError): string {
  return error.issues[0]?.message ?? 'That input was not valid.';
}

async function guard(): Promise<NotificationsState | null> {
  // MUST-12.1: FIRST, before auth, before validation, before any read.
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };
  return null;
}

export async function saveSmtpAction(_prev: NotificationsState, formData: FormData): Promise<NotificationsState> {
  const blocked = await guard();
  if (blocked) return blocked;
  await requireAdmin(); // MUST-12.3

  const parsed = smtpSchema.safeParse({
    preset: text(formData, 'preset'),
    host: text(formData, 'host'),
    port: text(formData, 'port'),
    security: text(formData, 'security'),
    username: text(formData, 'username'),
    password: text(formData, 'password'),
    fromEmail: text(formData, 'fromEmail'),
    fromName: text(formData, 'fromName') || 'Budget Tracker',
    enabled: checkbox(formData, 'enabled'),
  });
  if (!parsed.success) return { error: firstIssue(parsed.error) };

  // MUST-5.6: blank keeps the stored value on update, and is an error on create.
  const password = parsed.data.password.length > 0 ? parsed.data.password : null;
  if (password === null && getSmtp() === null) return { error: 'A password is required the first time you save the relay.' };

  saveSmtp({ ...parsed.data, password });
  revalidatePath(PATH);
  return { message: 'Outbound email saved. Press Send test email to prove it works.' };
}

export async function removeSmtpAction(): Promise<NotificationsState> {
  const blocked = await guard();
  if (blocked) return blocked;
  await requireAdmin();
  removeSmtp();
  revalidatePath(PATH);
  return { message: 'Outbound email removed. Email notifications will not send until it is set up again.' };
}

export async function testSmtpAction(): Promise<NotificationsState> {
  const blocked = await guard();
  if (blocked) return blocked;
  const user = await requireAdmin();
  return runTest(user.id, 'email', { relayOnly: true });
}

export async function saveTelegramTargetAction(_prev: NotificationsState, formData: FormData): Promise<NotificationsState> {
  const blocked = await guard();
  if (blocked) return blocked;
  const user = await requireUser(); // MUST-12.4: the id comes from the session, never a field.

  const parsed = telegramSchema.safeParse({
    destination: text(formData, 'destination'),
    botToken: text(formData, 'botToken'),
    enabled: checkbox(formData, 'enabled'),
  });
  if (!parsed.success) return { error: firstIssue(parsed.error) };

  const botToken = parsed.data.botToken.length > 0 ? parsed.data.botToken : null;
  if (botToken === null && getTarget(user.id, 'telegram') === null) {
    return { error: 'A bot token is required the first time you save this channel.' };
  }

  saveTelegramTarget({ userId: user.id, destination: parsed.data.destination, botToken, enabled: parsed.data.enabled });
  revalidatePath(PATH);
  return { message: 'Telegram saved. Press Send test message to prove it works.' };
}

export async function saveEmailTargetAction(_prev: NotificationsState, formData: FormData): Promise<NotificationsState> {
  const blocked = await guard();
  if (blocked) return blocked;
  const user = await requireUser();

  const parsed = emailTargetSchema.safeParse({
    destination: text(formData, 'destination'),
    enabled: checkbox(formData, 'enabled'),
  });
  if (!parsed.success) return { error: firstIssue(parsed.error) };

  saveEmailTarget({ userId: user.id, destination: parsed.data.destination, enabled: parsed.data.enabled });
  revalidatePath(PATH);
  return { message: 'Email address saved. Press Send test email to prove it works.' };
}

export async function removeTargetAction(formData: FormData): Promise<NotificationsState> {
  const blocked = await guard();
  if (blocked) return blocked;
  const user = await requireUser();

  const channel = text(formData, 'channel');
  if (!isChannel(channel)) return { error: 'Unknown channel.' };

  removeTarget(user.id, channel);
  revalidatePath(PATH);
  return { message: channel === 'telegram' ? 'Telegram removed.' : 'Email address removed.' };
}

export async function testTargetAction(formData: FormData): Promise<NotificationsState> {
  const blocked = await guard();
  if (blocked) return blocked;
  const user = await requireUser();

  const channel = text(formData, 'channel');
  if (!isChannel(channel)) return { error: 'Unknown channel.' };
  return runTest(user.id, channel, { relayOnly: false });
}

/**
 * MUST-12.7: Send test bypasses the outbox: it calls the sender directly and returns the
 * outcome synchronously, because immediate feedback is the entire point of the button. It
 * writes no outbox row, but it DOES update last_error / last_success_at / verified_at.
 */
async function runTest(userId: number, channel: Channel, opts: { relayOnly: boolean }): Promise<NotificationsState> {
  const target = getTarget(userId, channel);
  if (!target) return { error: 'Set this channel up first.' };
  if (channel === 'email' && getSmtp() === null) {
    return { error: 'An admin needs to set up outbound email before this can send.' };
  }

  // Quota is spent only once a send is actually about to be attempted: checked AFTER the
  // target/relay guards above, so pressing the button against an unconfigured destination
  // or a missing relay cannot burn per-user or global tokens while sending nothing.
  const verdict = checkTestSend(userId, channel);
  if (!verdict.allowed) {
    return { error: `Too many test messages. Try again in ${verdict.retryAfterMinutes} minutes.` };
  }

  const subject = 'Budget Tracker test message';
  const body = 'This is a test from Budget Tracker. If you can read it, this channel works.';

  let credential: string | undefined;
  try {
    if (channel === 'telegram') {
      credential = getTelegramToken(userId);
      await deliver({ channel: 'telegram', destination: target.destination, botToken: credential, subject, body });
    } else {
      const relay = getSmtp();
      if (!relay) return { error: 'An admin needs to set up outbound email before this can send.' };
      credential = getSmtpPassword();
      await deliver({
        channel: 'email',
        destination: target.destination,
        smtp: {
          host: relay.host,
          port: relay.port,
          security: relay.security,
          username: relay.username,
          password: credential,
          fromEmail: relay.fromEmail,
          fromName: relay.fromName,
        },
        subject,
        body,
      });
    }
  } catch (error) {
    const raw = error instanceof Error ? error.message : 'The test could not be sent.';
    // MUST-5.5: belt and braces: the transports scrub already; this is a real second net
    // keyed on the credential actually in play for this attempt (undefined, harmlessly, if
    // the failure happened before either credential read completed).
    const message = scrubSecrets(raw, credential ? [credential] : []);
    if (error instanceof NotifyError && error.scope === 'relay') recordSmtpOutcome({ ok: false, error: message });
    else recordTargetOutcome({ userId, channel, ok: false, error: message });
    revalidatePath(PATH);
    return { error: message };
  }

  recordTargetOutcome({ userId, channel, ok: true, verify: true });
  if (channel === 'email') recordSmtpOutcome({ ok: true });
  revalidatePath(PATH);
  return {
    message: opts.relayOnly
      ? 'Test email sent through the relay. Check the inbox.'
      : channel === 'telegram'
        ? 'Test message sent. Check Telegram.'
        : 'Test email sent. Check your inbox.',
  };
}

export async function savePreferencesAction(_prev: NotificationsState, formData: FormData): Promise<NotificationsState> {
  const blocked = await guard();
  if (blocked) return blocked;
  const user = await requireUser();

  const parsed = knobsSchema.safeParse({
    comingDueDays: text(formData, 'comingDueDays'),
    budgetThresholdPct: text(formData, 'budgetThresholdPct'),
    staleImportWeeks: text(formData, 'staleImportWeeks'),
    dailyHour: text(formData, 'dailyHour'),
    digestWeekday: text(formData, 'digestWeekday'),
    digestHour: text(formData, 'digestHour'),
  });
  if (!parsed.success) return { error: firstIssue(parsed.error) };

  // MUST-4.3: only the events this role may see are writable, so a forged field for an
  // admin-only event from a member is ignored rather than stored.
  // MUST-3.7: applyPref writes a row only where the value differs from the registry
  // default, and deletes the row when it matches: the table stays sparse.
  for (const event of eventsFor(user.role)) {
    for (const channel of CHANNELS) {
      applyPref(user.id, event.id, channel, checkbox(formData, `pref:${event.id}:${channel}`));
    }
  }
  saveUserSettings(user.id, parsed.data);
  revalidatePath(PATH);
  return { message: 'Saved.' };
}

/**
 * MUST-12.8: the helper's security posture. It takes NO ARGUMENTS AT ALL: not a token,
 * not a user id. It calls isSameOrigin() then requireUser(), loads THAT user's own
 * notification_targets row, decrypts the token server-side, calls fetchTelegramChats(),
 * and returns only TelegramChat[]. There is consequently no parameter through which a
 * member could aim it at another member's bot, and no response field through which a
 * token could escape.
 *
 * It is still MUTATING-SHAPED for CSRF purposes: it causes outbound network egress on the
 * server, so it takes the strict isSameOrigin() check, not isSameOriginOrHeaderless().
 *
 * It mutates nothing and therefore does not revalidate (MUST-12.6).
 */
export async function detectTelegramChatIdAction(): Promise<DetectChatIdState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };
  const user = await requireUser();

  // MUST-8.11: the button is disabled in this state anyway, but the action does not rely
  // on the UI for that.
  const target = getTarget(user.id, 'telegram');
  if (!target || !target.secretSet) return { error: TOKEN_FIRST };

  // MUST-13.1a: its own, looser bucket, checked BEFORE any egress.
  const verdict = checkDetectChat(user.id);
  if (!verdict.allowed) return { error: `Too many attempts. Try again in ${verdict.retryAfterMinutes} minutes.` };

  let botToken: string;
  try {
    botToken = getTelegramToken(user.id);
  } catch (error) {
    if (error instanceof NotifyCredentialError) return { error: error.message };
    throw error;
  }

  try {
    return { chats: await fetchTelegramChats(botToken) };
  } catch (error) {
    const raw = error instanceof Error ? error.message : 'Telegram could not be reached.';
    return { error: scrubSecrets(raw, [botToken]) };
  }
}

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { readEnv } from '@/lib/env';

/**
 * Same construction and framing as src/lib/auth/totp.ts and src/lib/simplefin/crypto.ts
 * (MUST-5.1): AES-256-GCM under hkdfSync('sha256', SECRET_KEY, <empty salt>, <info>, 32),
 * stored as base64(iv ‖ tag ‖ ciphertext) with a 12-byte IV and a 16-byte tag.
 *
 * MUST-5.2: two distinct info strings, so the SMTP password and the Telegram bot tokens
 * have independent key streams and neither is interchangeable with a TOTP secret or the
 * SimpleFIN access URL.
 *
 * SERVER ONLY (MUST-2.2): never imported from a *-client.tsx file.
 */
export const SMTP_HKDF_INFO = 'notify-smtp-v1';
export const TELEGRAM_HKDF_INFO = 'notify-telegram-v1';

/** MUST-5.4: the one sentence a decrypt failure ever presents as. Never a 500. */
export const CREDENTIAL_UNREADABLE = 'Stored credential could not be read. Re-enter it.';
export const REDACTED = '[redacted]';

const IV_BYTES = 12;
const TAG_BYTES = 16;

export class NotifyCredentialError extends Error {
  constructor(message: string = CREDENTIAL_UNREADABLE) {
    super(message);
    this.name = 'NotifyCredentialError';
  }
}

export function deriveNotifyKey(info: string, secretKey: string = readEnv().secretKey): Buffer {
  const derived = hkdfSync('sha256', Buffer.from(secretKey, 'utf8'), Buffer.alloc(0), Buffer.from(info, 'utf8'), 32);
  return Buffer.from(derived);
}

export function encryptSecret(plain: string, info: string, secretKey?: string): string {
  const key = deriveNotifyKey(info, secretKey);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
}

/**
 * MUST-5.4: a rotated SECRET_KEY, a truncated column, a tampered tag — every one of them
 * surfaces as NotifyCredentialError carrying CREDENTIAL_UNREADABLE. The underlying error
 * is logged WITHOUT the payload, exactly as attemptLogin handles a TOTP decrypt failure.
 */
export function decryptSecret(payload: string, info: string, secretKey?: string): string {
  const raw = Buffer.from(payload, 'base64');
  if (raw.length <= IV_BYTES + TAG_BYTES) throw new NotifyCredentialError();
  try {
    const key = deriveNotifyKey(info, secretKey);
    const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, IV_BYTES));
    decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
    return Buffer.concat([decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString('utf8');
  } catch (error) {
    console.error('[notify] stored credential failed to decrypt', {
      info,
      reason: error instanceof Error ? error.name : 'unknown',
    });
    throw new NotifyCredentialError();
  }
}

/**
 * The exact bytes an SMTP relay sees for AUTH PLAIN, base64-encoded. nodemailer's
 * authentication errors routinely quote the failing command line back, and on some relays
 * that line contains this string — so it is scrubbed alongside the raw password (MUST-5.5).
 */
export function authPlainBase64(username: string, password: string): string {
  return Buffer.from(`\0${username}\0${password}`, 'utf8').toString('base64');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * MUST-5.5: applied to EVERY string written to last_error, to console.error, or returned
 * to the browser from a send path. Two concrete reasons this is load-bearing rather than
 * belt-and-braces: the Telegram bot token is in the request URL path, so any fetch error
 * that echoes the URL echoes the credential; and nodemailer quotes the failing SMTP
 * command line, which can include the base64 AUTH PLAIN payload.
 */
export function scrubSecrets(text: string, secrets: string[]): string {
  let out = text;
  const sorted = [...secrets].sort((a, b) => b.length - a.length);
  for (const secret of sorted) {
    if (typeof secret !== 'string') continue;
    const trimmed = secret.trim();
    if (trimmed.length === 0) continue;
    out = out.replace(new RegExp(escapeRegExp(secret), 'g'), REDACTED);
    if (trimmed !== secret) out = out.replace(new RegExp(escapeRegExp(trimmed), 'g'), REDACTED);
  }
  return out;
}

import { describe, it, expect } from 'vitest';
import {
  CREDENTIAL_UNREADABLE,
  NotifyCredentialError,
  SMTP_HKDF_INFO,
  TELEGRAM_HKDF_INFO,
  authPlainBase64,
  decryptSecret,
  deriveNotifyKey,
  encryptSecret,
  scrubSecrets,
} from '@/lib/notify/crypto';
import { deriveSimplefinKey } from '@/lib/simplefin/crypto';
import { deriveTotpKey } from '@/lib/auth/totp';

const SECRET_A = 'a'.repeat(48);
const SECRET_B = 'b'.repeat(48);
const TOKEN = '123456789:AAHk3f-EXAMPLE-tokenxxxxxxxxxxxxxxxxxx';
const PASSWORD = 'xsmtpsib-4f2a-not-a-real-key';

describe('MUST-5.2: two distinct, pinned info strings', () => {
  it('pins the literals so stored credentials stay decryptable', () => {
    expect(SMTP_HKDF_INFO).toBe('notify-smtp-v1');
    expect(TELEGRAM_HKDF_INFO).toBe('notify-telegram-v1');
  });

  it('derives 32-byte keys that differ per info and per SECRET_KEY', () => {
    const smtp = deriveNotifyKey(SMTP_HKDF_INFO, SECRET_A);
    const telegram = deriveNotifyKey(TELEGRAM_HKDF_INFO, SECRET_A);
    expect(smtp).toHaveLength(32);
    expect(smtp.equals(deriveNotifyKey(SMTP_HKDF_INFO, SECRET_A))).toBe(true);
    expect(smtp.equals(telegram)).toBe(false);
    expect(smtp.equals(deriveNotifyKey(SMTP_HKDF_INFO, SECRET_B))).toBe(false);
  });

  it('is a different key stream from the SimpleFIN one', () => {
    expect(deriveNotifyKey(SMTP_HKDF_INFO, SECRET_A).equals(deriveSimplefinKey(SECRET_A))).toBe(false);
    expect(deriveNotifyKey(TELEGRAM_HKDF_INFO, SECRET_A).equals(deriveSimplefinKey(SECRET_A))).toBe(false);
  });

  it('is a different key stream from the TOTP one', () => {
    expect(deriveNotifyKey(SMTP_HKDF_INFO, SECRET_A).equals(deriveTotpKey(SECRET_A))).toBe(false);
    expect(deriveNotifyKey(TELEGRAM_HKDF_INFO, SECRET_A).equals(deriveTotpKey(SECRET_A))).toBe(false);
  });
});

describe('MUST-5.1: AES-256-GCM, base64(iv[12] || tag[16] || ciphertext)', () => {
  it('round-trips under each info string', () => {
    expect(decryptSecret(encryptSecret(PASSWORD, SMTP_HKDF_INFO, SECRET_A), SMTP_HKDF_INFO, SECRET_A)).toBe(PASSWORD);
    expect(decryptSecret(encryptSecret(TOKEN, TELEGRAM_HKDF_INFO, SECRET_A), TELEGRAM_HKDF_INFO, SECRET_A)).toBe(TOKEN);
  });

  it('frames the payload exactly', () => {
    const raw = Buffer.from(encryptSecret(TOKEN, TELEGRAM_HKDF_INFO, SECRET_A), 'base64');
    expect(raw.length).toBe(12 + 16 + Buffer.byteLength(TOKEN, 'utf8'));
    expect(raw.subarray(28).toString('utf8')).not.toContain('AAHk3f');
  });

  it('produces a fresh IV every time', () => {
    expect(encryptSecret(TOKEN, TELEGRAM_HKDF_INFO, SECRET_A)).not.toBe(encryptSecret(TOKEN, TELEGRAM_HKDF_INFO, SECRET_A));
  });

  it('cannot decrypt the other info string’s payload', () => {
    const smtpPayload = encryptSecret(PASSWORD, SMTP_HKDF_INFO, SECRET_A);
    expect(() => decryptSecret(smtpPayload, TELEGRAM_HKDF_INFO, SECRET_A)).toThrowError(NotifyCredentialError);
  });

  it('produces different ciphertext for identical plaintext under the two infos', () => {
    const a = Buffer.from(encryptSecret(PASSWORD, SMTP_HKDF_INFO, SECRET_A), 'base64').subarray(28);
    const b = Buffer.from(encryptSecret(PASSWORD, TELEGRAM_HKDF_INFO, SECRET_A), 'base64').subarray(28);
    expect(a.equals(b)).toBe(false);
  });

  it('refuses a tampered tag, the wrong key, and a payload of 28 bytes or fewer', () => {
    const payload = encryptSecret(PASSWORD, SMTP_HKDF_INFO, SECRET_A);
    const raw = Buffer.from(payload, 'base64');
    raw[13] ^= 0xff; // inside the tag
    expect(() => decryptSecret(raw.toString('base64'), SMTP_HKDF_INFO, SECRET_A)).toThrowError(NotifyCredentialError);
    expect(() => decryptSecret(payload, SMTP_HKDF_INFO, SECRET_B)).toThrowError(NotifyCredentialError);
    expect(() => decryptSecret(Buffer.alloc(28).toString('base64'), SMTP_HKDF_INFO, SECRET_A)).toThrowError(
      NotifyCredentialError,
    );
  });

  it('MUST-5.4: every failure carries the one user-facing sentence', () => {
    try {
      decryptSecret(Buffer.alloc(20).toString('base64'), SMTP_HKDF_INFO, SECRET_A);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(NotifyCredentialError);
      expect((error as Error).message).toBe(CREDENTIAL_UNREADABLE);
      expect(CREDENTIAL_UNREADABLE).toBe('Stored credential could not be read. Re-enter it.');
    }
  });
});

describe('MUST-5.5: scrubSecrets is load-bearing, not defensive', () => {
  it('redacts a raw token and a raw password anywhere in the text', () => {
    expect(scrubSecrets(`auth failed for ${PASSWORD} twice: ${PASSWORD}`, [PASSWORD])).toBe(
      'auth failed for [redacted] twice: [redacted]',
    );
  });

  it('redacts the token embedded in a Telegram URL path — the reason this exists', () => {
    const message = `request to https://api.telegram.org/bot${TOKEN}/sendMessage failed`;
    const scrubbed = scrubSecrets(message, [TOKEN]);
    expect(scrubbed).toBe('request to https://api.telegram.org/bot[redacted]/sendMessage failed');
    expect(scrubbed).not.toContain('AAHk3f');
  });

  it('redacts the base64 AUTH PLAIN form nodemailer quotes back', () => {
    const authPlain = authPlainBase64('me@example.com', PASSWORD);
    expect(Buffer.from(authPlain, 'base64').toString('utf8')).toBe(`\0me@example.com\0${PASSWORD}`);
    const message = `535 5.7.8 Authentication failed: AUTH PLAIN ${authPlain}`;
    const scrubbed = scrubSecrets(message, [PASSWORD, authPlain]);
    expect(scrubbed).not.toContain(authPlain);
    expect(scrubbed).toContain('[redacted]');
  });

  it('ignores empty and whitespace-only secrets rather than redacting everything', () => {
    expect(scrubSecrets('nothing secret here', ['', '   '])).toBe('nothing secret here');
  });

  it('handles regex metacharacters in a secret literally', () => {
    expect(scrubSecrets('key is a.b*c', ['a.b*c'])).toBe('key is [redacted]');
    expect(scrubSecrets('key is axbyc', ['a.b*c'])).toBe('key is axbyc');
  });

  it('fully redacts both secrets when one is a substring of the other', () => {
    const short = PASSWORD;
    const long = `${PASSWORD}-extra-suffix`;
    const scrubbed = scrubSecrets(`short: ${short} long: ${long}`, [short, long]);
    expect(scrubbed).toBe('short: [redacted] long: [redacted]');
    expect(scrubbed).not.toContain(PASSWORD);
    expect(scrubbed).not.toContain('extra-suffix');
  });
});

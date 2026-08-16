import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { readEnv } from '@/lib/env';

/**
 * Same construction and framing as the TOTP secrets in src/lib/auth/totp.ts,
 * with a different HKDF info string so the two key streams are independent.
 * The stored access URL IS a read-only bank credential (spec section 12 threat
 * model) — it is never logged and never returned to the browser.
 */
export const SIMPLEFIN_HKDF_INFO = 'simplefin-v1';

const IV_BYTES = 12;
const TAG_BYTES = 16;

export function deriveSimplefinKey(secretKey: string = readEnv().secretKey): Buffer {
  const derived = hkdfSync(
    'sha256',
    Buffer.from(secretKey, 'utf8'),
    Buffer.alloc(0),
    Buffer.from(SIMPLEFIN_HKDF_INFO, 'utf8'),
    32,
  );
  return Buffer.from(derived);
}

export function encryptAccessUrl(plain: string, secretKey?: string): string {
  const key = deriveSimplefinKey(secretKey);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
}

export function decryptAccessUrl(payload: string, secretKey?: string): string {
  const raw = Buffer.from(payload, 'base64');
  if (raw.length <= IV_BYTES + TAG_BYTES) throw new Error('malformed SimpleFIN access URL payload');
  const key = deriveSimplefinKey(secretKey);
  const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, IV_BYTES));
  decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
  return Buffer.concat([decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString('utf8');
}

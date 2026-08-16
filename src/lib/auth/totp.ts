import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, randomInt } from 'node:crypto';
import { authenticator } from 'otplib';
import QRCode from 'qrcode';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { totpRecoveryCodes, users } from '@/db/schema';
import { nowIso } from '@/lib/clock';
import { readEnv } from '@/lib/env';

export const TOTP_HKDF_INFO = 'totp-v1';
export const TOTP_ISSUER = 'Budget Tracker';
export const RECOVERY_CODE_COUNT = 8;
export const RECOVERY_CODE_LENGTH = 16;

const IV_BYTES = 12;
const TAG_BYTES = 16;
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

// otplib defaults: SHA-1, 6 digits, 30 s step. Spec requires +/-1 step tolerance.
// A module-local clone avoids mutating otplib's shared singleton (`authenticator.options = ...`
// would silently widen the replay window for any other module that touches the default instance).
const totp = authenticator.clone({ window: 1 });

export function deriveTotpKey(secretKey: string = readEnv().secretKey): Buffer {
  // Salt is empty by design: SECRET_KEY is already high-entropy and per-install.
  const derived = hkdfSync('sha256', Buffer.from(secretKey, 'utf8'), Buffer.alloc(0), Buffer.from(TOTP_HKDF_INFO, 'utf8'), 32);
  return Buffer.from(derived);
}

/** base64( iv[12] || tag[16] || ciphertext ) */
export function encryptTotpSecret(plain: string, secretKey?: string): string {
  const key = deriveTotpKey(secretKey);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString('base64');
}

export function decryptTotpSecret(payload: string, secretKey?: string): string {
  const raw = Buffer.from(payload, 'base64');
  if (raw.length <= IV_BYTES + TAG_BYTES) {
    throw new Error('malformed TOTP payload');
  }
  const key = deriveTotpKey(secretKey);
  const iv = raw.subarray(0, IV_BYTES);
  const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = raw.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

export function generateTotpSecret(): string {
  return totp.generateSecret();
}

export function totpKeyUri(username: string, secret: string, issuer: string = TOTP_ISSUER): string {
  return totp.keyuri(username, issuer, secret);
}

/** otplib has a first-class epoch option — prefer a per-call clone over monkeypatching Date.now. */
function totpAt(at: Date | undefined): typeof totp {
  return at ? totp.clone({ epoch: at.getTime() }) : totp;
}

export function currentTotpToken(secret: string, at?: Date): string {
  return totpAt(at).generate(secret);
}

export function verifyTotp(secret: string, token: string, at?: Date): boolean {
  const cleaned = token.replace(/\s+/g, '');
  if (!/^\d{6,8}$/.test(cleaned)) return false;
  try {
    return totpAt(at).check(cleaned, secret);
  } catch {
    return false;
  }
}

export function generateRecoveryCodes(count: number = RECOVERY_CODE_COUNT): string[] {
  const codes = new Set<string>();
  while (codes.size < count) {
    let code = '';
    for (let i = 0; i < RECOVERY_CODE_LENGTH; i += 1) {
      code += BASE32_ALPHABET[randomInt(BASE32_ALPHABET.length)];
    }
    codes.add(code);
  }
  return [...codes];
}

export function normalizeRecoveryCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z2-7]/g, '');
}

export function hashRecoveryCode(code: string): string {
  return createHash('sha256').update(normalizeRecoveryCode(code)).digest('hex');
}

export function storeRecoveryCodes(userId: number, codes: string[], at: Date = new Date()): void {
  const db = getDb();
  db.transaction((tx) => {
    tx.delete(totpRecoveryCodes).where(eq(totpRecoveryCodes.userId, userId)).run();
    for (const code of codes) {
      tx.insert(totpRecoveryCodes)
        .values({ userId, codeHash: hashRecoveryCode(code), usedAt: null, createdAt: nowIso(at) })
        .run();
    }
  });
}

export function consumeRecoveryCode(userId: number, code: string, at: Date = new Date()): boolean {
  const normalized = normalizeRecoveryCode(code);
  if (normalized.length === 0) return false;
  const result = getDb()
    .update(totpRecoveryCodes)
    .set({ usedAt: nowIso(at) })
    .where(
      and(
        eq(totpRecoveryCodes.userId, userId),
        eq(totpRecoveryCodes.codeHash, hashRecoveryCode(normalized)),
        isNull(totpRecoveryCodes.usedAt),
      ),
    )
    .run();
  return Number(result.changes ?? 0) === 1;
}

export function countUnusedRecoveryCodes(userId: number): number {
  const row = getDb()
    .select({ c: sql<number>`count(*)` })
    .from(totpRecoveryCodes)
    .where(and(eq(totpRecoveryCodes.userId, userId), isNull(totpRecoveryCodes.usedAt)))
    .get();
  return row?.c ?? 0;
}

export function enableTotpForUser(userId: number, secretPlain: string): void {
  getDb()
    .update(users)
    .set({ totpSecretEncrypted: encryptTotpSecret(secretPlain), totpEnabled: true })
    .where(eq(users.id, userId))
    .run();
}

export function getTotpSecretForUser(userId: number): string | null {
  const row = getDb()
    .select({ encrypted: users.totpSecretEncrypted, enabled: users.totpEnabled })
    .from(users)
    .where(eq(users.id, userId))
    .get();
  if (!row || !row.enabled || !row.encrypted) return null;
  return decryptTotpSecret(row.encrypted);
}

/** Admin "reset MFA": lost phone + lost codes must not mean permanent lockout. */
export function clearTotpEnrollment(userId: number): void {
  const db = getDb();
  db.transaction((tx) => {
    tx.update(users).set({ totpSecretEncrypted: null, totpEnabled: false }).where(eq(users.id, userId)).run();
    tx.delete(totpRecoveryCodes).where(eq(totpRecoveryCodes.userId, userId)).run();
  });
}

export async function totpQrDataUri(keyUri: string): Promise<string> {
  return QRCode.toDataURL(keyUri, { errorCorrectionLevel: 'M', margin: 1, width: 240 });
}

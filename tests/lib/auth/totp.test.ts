import { describe, it, expect, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { authenticator } from 'otplib';
import { sql } from 'drizzle-orm';
import { createTestDb, insertTestUser, type TestDb } from '../../helpers/db';
import {
  RECOVERY_CODE_COUNT,
  RECOVERY_CODE_LENGTH,
  TOTP_HKDF_INFO,
  clearTotpEnrollment,
  consumeRecoveryCode,
  countUnusedRecoveryCodes,
  currentTotpToken,
  decryptTotpSecret,
  deriveTotpKey,
  enableTotpForUser,
  encryptTotpSecret,
  generateRecoveryCodes,
  generateTotpSecret,
  getTotpSecretForUser,
  hashRecoveryCode,
  normalizeRecoveryCode,
  storeRecoveryCodes,
  totpKeyUri,
  totpQrDataUri,
  verifyTotp,
} from '@/lib/auth/totp';

let current: TestDb | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
});

const SECRET_A = 'a'.repeat(48);
const SECRET_B = 'b'.repeat(48);

describe('key derivation', () => {
  it('derives a 32-byte key deterministically from SECRET_KEY', () => {
    const k1 = deriveTotpKey(SECRET_A);
    const k2 = deriveTotpKey(SECRET_A);
    expect(k1).toHaveLength(32);
    expect(k1.equals(k2)).toBe(true);
  });

  it('derives a different key from a different SECRET_KEY', () => {
    expect(deriveTotpKey(SECRET_A).equals(deriveTotpKey(SECRET_B))).toBe(false);
  });

  it('pins the HKDF info string so stored secrets stay decryptable', () => {
    expect(TOTP_HKDF_INFO).toBe('totp-v1');
  });
});

describe('encryptTotpSecret / decryptTotpSecret', () => {
  it('round-trips a base32 secret', () => {
    const secret = generateTotpSecret();
    expect(decryptTotpSecret(encryptTotpSecret(secret, SECRET_A), SECRET_A)).toBe(secret);
  });

  it('frames the payload as base64(iv[12] || tag[16] || ciphertext)', () => {
    const secret = 'JBSWY3DPEHPK3PXP';
    const payload = encryptTotpSecret(secret, SECRET_A);
    const raw = Buffer.from(payload, 'base64');
    expect(raw.length).toBe(12 + 16 + Buffer.byteLength(secret, 'utf8'));
    // The tag must not equal the iv, and neither must equal the plaintext bytes.
    expect(raw.subarray(0, 12).equals(raw.subarray(12, 28))).toBe(false);
    expect(raw.subarray(28).toString('utf8')).not.toBe(secret);
  });

  it('produces a different ciphertext each time (random iv)', () => {
    const secret = 'JBSWY3DPEHPK3PXP';
    expect(encryptTotpSecret(secret, SECRET_A)).not.toBe(encryptTotpSecret(secret, SECRET_A));
  });

  it('refuses to decrypt with the wrong SECRET_KEY', () => {
    const payload = encryptTotpSecret('JBSWY3DPEHPK3PXP', SECRET_A);
    expect(() => decryptTotpSecret(payload, SECRET_B)).toThrow();
  });

  it('refuses to decrypt a tampered ciphertext (GCM tag check)', () => {
    const payload = encryptTotpSecret('JBSWY3DPEHPK3PXP', SECRET_A);
    const raw = Buffer.from(payload, 'base64');
    raw[raw.length - 1] ^= 0xff;
    expect(() => decryptTotpSecret(raw.toString('base64'), SECRET_A)).toThrow();
  });

  it('refuses a payload that is too short to contain iv + tag', () => {
    expect(() => decryptTotpSecret(Buffer.alloc(20).toString('base64'), SECRET_A)).toThrowError(/malformed/i);
  });
});

describe('TOTP verification', () => {
  it('accepts the current code', () => {
    const secret = generateTotpSecret();
    const at = new Date('2026-08-15T12:00:00.000Z');
    expect(verifyTotp(secret, currentTotpToken(secret, at), at)).toBe(true);
  });

  it('accepts codes one step early and one step late (±1 tolerance)', () => {
    const secret = generateTotpSecret();
    const at = new Date('2026-08-15T12:00:00.000Z');
    const previous = currentTotpToken(secret, new Date(at.getTime() - 30_000));
    const next = currentTotpToken(secret, new Date(at.getTime() + 30_000));
    expect(verifyTotp(secret, previous, at)).toBe(true);
    expect(verifyTotp(secret, next, at)).toBe(true);
  });

  it('rejects a code two steps away', () => {
    const secret = generateTotpSecret();
    const at = new Date('2026-08-15T12:00:00.000Z');
    const tooOld = currentTotpToken(secret, new Date(at.getTime() - 90_000));
    expect(verifyTotp(secret, tooOld, at)).toBe(false);
  });

  it('rejects garbage without throwing', () => {
    const secret = generateTotpSecret();
    expect(verifyTotp(secret, '')).toBe(false);
    expect(verifyTotp(secret, 'abcdef')).toBe(false);
    expect(verifyTotp(secret, '000000000000')).toBe(false);
    expect(verifyTotp('not-base32!!', '123456')).toBe(false);
  });

  it('tolerates spaces the user pastes in', () => {
    const secret = generateTotpSecret();
    const at = new Date('2026-08-15T12:00:00.000Z');
    const token = currentTotpToken(secret, at);
    expect(verifyTotp(secret, `${token.slice(0, 3)} ${token.slice(3)}`, at)).toBe(true);
  });

  it('builds an otpauth URI otplib itself can parse', () => {
    const secret = generateTotpSecret();
    const uri = totpKeyUri('alice', secret);
    expect(uri.startsWith('otpauth://totp/')).toBe(true);
    expect(uri).toContain('issuer=Budget%20Tracker');
    expect(uri).toContain(`secret=${secret}`);
    expect(authenticator.keyuri('alice', 'Budget Tracker', secret)).toBe(uri);
  });

  it('renders an offline PNG data URI for the QR code', async () => {
    const uri = totpKeyUri('alice', generateTotpSecret());
    const dataUri = await totpQrDataUri(uri);
    expect(dataUri.startsWith('data:image/png;base64,')).toBe(true);
    expect(dataUri.length).toBeGreaterThan(200);
  });
});

describe('recovery codes', () => {
  it('generates 8 codes of 16 base32 characters', () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(RECOVERY_CODE_COUNT);
    expect(RECOVERY_CODE_COUNT).toBe(8);
    expect(RECOVERY_CODE_LENGTH).toBe(16);
    for (const code of codes) {
      expect(code).toMatch(/^[A-Z2-7]{16}$/);
    }
    expect(new Set(codes).size).toBe(8);
  });

  it('hashes with plain SHA-256 of the normalized code', () => {
    expect(hashRecoveryCode('abcd-efgh ijkl mnop')).toBe(createHash('sha256').update('ABCDEFGHIJKLMNOP').digest('hex'));
    expect(normalizeRecoveryCode(' abcd-efgh ')).toBe('ABCDEFGH');
  });

  it('stores hashes only — never the plaintext code', () => {
    current = createTestDb();
    const userId = insertTestUser(current.db);
    const codes = generateRecoveryCodes();
    storeRecoveryCodes(userId, codes);
    const rows = current.sqlite.prepare('select code_hash, used_at from totp_recovery_codes').all() as {
      code_hash: string;
      used_at: string | null;
    }[];
    expect(rows).toHaveLength(8);
    for (const row of rows) {
      expect(row.used_at).toBeNull();
      expect(codes).not.toContain(row.code_hash);
      expect(row.code_hash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('consumes a code exactly once', () => {
    current = createTestDb();
    const userId = insertTestUser(current.db);
    const codes = generateRecoveryCodes();
    storeRecoveryCodes(userId, codes);
    expect(countUnusedRecoveryCodes(userId)).toBe(8);
    expect(consumeRecoveryCode(userId, codes[0])).toBe(true);
    expect(consumeRecoveryCode(userId, codes[0])).toBe(false);
    expect(countUnusedRecoveryCodes(userId)).toBe(7);
  });

  it('accepts a code the user typed with dashes and lowercase', () => {
    current = createTestDb();
    const userId = insertTestUser(current.db);
    const codes = generateRecoveryCodes();
    storeRecoveryCodes(userId, codes);
    const pretty = `${codes[1].slice(0, 4)}-${codes[1].slice(4, 8)}-${codes[1].slice(8, 12)}-${codes[1].slice(12)}`.toLowerCase();
    expect(consumeRecoveryCode(userId, pretty)).toBe(true);
  });

  it('never accepts another user’s code', () => {
    current = createTestDb();
    const alice = insertTestUser(current.db, { username: 'alice' });
    const bob = insertTestUser(current.db, { username: 'bob' });
    const codes = generateRecoveryCodes();
    storeRecoveryCodes(alice, codes);
    expect(consumeRecoveryCode(bob, codes[0])).toBe(false);
  });

  it('replaces the whole set when re-enrolling', () => {
    current = createTestDb();
    const userId = insertTestUser(current.db);
    const first = generateRecoveryCodes();
    storeRecoveryCodes(userId, first);
    const second = generateRecoveryCodes();
    storeRecoveryCodes(userId, second);
    expect(countUnusedRecoveryCodes(userId)).toBe(8);
    expect(consumeRecoveryCode(userId, first[0])).toBe(false);
    expect(consumeRecoveryCode(userId, second[0])).toBe(true);
  });
});

describe('enrollment lifecycle', () => {
  it('enableTotpForUser stores the encrypted secret and flips totp_enabled', () => {
    current = createTestDb();
    const userId = insertTestUser(current.db);
    const secret = generateTotpSecret();
    enableTotpForUser(userId, secret);
    const row = current.sqlite.prepare('select totp_enabled, totp_secret_encrypted from users where id = ?').get(userId) as {
      totp_enabled: number;
      totp_secret_encrypted: string;
    };
    expect(row.totp_enabled).toBe(1);
    expect(row.totp_secret_encrypted).not.toBe(secret);
    expect(getTotpSecretForUser(userId)).toBe(secret);
  });

  it('clearTotpEnrollment is the admin "reset MFA" action', () => {
    current = createTestDb();
    const userId = insertTestUser(current.db);
    enableTotpForUser(userId, generateTotpSecret());
    storeRecoveryCodes(userId, generateRecoveryCodes());
    clearTotpEnrollment(userId);
    const row = current.db.get<{ totp_enabled: number; totp_secret_encrypted: string | null }>(
      sql`select totp_enabled, totp_secret_encrypted from users where id = ${userId}`,
    );
    expect(row.totp_enabled).toBe(0);
    expect(row.totp_secret_encrypted).toBeNull();
    expect(countUnusedRecoveryCodes(userId)).toBe(0);
    expect(getTotpSecretForUser(userId)).toBeNull();
  });
});

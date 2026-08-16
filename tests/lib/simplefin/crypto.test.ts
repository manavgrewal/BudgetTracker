import { describe, it, expect } from 'vitest';
import { SIMPLEFIN_HKDF_INFO, decryptAccessUrl, deriveSimplefinKey, encryptAccessUrl } from '@/lib/simplefin/crypto';
import { deriveTotpKey, TOTP_HKDF_INFO } from '@/lib/auth/totp';

const SECRET_A = 'a'.repeat(48);
const SECRET_B = 'b'.repeat(48);
const ACCESS_URL = 'https://abc123:s3cr3t@beta-bridge.simplefin.org/simplefin';

describe('key derivation', () => {
  it('pins the info string so stored access URLs stay decryptable', () => {
    expect(SIMPLEFIN_HKDF_INFO).toBe('simplefin-v1');
  });

  it('derives a 32-byte key deterministically', () => {
    const key = deriveSimplefinKey(SECRET_A);
    expect(key).toHaveLength(32);
    expect(key.equals(deriveSimplefinKey(SECRET_A))).toBe(true);
    expect(key.equals(deriveSimplefinKey(SECRET_B))).toBe(false);
  });

  it('is a DIFFERENT key stream from the TOTP one, from the same SECRET_KEY', () => {
    expect(TOTP_HKDF_INFO).toBe('totp-v1');
    expect(deriveSimplefinKey(SECRET_A).equals(deriveTotpKey(SECRET_A))).toBe(false);
  });
});

describe('encryptAccessUrl / decryptAccessUrl', () => {
  it('round-trips an access URL with embedded credentials', () => {
    expect(decryptAccessUrl(encryptAccessUrl(ACCESS_URL, SECRET_A), SECRET_A)).toBe(ACCESS_URL);
  });

  it('frames the payload as base64(iv[12] || tag[16] || ciphertext)', () => {
    const raw = Buffer.from(encryptAccessUrl(ACCESS_URL, SECRET_A), 'base64');
    expect(raw.length).toBe(12 + 16 + Buffer.byteLength(ACCESS_URL, 'utf8'));
    expect(raw.subarray(28).toString('utf8')).not.toContain('s3cr3t');
  });

  it('produces a different ciphertext each time', () => {
    expect(encryptAccessUrl(ACCESS_URL, SECRET_A)).not.toBe(encryptAccessUrl(ACCESS_URL, SECRET_A));
  });

  it('refuses the wrong key and a tampered payload', () => {
    const payload = encryptAccessUrl(ACCESS_URL, SECRET_A);
    expect(() => decryptAccessUrl(payload, SECRET_B)).toThrow();
    const raw = Buffer.from(payload, 'base64');
    raw[raw.length - 1] ^= 0xff;
    expect(() => decryptAccessUrl(raw.toString('base64'), SECRET_A)).toThrow();
  });

  it('refuses a payload too short to hold iv + tag', () => {
    expect(() => decryptAccessUrl(Buffer.alloc(20).toString('base64'), SECRET_A)).toThrowError(/malformed/i);
  });

  it('never leaks the credential into the ciphertext string', () => {
    const payload = encryptAccessUrl(ACCESS_URL, SECRET_A);
    expect(payload).not.toContain('s3cr3t');
    expect(payload).not.toContain('abc123');
    expect(payload).not.toContain('simplefin.org');
  });
});

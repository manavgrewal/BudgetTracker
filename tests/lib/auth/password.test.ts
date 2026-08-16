import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword, validatePasswordStrength, MIN_PASSWORD_LENGTH, passwordSchema } from '@/lib/auth/password';

describe('password hashing', () => {
  it('produces an argon2id hash with 64 MiB memory and time cost 3', async () => {
    const hash = await hashPassword('correct horse battery');
    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(hash).toContain('m=65536');
    expect(hash).toContain('t=3');
  });

  it('produces a different hash every time (random salt)', async () => {
    const a = await hashPassword('correct horse battery');
    const b = await hashPassword('correct horse battery');
    expect(a).not.toBe(b);
  });

  it('verifies the right password and rejects the wrong one', async () => {
    const hash = await hashPassword('correct horse battery');
    expect(await verifyPassword(hash, 'correct horse battery')).toBe(true);
    expect(await verifyPassword(hash, 'Correct horse battery')).toBe(false);
    expect(await verifyPassword(hash, '')).toBe(false);
  });

  it('returns false instead of throwing on a malformed stored hash', async () => {
    expect(await verifyPassword('not-a-hash', 'anything')).toBe(false);
  });
});

describe('password policy', () => {
  it('requires 10 characters and nothing else (NIST style)', () => {
    expect(MIN_PASSWORD_LENGTH).toBe(10);
    expect(validatePasswordStrength('0123456789')).toEqual({ ok: true });
    expect(validatePasswordStrength('all lowercase no digits')).toEqual({ ok: true });
    expect(validatePasswordStrength('short')).toEqual({ ok: false, error: 'Password must be at least 10 characters' });
  });

  it('rejects absurdly long input rather than feeding it to argon2', () => {
    const result = validatePasswordStrength('a'.repeat(1025));
    expect(result.ok).toBe(false);
  });

  it('exposes a matching zod schema', () => {
    expect(passwordSchema.safeParse('0123456789').success).toBe(true);
    expect(passwordSchema.safeParse('short').success).toBe(false);
  });
});

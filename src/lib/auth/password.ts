import argon2 from 'argon2';
import { z } from 'zod';

export const MIN_PASSWORD_LENGTH = 10;
export const MAX_PASSWORD_LENGTH = 1024;

/** Spec section 6: argon2id, 64 MiB memory, time cost 3. */
const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 1,
} as const;

export const passwordSchema = z
  .string()
  .min(MIN_PASSWORD_LENGTH, `Password must be at least ${MIN_PASSWORD_LENGTH} characters`)
  .max(MAX_PASSWORD_LENGTH, 'Password is too long');

export function validatePasswordStrength(plain: string): { ok: true } | { ok: false; error: string } {
  if (plain.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` };
  }
  if (plain.length > MAX_PASSWORD_LENGTH) {
    return { ok: false, error: 'Password is too long' };
  }
  return { ok: true };
}

export async function hashPassword(plain: string): Promise<string> {
  const check = validatePasswordStrength(plain);
  if (!check.ok) throw new Error(check.error);
  return argon2.hash(plain, ARGON2_OPTIONS);
}

export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
}

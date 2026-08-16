import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '@/db/client';
import { users } from '@/db/schema';
import { nowIso } from '@/lib/clock';
import { hashPassword, passwordSchema } from './password';

export interface UserRecord {
  id: number;
  name: string;
  username: string;
  role: 'admin' | 'member';
  totpEnabled: boolean;
  isActive: boolean;
  createdAt: string;
}

export interface UserWithSecrets extends UserRecord {
  passwordHash: string;
  totpSecretEncrypted: string | null;
}

export const usernameSchema = z
  .string()
  .transform((value) => value.trim().toLowerCase())
  .pipe(
    z
      .string()
      .min(3, 'Username must be at least 3 characters')
      .max(32, 'Username must be at most 32 characters')
      .regex(/^[a-z0-9._-]+$/, 'Username may contain only letters, digits, dot, underscore and hyphen'),
  );

export const createUserSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(80),
  username: usernameSchema,
  password: passwordSchema,
  role: z.enum(['admin', 'member']),
});

const PUBLIC_COLUMNS = {
  id: users.id,
  name: users.name,
  username: users.username,
  role: users.role,
  totpEnabled: users.totpEnabled,
  isActive: users.isActive,
  createdAt: users.createdAt,
} as const;

export function countUsers(): number {
  const row = getDb().select({ c: sql<number>`count(*)` }).from(users).get();
  return row?.c ?? 0;
}

export function countActiveAdmins(): number {
  const row = getDb()
    .select({ c: sql<number>`count(*)` })
    .from(users)
    .where(and(eq(users.role, 'admin'), eq(users.isActive, true)))
    .get();
  return row?.c ?? 0;
}

export function listUsers(): UserRecord[] {
  return getDb().select(PUBLIC_COLUMNS).from(users).orderBy(users.id).all();
}

export function findUserById(id: number): UserRecord | null {
  return getDb().select(PUBLIC_COLUMNS).from(users).where(eq(users.id, id)).get() ?? null;
}

export function findUserByUsername(username: string): UserWithSecrets | null {
  const normalized = username.trim().toLowerCase();
  const row = getDb()
    .select({ ...PUBLIC_COLUMNS, passwordHash: users.passwordHash, totpSecretEncrypted: users.totpSecretEncrypted })
    .from(users)
    .where(eq(users.username, normalized))
    .get();
  return row ?? null;
}

export function usernameTaken(username: string): boolean {
  return findUserByUsername(username) !== null;
}

export async function createUser(input: {
  name: string;
  username: string;
  password: string;
  role: 'admin' | 'member';
}): Promise<UserRecord> {
  const parsed = createUserSchema.parse(input);
  if (usernameTaken(parsed.username)) {
    throw new Error(`Username "${parsed.username}" is already taken`);
  }
  const passwordHash = await hashPassword(parsed.password);
  const row = getDb()
    .insert(users)
    .values({
      name: parsed.name,
      username: parsed.username,
      passwordHash,
      role: parsed.role,
      totpSecretEncrypted: null,
      totpEnabled: false,
      isActive: true,
      createdAt: nowIso(),
    })
    .returning(PUBLIC_COLUMNS)
    .get();
  return row;
}

/**
 * Atomic first-admin creation for /setup (fixes a TOCTOU: `hashPassword` is a real
 * await/yield point, so a plain "check isSetupRequired() then insert" split around
 * it lets two simultaneous first-run visitors both observe an empty table and both
 * become admin). The hash happens BEFORE the atomic section; the count-check and
 * the insert are then wrapped in a single synchronous db.transaction with no yield
 * point between them, so only the first caller to reach the transaction can ever
 * see count === 0 — every other caller sees the just-inserted row and throws.
 */
export async function createFirstAdmin(input: { name: string; username: string; password: string }): Promise<UserRecord> {
  const parsed = createUserSchema.parse({ ...input, role: 'admin' });
  const passwordHash = await hashPassword(parsed.password);
  return getDb().transaction((tx) => {
    const row = tx.select({ c: sql<number>`count(*)` }).from(users).get();
    if ((row?.c ?? 0) > 0) {
      throw new Error('Setup has already been completed');
    }
    return tx
      .insert(users)
      .values({
        name: parsed.name,
        username: parsed.username,
        passwordHash,
        role: 'admin',
        totpSecretEncrypted: null,
        totpEnabled: false,
        isActive: true,
        createdAt: nowIso(),
      })
      .returning(PUBLIC_COLUMNS)
      .get();
  });
}

export async function setUserPassword(userId: number, newPassword: string): Promise<void> {
  const password = passwordSchema.parse(newPassword);
  const passwordHash = await hashPassword(password);
  getDb().update(users).set({ passwordHash }).where(eq(users.id, userId)).run();
}

/** Deactivate, never delete — attribution history must survive. */
export function setUserActive(userId: number, active: boolean): void {
  if (!active) {
    const target = findUserById(userId);
    if (target?.role === 'admin' && target.isActive && countActiveAdmins() <= 1) {
      throw new Error('Cannot deactivate the last active admin');
    }
  }
  getDb().update(users).set({ isActive: active }).where(eq(users.id, userId)).run();
}

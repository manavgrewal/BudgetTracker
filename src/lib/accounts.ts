import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '@/db/client';
import { accounts } from '@/db/schema';
import { nowIso } from '@/lib/clock';

export type AccountType = 'chequing' | 'credit' | 'cash';

export interface AccountRecord {
  id: number;
  name: string;
  institution: string;
  type: AccountType;
  ownerUserId: number | null;
  importProfileId: number | null;
  isActive: boolean;
  createdAt: string;
}

export const createAccountSchema = z.object({
  name: z.string().trim().min(1, 'Account name is required').max(80),
  // Optional: a cash jar or a credit union nobody has a tidy name for still
  // deserves an account row. The column is NOT NULL, so it stores '' when the
  // family leaves it blank rather than refusing the whole account.
  institution: z.string().trim().max(80).default(''),
  type: z.enum(['chequing', 'credit', 'cash']),
  ownerUserId: z.number().int().positive().nullable(),
  importProfileId: z.number().int().positive().nullable().optional(),
});

export const renameAccountSchema = z.string().trim().min(1, 'Account name is required').max(80);

export function listAccounts(opts: { includeInactive?: boolean } = {}): AccountRecord[] {
  const query = getDb().select().from(accounts);
  const rows = opts.includeInactive
    ? query.orderBy(asc(accounts.id)).all()
    : query.where(eq(accounts.isActive, true)).orderBy(asc(accounts.id)).all();
  return rows;
}

export function getAccount(id: number): AccountRecord | null {
  return getDb().select().from(accounts).where(eq(accounts.id, id)).get() ?? null;
}

export function createAccount(input: {
  name: string;
  institution?: string;
  type: AccountType;
  ownerUserId: number | null;
  importProfileId?: number | null;
}): number {
  const parsed = createAccountSchema.parse(input);
  const row = getDb()
    .insert(accounts)
    .values({
      name: parsed.name,
      institution: parsed.institution,
      type: parsed.type,
      ownerUserId: parsed.ownerUserId,
      importProfileId: parsed.importProfileId ?? null,
      isActive: true,
      createdAt: nowIso(),
    })
    .returning({ id: accounts.id })
    .get();
  return row.id;
}

export function setAccountActive(id: number, active: boolean): void {
  getDb().update(accounts).set({ isActive: active }).where(eq(accounts.id, id)).run();
}

/** Display name only — never touches the id, so history, imports and dedup are unaffected. */
export function renameAccount(id: number, name: string): void {
  getDb().update(accounts).set({ name: renameAccountSchema.parse(name) }).where(eq(accounts.id, id)).run();
}

/** null = Joint/household (spec section 3: owner_user_id NULL means joint). */
export function setAccountOwner(id: number, ownerUserId: number | null): void {
  getDb().update(accounts).set({ ownerUserId }).where(eq(accounts.id, id)).run();
}

/** Each user gets one personal Cash account, created on demand for manual entries. */
export function getOrCreateCashAccount(userId: number, userName: string): number {
  const existing = getDb()
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.ownerUserId, userId), eq(accounts.type, 'cash')))
    .get();
  if (existing) return existing.id;
  return createAccount({ name: `${userName} Cash`, institution: 'Cash', type: 'cash', ownerUserId: userId });
}

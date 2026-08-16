import { describe, it, expect, vi, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTestDb, type TestDb } from '../helpers/db';

// requireAdmin is the only thing these actions need from the session module; everything
// else (users, sessions, TOTP) runs against a real test database so the writes are real.
const ADMIN = { id: 1, name: 'Alice', username: 'alice', role: 'admin' as const };

vi.mock('@/lib/auth/session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/session')>();
  return { ...actual, requireAdmin: vi.fn(async () => ADMIN) };
});

vi.mock('next/headers', () => ({
  headers: async () => new Headers({ origin: 'http://nas.local:3000', host: 'nas.local:3000' }),
}));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

import { createUserAction, resetMfaAction, resetPasswordAction } from '@/app/(app)/settings/users/actions';
import { createSession } from '@/lib/auth/session';
import { createUser, findUserByUsername, mustChangePassword } from '@/lib/auth/users';
import { enableTotpForUser, generateTotpSecret } from '@/lib/auth/totp';

let current: TestDb | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
});

function formData(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

function sessionCount(userId: number): number {
  return (
    current!.db.get<{ c: number }>(sql`select count(*) as c from sessions where user_id = ${userId}`)?.c ?? 0
  );
}

describe('createUserAction — forced password change (spec v1.5)', () => {
  it('flags the new user: the admin typed their password, so they must replace it', async () => {
    current = createTestDb();
    const result = await createUserAction(
      {},
      formData({ name: 'Bob', username: 'bob', password: 'correct horse battery', role: 'member' }),
    );
    expect(result.error).toBeUndefined();
    const bob = findUserByUsername('bob');
    expect(bob).not.toBeNull();
    expect(bob!.mustChangePassword).toBe(true);
    expect(result.message).toMatch(/change it at first sign-in/i);
  });
});

describe('resetPasswordAction — forced password change (spec v1.5)', () => {
  it('flags the target and destroys every one of their sessions', async () => {
    current = createTestDb();
    const bob = await createUser({ name: 'Bob', username: 'bob', password: 'correct horse battery', role: 'member' });
    createSession(bob.id);
    createSession(bob.id);
    expect(sessionCount(bob.id)).toBe(2);

    const result = await resetPasswordAction({}, formData({ userId: String(bob.id), password: 'a whole new password' }));
    expect(result.error).toBeUndefined();
    expect(mustChangePassword(bob.id)).toBe(true);
    expect(sessionCount(bob.id)).toBe(0);
  });
});

describe('resetMfaAction — polish item 12', () => {
  it('destroys the target user’s sessions, mirroring resetPasswordAction', async () => {
    current = createTestDb();
    const bob = await createUser({ name: 'Bob', username: 'bob', password: 'correct horse battery', role: 'member' });
    enableTotpForUser(bob.id, generateTotpSecret());
    createSession(bob.id);
    createSession(bob.id);
    expect(sessionCount(bob.id)).toBe(2);

    const result = await resetMfaAction({}, formData({ userId: String(bob.id) }));
    expect(result.error).toBeUndefined();
    expect(findUserByUsername('bob')?.totpEnabled).toBe(false);
    // A live session opened under the old MFA must not outlive it.
    expect(sessionCount(bob.id)).toBe(0);
  });

  it('does not touch anyone else’s sessions', async () => {
    current = createTestDb();
    const bob = await createUser({ name: 'Bob', username: 'bob', password: 'correct horse battery', role: 'member' });
    const carol = await createUser({ name: 'Carol', username: 'carol', password: 'correct horse battery', role: 'member' });
    createSession(bob.id);
    createSession(carol.id);

    await resetMfaAction({}, formData({ userId: String(bob.id) }));
    expect(sessionCount(bob.id)).toBe(0);
    expect(sessionCount(carol.id)).toBe(1);
  });
});

describe('MFA reset does not raise the password flag', () => {
  it('clearing MFA is not a password event', async () => {
    current = createTestDb();
    const bob = await createUser({ name: 'Bob', username: 'bob', password: 'correct horse battery', role: 'member' });
    await resetMfaAction({}, formData({ userId: String(bob.id) }));
    expect(mustChangePassword(bob.id)).toBe(false);
  });
});

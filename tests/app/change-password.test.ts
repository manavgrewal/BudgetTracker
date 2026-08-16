import { describe, it, expect, vi, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTestDb, type TestDb } from '../helpers/db';

// No session mocking here on purpose: the cookie store below hands requireUser() a real
// token, so validateSession runs against the real test database and the whole
// login-session-flag path is exercised end to end.
let currentToken = '';

const cookieStore = {
  get: (name: string) => (name === 'bt_session' && currentToken ? { value: currentToken } : undefined),
  set: vi.fn(),
  delete: vi.fn(),
};

vi.mock('next/headers', () => ({
  headers: async () => new Headers({ origin: 'http://nas.local:3000', host: 'nas.local:3000' }),
  cookies: async () => cookieStore,
}));

class RedirectError extends Error {
  constructor(public readonly location: string) {
    super(`NEXT_REDIRECT:${location}`);
  }
}

vi.mock('next/navigation', () => ({
  redirect: (location: string) => {
    throw new RedirectError(location);
  },
}));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

import AppLayout from '@/app/(app)/layout';
import { forcedChangePasswordAction } from '@/app/(auth)/change-password/actions';
import { SESSION_COOKIE_NAME, createSession } from '@/lib/auth/session';
import { verifyPassword } from '@/lib/auth/password';
import { createUser, findUserByUsername, mustChangePassword, setMustChangePassword } from '@/lib/auth/users';

let current: TestDb | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
  currentToken = '';
});

const PASSWORD = 'correct horse battery';

function formData(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

async function signedInFlaggedUser() {
  current = createTestDb();
  const bob = await createUser({
    name: 'Bob',
    username: 'bob',
    password: PASSWORD,
    role: 'member',
    mustChangePassword: true,
  });
  const here = createSession(bob.id);
  const elsewhere = createSession(bob.id);
  currentToken = here.token;
  return { bob, here, elsewhere };
}

function sessionCount(userId: number): number {
  return current!.db.get<{ c: number }>(sql`select count(*) as c from sessions where user_id = ${userId}`)?.c ?? 0;
}

async function redirectFrom(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run();
    return null;
  } catch (error) {
    if (error instanceof RedirectError) return error.location;
    throw error;
  }
}

describe('the cookie name this suite pins', () => {
  it('matches the real session cookie name', () => {
    expect(SESSION_COOKIE_NAME).toBe('bt_session');
  });
});

describe('app layout gate (spec v1.5)', () => {
  it('bounces a flagged user off every app page to /change-password', async () => {
    await signedInFlaggedUser();
    expect(await redirectFrom(() => AppLayout({ children: null }))).toBe('/change-password');
  });

  it('lets an unflagged user through', async () => {
    const { bob } = await signedInFlaggedUser();
    setMustChangePassword(bob.id, false);
    expect(await redirectFrom(() => AppLayout({ children: null }))).toBeNull();
  });

  it('still sends a signed-out visitor to /login, not to the interstitial', async () => {
    current = createTestDb();
    currentToken = '';
    expect(await redirectFrom(() => AppLayout({ children: null }))).toBe('/login');
  });
});

describe('forcedChangePasswordAction (spec v1.5)', () => {
  it('rejects a cross-origin submission before anything else', async () => {
    await signedInFlaggedUser();
    const headersModule = await import('next/headers');
    const spy = vi.spyOn(headersModule, 'headers').mockResolvedValue(
      new Headers({ origin: 'http://evil.example', host: 'nas.local:3000' }) as never,
    );
    const result = await forcedChangePasswordAction({}, formData({ currentPassword: PASSWORD, newPassword: 'a whole new password' }));
    expect(result.error).toMatch(/cross-origin/i);
    spy.mockRestore();
  });

  it('rejects a wrong current password and leaves the flag up', async () => {
    const { bob } = await signedInFlaggedUser();
    const result = await forcedChangePasswordAction(
      {},
      formData({ currentPassword: 'not the password', newPassword: 'a whole new password' }),
    );
    expect(result.error).toMatch(/current password is incorrect/i);
    expect(mustChangePassword(bob.id)).toBe(true);
  });

  it('rejects a new password under the minimum length', async () => {
    const { bob } = await signedInFlaggedUser();
    const result = await forcedChangePasswordAction({}, formData({ currentPassword: PASSWORD, newPassword: 'short' }));
    expect(result.error).toMatch(/at least 10 characters/i);
    expect(mustChangePassword(bob.id)).toBe(true);
  });

  it('refuses to "change" the password to the same one', async () => {
    const { bob } = await signedInFlaggedUser();
    const result = await forcedChangePasswordAction({}, formData({ currentPassword: PASSWORD, newPassword: PASSWORD }));
    expect(result.error).toMatch(/not used here before/i);
    expect(mustChangePassword(bob.id)).toBe(true);
  });

  it('clears the flag, stores the new hash, and redirects to the dashboard', async () => {
    const { bob } = await signedInFlaggedUser();
    const location = await redirectFrom(() =>
      forcedChangePasswordAction({}, formData({ currentPassword: PASSWORD, newPassword: 'a whole new password' })),
    );
    expect(location).toBe('/dashboard');
    expect(mustChangePassword(bob.id)).toBe(false);
    const hash = findUserByUsername('bob')!.passwordHash;
    expect(await verifyPassword(hash, 'a whole new password')).toBe(true);
    expect(await verifyPassword(hash, PASSWORD)).toBe(false);
  });

  it('destroys the user’s OTHER sessions and keeps the current one alive', async () => {
    const { bob, here } = await signedInFlaggedUser();
    expect(sessionCount(bob.id)).toBe(2);

    await redirectFrom(() =>
      forcedChangePasswordAction({}, formData({ currentPassword: PASSWORD, newPassword: 'a whole new password' })),
    );

    expect(sessionCount(bob.id)).toBe(1);
    // ...and the survivor is specifically the browser that did the change.
    const { validateSession } = await import('@/lib/auth/session');
    expect(validateSession(here.token)?.id).toBe(bob.id);
  });

  it('leaves other users’ sessions alone', async () => {
    const { bob } = await signedInFlaggedUser();
    const carol = await createUser({ name: 'Carol', username: 'carol', password: PASSWORD, role: 'member' });
    createSession(carol.id);

    await redirectFrom(() =>
      forcedChangePasswordAction({}, formData({ currentPassword: PASSWORD, newPassword: 'a whole new password' })),
    );

    expect(sessionCount(bob.id)).toBe(1);
    expect(sessionCount(carol.id)).toBe(1);
  });
});

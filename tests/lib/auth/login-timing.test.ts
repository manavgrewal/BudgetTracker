import { describe, it, expect, afterEach, vi } from 'vitest';
import { createTestDb, type TestDb } from '../../helpers/db';

// Isolated in its own file (Vitest gives each test file its own module registry
// under the "forks" pool) so this mock never leaks into tests/lib/auth/login.test.ts.
// hashPassword is passed through untouched — only verifyPassword is wrapped in a
// spy — so createUser/setUserPassword elsewhere in the suite are unaffected.
vi.mock('@/lib/auth/password', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/password')>();
  return { ...actual, verifyPassword: vi.fn(actual.verifyPassword) };
});

import { verifyPassword } from '@/lib/auth/password';
import { attemptLogin } from '@/lib/auth/login';
import { createUser } from '@/lib/auth/users';

let current: TestDb | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
});

const PASSWORD = 'correct horse battery';
const IP = '10.0.0.5';

describe('attemptLogin — timing/enumeration oracle (ruling c)', () => {
  it('runs a dummy password verification for an unknown username, so the response cost matches a real user', async () => {
    current = createTestDb();
    vi.mocked(verifyPassword).mockClear();
    const result = await attemptLogin({ username: 'nobody', password: 'irrelevant password', ip: IP });
    expect(result.status).toBe('invalid');
    expect(verifyPassword).toHaveBeenCalledTimes(1);
  });

  it('runs a dummy password verification for a deactivated user too, not just an unknown one', async () => {
    current = createTestDb();
    const { setUserActive } = await import('@/lib/auth/users');
    const alice = await createUser({ name: 'Alice', username: 'alice', password: PASSWORD, role: 'admin' });
    await createUser({ name: 'Bob', username: 'bob', password: PASSWORD, role: 'admin' });
    setUserActive(alice.id, false);
    vi.mocked(verifyPassword).mockClear();
    const result = await attemptLogin({ username: 'alice', password: PASSWORD, ip: IP });
    expect(result.status).toBe('invalid');
    expect(verifyPassword).toHaveBeenCalledTimes(1);
  });

  it('still runs exactly one verify for a real user with a wrong password (unchanged cost)', async () => {
    current = createTestDb();
    await createUser({ name: 'Alice', username: 'alice', password: PASSWORD, role: 'admin' });
    vi.mocked(verifyPassword).mockClear();
    const result = await attemptLogin({ username: 'alice', password: 'wrong password!!', ip: IP });
    expect(result.status).toBe('invalid');
    expect(verifyPassword).toHaveBeenCalledTimes(1);
  });
});

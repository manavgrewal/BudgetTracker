import { describe, it, expect, afterEach, vi } from 'vitest';
import { createTestDb, type TestDb } from '../helpers/db';
import { createUser } from '@/lib/auth/users';

// Server Actions read next/headers()/cookies() via Next's request-scoped
// AsyncLocalStorage, which only exists inside a real Next.js request. Outside of
// that (as here, importing the action function directly), both must be mocked.
function createFakeCookieStore() {
  const store = new Map<string, { value: string }>();
  return {
    get: (name: string) => store.get(name),
    set: (name: string, value: string) => {
      store.set(name, { value });
    },
    delete: (name: string) => {
      store.delete(name);
    },
  };
}

let mockHeaders = new Headers();
const fakeCookies = createFakeCookieStore();

vi.mock('next/headers', () => ({
  headers: async () => mockHeaders,
  cookies: async () => fakeCookies,
}));

vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw Object.assign(new Error(`NEXT_REDIRECT:${url}`), { digest: `NEXT_REDIRECT;replace;${url};307;` });
  },
}));

vi.mock('@/lib/auth/session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/session')>();
  return { ...actual, shouldUseSecureCookie: vi.fn(actual.shouldUseSecureCookie) };
});

import { shouldUseSecureCookie } from '@/lib/auth/session';
import { loginAction, type LoginFormState } from '@/app/(auth)/login/actions';

let current: TestDb | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
  vi.mocked(shouldUseSecureCookie).mockClear();
});

const PASSWORD = 'correct horse battery';
const SAME_ORIGIN_HEADERS = new Headers({ origin: 'http://nas.local:3000', host: 'nas.local:3000' });

function formData(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

describe('loginAction — finding 2: same-origin check on every mutating action', () => {
  it('rejects a cross-origin submission (first thing, before any DB work)', async () => {
    current = createTestDb();
    mockHeaders = new Headers({ origin: 'http://evil.local', host: 'nas.local:3000' });
    const result = await loginAction({}, formData({ username: 'alice', password: PASSWORD }));
    expect(result.error).toMatch(/cross-origin/i);
  });
});

describe('loginAction — finding 5: TOTP-step dead-end', () => {
  it('preserves needsTotp across a client-side validation failure (e.g. blank re-typed password) instead of silently dropping the TOTP step', async () => {
    current = createTestDb();
    mockHeaders = SAME_ORIGIN_HEADERS;
    const prev: LoginFormState = { needsTotp: true, username: 'alice' };
    const result = await loginAction(prev, formData({ username: 'alice', password: '', totpCode: '123456' }));
    expect(result.needsTotp).toBe(true);
  });
});

describe('loginAction — finding 4: secure-cookie protocol arg', () => {
  it('passes the literal "http:" to shouldUseSecureCookie on a successful login (controller ruling; never a client-derived value)', async () => {
    current = createTestDb();
    mockHeaders = SAME_ORIGIN_HEADERS;
    await createUser({ name: 'Alice', username: 'alice', password: PASSWORD, role: 'admin' });
    await expect(loginAction({}, formData({ username: 'alice', password: PASSWORD }))).rejects.toThrow(/NEXT_REDIRECT/);
    expect(shouldUseSecureCookie).toHaveBeenCalledWith('http:', expect.anything());
  });
});

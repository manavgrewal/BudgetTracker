import { describe, it, expect, afterEach } from 'vitest';
import { createTestDb, insertTestUser, type TestDb } from '../helpers/db';
import { POST } from '@/app/api/auth/logout/route';
import { createSession, validateSession, SESSION_COOKIE_NAME } from '@/lib/auth/session';

let current: TestDb | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
});

function request(token: string | null, body: Record<string, string> = {}, origin = 'http://nas.local:3000') {
  const form = new URLSearchParams(body);
  return new Request('http://nas.local:3000/api/auth/logout', {
    method: 'POST',
    headers: {
      origin,
      host: 'nas.local:3000',
      'content-type': 'application/x-www-form-urlencoded',
      ...(token ? { cookie: `${SESSION_COOKIE_NAME}=${token}` } : {}),
    },
    body: form.toString(),
  });
}

describe('POST /api/auth/logout', () => {
  it('destroys the current session and clears the cookie', async () => {
    current = createTestDb();
    const userId = insertTestUser(current.db);
    const { token } = createSession(userId);
    const response = await POST(request(token));
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/login');
    expect(response.headers.get('set-cookie')).toContain(`${SESSION_COOKIE_NAME}=;`);
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
    expect(validateSession(token)).toBeNull();
  });

  it('supports "log out everywhere"', async () => {
    current = createTestDb();
    const userId = insertTestUser(current.db);
    const a = createSession(userId);
    const b = createSession(userId);
    await POST(request(a.token, { scope: 'all' }));
    expect(validateSession(a.token)).toBeNull();
    expect(validateSession(b.token)).toBeNull();
  });

  it('leaves other users’ sessions alone', async () => {
    current = createTestDb();
    const alice = insertTestUser(current.db, { username: 'alice' });
    const bob = insertTestUser(current.db, { username: 'bob' });
    const a = createSession(alice);
    const b = createSession(bob);
    await POST(request(a.token, { scope: 'all' }));
    expect(validateSession(b.token)).not.toBeNull();
  });

  it('rejects a cross-origin POST with 403', async () => {
    current = createTestDb();
    const userId = insertTestUser(current.db);
    const { token } = createSession(userId);
    const response = await POST(request(token, {}, 'http://evil.local'));
    expect(response.status).toBe(403);
    expect(validateSession(token)).not.toBeNull();
  });

  it('still redirects when there is no session cookie', async () => {
    current = createTestDb();
    const response = await POST(request(null));
    expect(response.status).toBe(303);
  });
});

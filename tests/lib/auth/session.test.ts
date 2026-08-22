import { describe, it, expect, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { createTestDb, insertTestUser, type TestDb } from '../../helpers/db';
import {
  SESSION_COOKIE_NAME,
  SESSION_TTL_MS,
  createSession,
  destroyAllSessionsForUser,
  destroySession,
  generateSessionToken,
  hashSessionToken,
  purgeExpiredSessions,
  sessionCookieOptions,
  shouldUseSecureCookie,
  userFromRequest,
  validateSession,
} from '@/lib/auth/session';

let current: TestDb | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
});

describe('session tokens', () => {
  it('generates 256 bits of entropy, base64url encoded', () => {
    const token = generateSessionToken();
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(generateSessionToken()).not.toBe(token);
  });

  it('stores only the SHA-256 of the token', () => {
    current = createTestDb();
    const userId = insertTestUser(current.db, { username: 'alice' });
    const { token } = createSession(userId);
    const rows = current.sqlite.prepare('select token_hash from sessions').all() as { token_hash: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].token_hash).toBe(createHash('sha256').update(token).digest('hex'));
    expect(rows[0].token_hash).not.toContain(token);
    expect(hashSessionToken(token)).toBe(rows[0].token_hash);
  });
});

describe('createSession / validateSession', () => {
  it('returns the session user for a valid token', () => {
    current = createTestDb();
    const userId = insertTestUser(current.db, { name: 'Alice', username: 'alice', role: 'admin' });
    const { token } = createSession(userId, { userAgent: 'vitest', ip: '10.0.0.5' });
    expect(validateSession(token)).toEqual({ id: userId, name: 'Alice', username: 'alice', role: 'admin' });
  });

  it('rejects unknown, empty and tampered tokens', () => {
    current = createTestDb();
    insertTestUser(current.db, { username: 'alice' });
    expect(validateSession('')).toBeNull();
    expect(validateSession('not-a-real-token')).toBeNull();
  });

  it('sets a 30-day expiry', () => {
    current = createTestDb();
    const userId = insertTestUser(current.db);
    const at = new Date('2026-08-15T12:00:00.000Z');
    const { expiresAt } = createSession(userId, { at });
    expect(new Date(expiresAt).getTime() - at.getTime()).toBe(SESSION_TTL_MS);
    expect(SESSION_TTL_MS).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it('rejects an expired session and does not slide it back to life', () => {
    current = createTestDb();
    const userId = insertTestUser(current.db);
    const at = new Date('2026-01-01T00:00:00.000Z');
    const { token } = createSession(userId, { at });
    const later = new Date('2026-03-01T00:00:00.000Z');
    expect(validateSession(token, later)).toBeNull();
  });

  it('slides the expiry forward on use, at most once per day', () => {
    current = createTestDb();
    const userId = insertTestUser(current.db);
    const created = new Date('2026-01-01T00:00:00.000Z');
    const { token } = createSession(userId, { at: created });
    const readExpiry = () =>
      (current!.sqlite.prepare('select expires_at, last_seen_at from sessions').get() as { expires_at: string; last_seen_at: string });

    const firstExpiry = readExpiry().expires_at;

    // One hour later: too soon to slide.
    validateSession(token, new Date('2026-01-01T01:00:00.000Z'));
    expect(readExpiry().expires_at).toBe(firstExpiry);

    // Two days later: slides.
    const slideAt = new Date('2026-01-03T00:00:00.000Z');
    validateSession(token, slideAt);
    const after = readExpiry();
    expect(new Date(after.expires_at).getTime()).toBe(slideAt.getTime() + SESSION_TTL_MS);
    expect(after.last_seen_at).toBe(slideAt.toISOString());
  });

  it('refuses sessions belonging to a deactivated user', () => {
    current = createTestDb();
    const userId = insertTestUser(current.db, { username: 'bob' });
    const { token } = createSession(userId);
    current.db.run(sql`update users set is_active = 0 where id = ${userId}`);
    expect(validateSession(token)).toBeNull();
  });
});

describe('session teardown', () => {
  it('destroySession removes exactly that session', () => {
    current = createTestDb();
    const userId = insertTestUser(current.db);
    const a = createSession(userId);
    const b = createSession(userId);
    destroySession(a.token);
    expect(validateSession(a.token)).toBeNull();
    expect(validateSession(b.token)).not.toBeNull();
  });

  it('destroyAllSessionsForUser is "log out everywhere"', () => {
    current = createTestDb();
    const alice = insertTestUser(current.db, { username: 'alice' });
    const bob = insertTestUser(current.db, { username: 'bob' });
    const a1 = createSession(alice);
    const a2 = createSession(alice);
    const b1 = createSession(bob);
    expect(destroyAllSessionsForUser(alice)).toBe(2);
    expect(validateSession(a1.token)).toBeNull();
    expect(validateSession(a2.token)).toBeNull();
    expect(validateSession(b1.token)).not.toBeNull();
  });

  it('purgeExpiredSessions deletes only expired rows', () => {
    current = createTestDb();
    const userId = insertTestUser(current.db);
    createSession(userId, { at: new Date('2026-01-01T00:00:00.000Z') });
    createSession(userId, { at: new Date('2026-08-01T00:00:00.000Z') });
    const purged = purgeExpiredSessions(new Date('2026-08-15T00:00:00.000Z'));
    expect(purged).toBe(1);
    const remaining = current.sqlite.prepare('select count(*) as c from sessions').get() as { c: number };
    expect(remaining.c).toBe(1);
  });
});

describe('cookie policy', () => {
  it('is httpOnly, SameSite=Lax and path=/', () => {
    const options = sessionCookieOptions({ secure: false, expiresAt: '2026-09-14T00:00:00.000Z' });
    expect(options.httpOnly).toBe(true);
    expect(options.sameSite).toBe('lax');
    expect(options.path).toBe('/');
    expect(options.secure).toBe(false);
    expect(options.expires.toISOString()).toBe('2026-09-14T00:00:00.000Z');
  });

  it('turns Secure on for a direct https request URL, regardless of headers/env', () => {
    const env = { secretKey: 'x'.repeat(32), trustProxy: false, tz: 'UTC', port: 3000, dataDir: '/data', watchtowerUrl: null, watchtowerToken: null, ocrEngineOverride: null };
    // https request URL → secure, even with no trust-proxy and no forwarded headers.
    expect(shouldUseSecureCookie('https:', new Headers({}), env)).toBe(true);
    // http URL + trustProxy off → not secure.
    expect(shouldUseSecureCookie('http:', new Headers({}), env)).toBe(false);
  });

  it('honours X-Forwarded-Proto only when TRUST_PROXY is on', () => {
    const off = { secretKey: 'x'.repeat(32), trustProxy: false, tz: 'UTC', port: 3000, dataDir: '/data', watchtowerUrl: null, watchtowerToken: null, ocrEngineOverride: null };
    const on = { ...off, trustProxy: true };
    const headers = new Headers({ 'x-forwarded-proto': 'https' });
    // http URL + trustProxy off → not secure, even with a forwarded https header.
    expect(shouldUseSecureCookie('http:', headers, off)).toBe(false);
    // http URL + trustProxy on + x-forwarded-proto https → secure.
    expect(shouldUseSecureCookie('http:', headers, on)).toBe(true);
    expect(shouldUseSecureCookie('http:', new Headers({ 'x-forwarded-proto': 'http' }), on)).toBe(false);
    // A proxy may send a comma-separated list; the first entry wins.
    expect(shouldUseSecureCookie('http:', new Headers({ 'x-forwarded-proto': 'https, http' }), on)).toBe(true);
  });
});

describe('userFromRequest', () => {
  it('reads the session cookie straight off a Request', () => {
    current = createTestDb();
    const userId = insertTestUser(current.db, { name: 'Carol', username: 'carol', role: 'member' });
    const { token } = createSession(userId);
    const request = new Request('http://nas.local:3000/api/x', {
      headers: { cookie: `theme=dark; ${SESSION_COOKIE_NAME}=${token}; other=1` },
    });
    expect(userFromRequest(request)).toEqual({ id: userId, name: 'Carol', username: 'carol', role: 'member' });
  });

  it('returns null when the cookie header is absent or the cookie is missing', () => {
    current = createTestDb();
    expect(userFromRequest(new Request('http://nas.local:3000/api/x'))).toBeNull();
    expect(userFromRequest(new Request('http://nas.local:3000/api/x', { headers: { cookie: 'theme=dark' } }))).toBeNull();
  });
});

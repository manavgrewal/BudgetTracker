import { createHash, randomBytes } from 'node:crypto';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { and, eq, lt, ne } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { sessions, users } from '@/db/schema';
import { nowIso } from '@/lib/clock';
import { readEnv, type AppEnv } from '@/lib/env';
import { SESSION_COOKIE_NAME, SESSION_RENEW_AFTER_MS, SESSION_TTL_MS } from './session-constants';

export { SESSION_COOKIE_NAME, SESSION_TTL_MS } from './session-constants';

export interface SessionUser {
  id: number;
  name: string;
  username: string;
  role: 'admin' | 'member';
}

export function generateSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function createSession(
  userId: number,
  meta: { userAgent?: string | null; ip?: string | null; at?: Date } = {},
): { token: string; expiresAt: string } {
  const at = meta.at ?? new Date();
  const token = generateSessionToken();
  const expiresAt = new Date(at.getTime() + SESSION_TTL_MS).toISOString();
  getDb()
    .insert(sessions)
    .values({
      tokenHash: hashSessionToken(token),
      userId,
      createdAt: nowIso(at),
      expiresAt,
      lastSeenAt: nowIso(at),
      userAgent: meta.userAgent ?? null,
      ip: meta.ip ?? null,
    })
    .run();
  return { token, expiresAt };
}

export function validateSession(token: string, at: Date = new Date()): SessionUser | null {
  if (!token) return null;
  const tokenHash = hashSessionToken(token);
  const db = getDb();
  const row = db
    .select({
      tokenHash: sessions.tokenHash,
      expiresAt: sessions.expiresAt,
      lastSeenAt: sessions.lastSeenAt,
      id: users.id,
      name: users.name,
      username: users.username,
      role: users.role,
      isActive: users.isActive,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(eq(sessions.tokenHash, tokenHash))
    .get();

  if (!row) return null;
  if (!row.isActive) return null;
  const nowMs = at.getTime();
  if (new Date(row.expiresAt).getTime() <= nowMs) return null;

  // Sliding expiry, throttled so every request does not write.
  if (nowMs - new Date(row.lastSeenAt).getTime() >= SESSION_RENEW_AFTER_MS) {
    db.update(sessions)
      .set({
        expiresAt: new Date(nowMs + SESSION_TTL_MS).toISOString(),
        lastSeenAt: nowIso(at),
      })
      .where(eq(sessions.tokenHash, tokenHash))
      .run();
  }

  return { id: row.id, name: row.name, username: row.username, role: row.role };
}

export function destroySession(token: string): void {
  getDb().delete(sessions).where(eq(sessions.tokenHash, hashSessionToken(token))).run();
}

export function destroyAllSessionsForUser(userId: number): number {
  const result = getDb().delete(sessions).where(eq(sessions.userId, userId)).run();
  return Number(result.changes ?? 0);
}

/**
 * "Sign out everywhere else": every session for this user except the one presenting
 * `keepToken`. Used by the forced password change (spec v1.5), where signing the user
 * out of the very browser they are typing in would be a hostile way to end the flow.
 */
export function destroyOtherSessionsForUser(userId: number, keepToken: string): number {
  const result = getDb()
    .delete(sessions)
    .where(and(eq(sessions.userId, userId), ne(sessions.tokenHash, hashSessionToken(keepToken))))
    .run();
  return Number(result.changes ?? 0);
}

export function purgeExpiredSessions(at: Date = new Date()): number {
  const result = getDb().delete(sessions).where(lt(sessions.expiresAt, at.toISOString())).run();
  return Number(result.changes ?? 0);
}

/**
 * Secure cookie logic (spec section 6):
 *  - direct HTTPS (the request's own URL protocol) → secure
 *  - TRUST_PROXY on and X-Forwarded-Proto starts with "https" → secure
 *  - otherwise      → not secure (plain HTTP on a trusted LAN)
 *
 * `protocol` must come from the actual request URL (e.g. `new URL(request.url).protocol`),
 * never from a client-supplied header — a fabricated header would let any client force a
 * Secure cookie over plain HTTP, which browsers then refuse to send back (self-DoS).
 */
export function shouldUseSecureCookie(protocol: string, headers: Headers, env: AppEnv = readEnv()): boolean {
  if (protocol.toLowerCase() === 'https:') return true;
  if (!env.trustProxy) return false;
  const forwarded = headers.get('x-forwarded-proto');
  if (!forwarded) return false;
  return forwarded.split(',')[0].trim().toLowerCase() === 'https';
}

export function sessionCookieOptions(input: { secure: boolean; expiresAt: string }): {
  httpOnly: true;
  sameSite: 'lax';
  secure: boolean;
  path: '/';
  expires: Date;
} {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: input.secure,
    path: '/',
    expires: new Date(input.expiresAt),
  };
}

function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return null;
}

/** Route-handler friendly: no next/headers, so it is unit-testable with a plain Request. */
export function userFromRequest(request: Request): SessionUser | null {
  const token = readCookie(request.headers.get('cookie'), SESSION_COOKIE_NAME);
  if (!token) return null;
  return validateSession(token);
}

export async function getCurrentUser(): Promise<SessionUser | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE_NAME)?.value;
  if (!token) return null;
  return validateSession(token);
}

export async function requireUser(): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  return user;
}

export async function requireAdmin(): Promise<SessionUser> {
  const user = await requireUser();
  if (user.role !== 'admin') redirect('/dashboard');
  return user;
}

export async function setSessionCookie(token: string, expiresAt: string, secure: boolean): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE_NAME, token, sessionCookieOptions({ secure, expiresAt }));
}

export async function clearSessionCookie(): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE_NAME, '', { httpOnly: true, sameSite: 'lax', path: '/', maxAge: 0 });
}

import { and, eq, lt, sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { loginAttempts } from '@/db/schema';
import { nowIso } from '@/lib/clock';
import { readEnv, type AppEnv } from '@/lib/env';

export const USER_IP_WINDOW_MS = 15 * 60 * 1000;
export const USER_IP_MAX_FAILURES = 5;
export const USER_IP_LOCKOUT_MS = 15 * 60 * 1000;

export const USERNAME_WINDOW_MS = 15 * 60 * 1000;
export const USERNAME_MAX_FAILURES = 10;
export const USERNAME_BASE_LOCKOUT_MS = 15 * 60 * 1000;
export const USERNAME_MAX_LOCKOUT_MS = 24 * 60 * 60 * 1000;
export const USERNAME_HISTORY_MS = 24 * 60 * 60 * 1000;

export const ATTEMPT_RETENTION_DAYS = 30;

export type LockoutReason = 'none' | 'user_ip' | 'username';

export interface LockoutStatus {
  locked: boolean;
  reason: LockoutReason;
  retryAfterMs: number;
}

const UNLOCKED: LockoutStatus = { locked: false, reason: 'none', retryAfterMs: 0 };

function normalizeUsername(username: string): string {
  return username.trim().toLowerCase();
}

export function recordLoginAttempt(input: { username: string; ip: string; success: boolean; at?: Date }): void {
  getDb()
    .insert(loginAttempts)
    .values({
      username: normalizeUsername(input.username),
      ip: input.ip,
      success: input.success,
      createdAt: nowIso(input.at),
    })
    .run();
}

function lastSuccessIso(username: string): string | null {
  const row = getDb()
    .select({ createdAt: sql<string>`max(${loginAttempts.createdAt})` })
    .from(loginAttempts)
    .where(and(eq(loginAttempts.username, username), eq(loginAttempts.success, true)))
    .get();
  return row?.createdAt ?? null;
}

/** Failure timestamps (ms, newest first) since the given floor. */
function failuresSince(username: string, ip: string | null, floorIso: string): number[] {
  const conditions = [eq(loginAttempts.username, username), eq(loginAttempts.success, false), sql`${loginAttempts.createdAt} > ${floorIso}`];
  if (ip !== null) conditions.push(eq(loginAttempts.ip, ip));
  const rows = getDb()
    .select({ createdAt: loginAttempts.createdAt })
    .from(loginAttempts)
    .where(and(...conditions))
    .orderBy(sql`${loginAttempts.createdAt} desc`)
    .all();
  return rows.map((r) => new Date(r.createdAt).getTime());
}

function laterIso(a: string | null, b: string): string {
  if (a === null) return b;
  return a > b ? a : b;
}

// CALLER CONTRACT: callers must not call recordLoginAttempt() while checkLockout()
// still reports locked — the login flow rejects the attempt before verifying the
// password or recording anything. Both layers below anchor a candidate lockout on
// whichever qualifying 5-/10-failure window yields the LATEST expiry, which makes
// the lockout monotonic against attempts recorded *after* an active lockout began.
// That guard only covers attempts recorded *before* checkLockout is (correctly)
// consulted; it does not by itself stop a determined caller who ignores the
// reported lock state and records anyway. Layer B's mandated algorithm (brief's
// "Exact Layer B algorithm") anchors only on the single newest failure and has the
// same theoretical hole in isolation — it is protected in practice by the same
// caller contract, not by independent logic in this module.

/** Latest lockout expiry (ms) implied by any qualifying 5-in-a-row window, or null if none. */
function layerACandidateUntil(failuresDesc: number[]): number | null {
  let candidate: number | null = null;
  for (let i = 0; i + USER_IP_MAX_FAILURES - 1 < failuresDesc.length; i += 1) {
    const newest = failuresDesc[i];
    const nthNewest = failuresDesc[i + USER_IP_MAX_FAILURES - 1];
    if (newest - nthNewest <= USER_IP_WINDOW_MS) {
      const until = newest + USER_IP_LOCKOUT_MS;
      if (candidate === null || until > candidate) candidate = until;
    }
  }
  return candidate;
}

export function checkLockout(input: { username: string; ip: string; at?: Date }): LockoutStatus {
  const username = normalizeUsername(input.username);
  const now = (input.at ?? new Date()).getTime();
  const success = lastSuccessIso(username);

  // ---- Layer A: (username, ip), 5 failures / 15 min -> 15 min lockout ----
  // Floor is bounded to now-(WINDOW+LOCKOUT): any failure old enough that even its
  // own 15-min lockout would already have expired can never contribute to a still-
  // active or newly-forming lockout, so it's safe (and keeps the query bounded for
  // never-successful usernames) to exclude it up front.
  const layerAFloor = laterIso(success, new Date(now - (USER_IP_WINDOW_MS + USER_IP_LOCKOUT_MS)).toISOString());
  const layerA = failuresSince(username, input.ip, layerAFloor);
  const layerACandidate = layerACandidateUntil(layerA);
  if (layerACandidate !== null && now < layerACandidate) {
    return { locked: true, reason: 'user_ip', retryAfterMs: layerACandidate - now };
  }

  // ---- Layer B: username only, 10 failures / 15 min burst -> exponential backoff ----
  const layerBFloor = laterIso(success, new Date(now - USERNAME_HISTORY_MS).toISOString());
  const layerB = failuresSince(username, null, layerBFloor);
  if (layerB.length >= USERNAME_MAX_FAILURES) {
    const newest = layerB[0];
    const tenthNewest = layerB[USERNAME_MAX_FAILURES - 1];
    const isBurst = newest - tenthNewest <= USERNAME_WINDOW_MS;
    if (isBurst) {
      const rounds = Math.floor(layerB.length / USERNAME_MAX_FAILURES);
      const lockoutMs = Math.min(USERNAME_BASE_LOCKOUT_MS * 2 ** (rounds - 1), USERNAME_MAX_LOCKOUT_MS);
      const until = newest + lockoutMs;
      if (now < until) {
        return { locked: true, reason: 'username', retryAfterMs: until - now };
      }
    }
  }

  return UNLOCKED;
}

export function clearAttemptsFor(username: string): number {
  const result = getDb().delete(loginAttempts).where(eq(loginAttempts.username, normalizeUsername(username))).run();
  return Number(result.changes ?? 0);
}

/** Socket IP unless TRUST_PROXY is on, in which case the first X-Forwarded-For entry. */
export function clientIpFromHeaders(headers: Headers, socketIp: string | null, env: AppEnv = readEnv()): string {
  if (env.trustProxy) {
    const forwarded = headers.get('x-forwarded-for');
    if (forwarded) {
      const first = forwarded.split(',')[0].trim();
      if (first.length > 0) return first;
    }
  }
  return socketIp && socketIp.length > 0 ? socketIp : 'unknown';
}

export function purgeOldLoginAttempts(at: Date = new Date(), olderThanDays: number = ATTEMPT_RETENTION_DAYS): number {
  const cutoff = new Date(at.getTime() - olderThanDays * 24 * 60 * 60 * 1000).toISOString();
  const result = getDb().delete(loginAttempts).where(lt(loginAttempts.createdAt, cutoff)).run();
  return Number(result.changes ?? 0);
}

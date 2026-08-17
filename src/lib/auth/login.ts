import { randomBytes } from 'node:crypto';
import { getDb } from '@/db/client';
import { seedDatabase } from '@/db/seed';
import { raiseNewSignin } from '@/lib/notify/raise';
import { createSession, type SessionUser } from './session';
import { hashPassword, verifyPassword } from './password';
import { checkLockout, recordLoginAttempt } from './ratelimit';
import { consumeRecoveryCode, getTotpSecretForUser, verifyTotp } from './totp';
import { countUsers, createFirstAdmin, findUserByUsername } from './users';

export const GENERIC_LOGIN_ERROR = 'Incorrect username or password.';

/**
 * Ruling (c): the response for an unknown or deactivated user must cost the same
 * wall-clock time as a real password check, or the timing difference itself is a
 * user-enumeration oracle (real users pay a full argon2 verify; a bare early
 * return doesn't). Computed once per process — a fixed startup cost, not a
 * per-request one — and awaited on the "no such active user" path below in place
 * of the verify that path would otherwise skip.
 */
const DUMMY_PASSWORD_HASH: Promise<string> = hashPassword(randomBytes(32).toString('hex'));

export type LoginResult =
  | { status: 'ok'; token: string; expiresAt: string; user: SessionUser }
  | { status: 'totp_required' }
  | { status: 'invalid' }
  | { status: 'locked'; retryAfterMs: number };

export function isSetupRequired(): boolean {
  return countUsers() === 0;
}

export async function runSetup(input: {
  name: string;
  username: string;
  password: string;
}): Promise<{ userId: number; token: string; expiresAt: string }> {
  const admin = await createFirstAdmin(input);
  seedDatabase(getDb());
  const session = createSession(admin.id);
  return { userId: admin.id, token: session.token, expiresAt: session.expiresAt };
}

export async function attemptLogin(input: {
  username: string;
  password: string;
  totpCode?: string;
  recoveryCode?: string;
  ip: string;
  userAgent?: string | null;
  at?: Date;
}): Promise<LoginResult> {
  const at = input.at ?? new Date();
  const username = input.username.trim().toLowerCase();

  // Ruling (b): checkLockout MUST run before password verification, and a locked
  // response must never call recordLoginAttempt — recording during an active
  // lockout would itself extend/renew the lockout window on every retry.
  const lock = checkLockout({ username, ip: input.ip, at });
  if (lock.locked) {
    return { status: 'locked', retryAfterMs: lock.retryAfterMs };
  }

  const fail = (): LoginResult => {
    recordLoginAttempt({ username, ip: input.ip, success: false, at });
    return { status: 'invalid' };
  };

  const user = findUserByUsername(username);
  if (!user || !user.isActive) {
    // Ruling (c): pay the same argon2 cost a real user's password check would
    // have paid, against a fixed dummy hash, before recording the failure — a
    // fast early-return here would otherwise let an attacker distinguish "no
    // such user" from "wrong password" purely by response time.
    await verifyPassword(await DUMMY_PASSWORD_HASH, input.password);
    return fail();
  }

  const passwordOk = await verifyPassword(user.passwordHash, input.password);
  if (!passwordOk) return fail();

  // Ruling (b), concurrent-overshoot guard: argon2 verification takes real wall
  // time, during which a concurrent request against the same username/ip could
  // have pushed the failure count over the lockout threshold. Re-check before
  // issuing a session so a login that started just under the limit can't slip
  // through once it's re-evaluated a hash-time later.
  const lockAfterVerify = checkLockout({ username, ip: input.ip, at });
  if (lockAfterVerify.locked) {
    return { status: 'locked', retryAfterMs: lockAfterVerify.retryAfterMs };
  }

  if (user.totpEnabled) {
    const hasSecond = Boolean(input.totpCode?.trim()) || Boolean(input.recoveryCode?.trim());
    if (!hasSecond) {
      // Password is right but the second factor is missing: this is not a
      // failed attempt, it is a two-step form. Do not count it.
      return { status: 'totp_required' };
    }
    if (input.totpCode?.trim()) {
      let secret: string | null;
      try {
        secret = getTotpSecretForUser(user.id);
      } catch (error) {
        // Ruling (e): a decrypt failure (e.g. SECRET_KEY was rotated) must present
        // as an ordinary wrong-code failure, never a 500 — but it's logged
        // distinctly here so an operator can tell "bad code" from "can't decrypt".
        console.error('[auth] failed to decrypt TOTP secret during login', { userId: user.id, error });
        return fail();
      }
      if (!secret || !verifyTotp(secret, input.totpCode, at)) return fail();
    } else if (!consumeRecoveryCode(user.id, input.recoveryCode ?? '', at)) {
      return fail();
    }
  }

  recordLoginAttempt({ username, ip: input.ip, success: true, at });
  const session = createSession(user.id, { userAgent: input.userAgent ?? null, ip: input.ip, at });

  // MUST-14.4: fire-and-forget. The enqueue is a synchronous SQLite insert and the pump
  // kick is not awaited. A notification failure must NEVER turn a successful login into an
  // error, so raiseNewSignin is itself internally guarded (MUST-6.19) and wrapped again
  // here. MUST-14.5: this lives in attemptLogin, not in the login server action, so any
  // future authentication path inherits it, and the timing-equalisation reasoning of
  // Ruling (c) stays confined to the failure paths it already governs.
  try {
    raiseNewSignin({
      userId: user.id,
      at,
      ip: input.ip,
      userAgent: input.userAgent ?? null,
      sessionCreatedAt: session.createdAt,
    });
  } catch (error) {
    console.error('[notify] sign-in raise failed', error);
  }

  return {
    status: 'ok',
    token: session.token,
    expiresAt: session.expiresAt,
    user: { id: user.id, name: user.name, username: user.username, role: user.role },
  };
}

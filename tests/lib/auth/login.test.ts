import { describe, it, expect, afterEach, vi } from 'vitest';
import { createTestDb, type TestDb } from '../../helpers/db';
import { attemptLogin, isSetupRequired, runSetup, GENERIC_LOGIN_ERROR } from '@/lib/auth/login';
import { createUser, findUserByUsername, setUserActive, countUsers } from '@/lib/auth/users';
import { validateSession } from '@/lib/auth/session';
import * as ratelimit from '@/lib/auth/ratelimit';
import { currentTotpToken, enableTotpForUser, generateRecoveryCodes, generateTotpSecret, storeRecoveryCodes, countUnusedRecoveryCodes } from '@/lib/auth/totp';
import { saveEmailTarget, saveSmtp } from '@/lib/notify/config';
import * as raiseModule from '@/lib/notify/raise';
import { resetNotifySenderForTests, setNotifySenderForTests } from '@/lib/notify/send';

let current: TestDb | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
});

const PASSWORD = 'correct horse battery';
const IP = '10.0.0.5';

async function seedAlice() {
  return createUser({ name: 'Alice', username: 'alice', password: PASSWORD, role: 'admin' });
}

/** This file's existing helper for "create a user with a password", wrapped to hand back
 * just the id — the shape MUST-14.4's suite below wants. */
async function createLoginUser(input: { username: string; password: string }): Promise<number> {
  const user = await createUser({ name: 'Sam', username: input.username, password: input.password, role: 'member' });
  return user.id;
}

describe('setup wizard', () => {
  it('reports setup required only while the users table is empty', async () => {
    current = createTestDb();
    expect(isSetupRequired()).toBe(true);
    await seedAlice();
    expect(isSetupRequired()).toBe(false);
  });

  it('creates the first user as admin, seeds data and returns a live session', async () => {
    current = createTestDb();
    const result = await runSetup({ name: 'Alice', username: 'alice', password: PASSWORD });
    expect(countUsers()).toBe(1);
    expect(findUserByUsername('alice')?.role).toBe('admin');
    expect(validateSession(result.token)).toMatchObject({ id: result.userId, role: 'admin' });
    const categories = current.sqlite.prepare('select count(*) as c from categories').get() as { c: number };
    const profiles = current.sqlite.prepare('select count(*) as c from import_profiles').get() as { c: number };
    expect(categories.c).toBe(37);
    expect(profiles.c).toBe(4);
  });

  it('refuses to run twice', async () => {
    current = createTestDb();
    await runSetup({ name: 'Alice', username: 'alice', password: PASSWORD });
    await expect(runSetup({ name: 'Mallory', username: 'mallory', password: PASSWORD })).rejects.toThrowError(/already/i);
  });

  it('is safe against two simultaneous first-run setups (TOCTOU fix: hash outside, check-and-insert atomic)', async () => {
    current = createTestDb();
    // Both calls race: each hashes its own password (a real await/yield point)
    // before ever touching the count-check-and-insert transaction. If the check
    // and the insert were split around that yield point (the bug being fixed),
    // both could observe an empty table and both would become admin.
    const results = await Promise.allSettled([
      runSetup({ name: 'Alice', username: 'alice', password: PASSWORD }),
      runSetup({ name: 'Mallory', username: 'mallory', password: PASSWORD }),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason.message).toMatch(/already/i);
    expect(countUsers()).toBe(1);
  });
});

describe('attemptLogin — password only', () => {
  it('succeeds and returns a session token', async () => {
    current = createTestDb();
    const alice = await seedAlice();
    const result = await attemptLogin({ username: 'alice', password: PASSWORD, ip: IP, userAgent: 'vitest' });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('unreachable');
    expect(result.user).toMatchObject({ id: alice.id, username: 'alice', role: 'admin' });
    expect(validateSession(result.token)).not.toBeNull();
  });

  it('matches the username case-insensitively', async () => {
    current = createTestDb();
    await seedAlice();
    expect((await attemptLogin({ username: '  ALICE ', password: PASSWORD, ip: IP })).status).toBe('ok');
  });

  it('returns the same "invalid" status for a wrong password and an unknown user', async () => {
    current = createTestDb();
    await seedAlice();
    expect((await attemptLogin({ username: 'alice', password: 'wrong password!!', ip: IP })).status).toBe('invalid');
    expect((await attemptLogin({ username: 'nobody', password: PASSWORD, ip: IP })).status).toBe('invalid');
    expect(GENERIC_LOGIN_ERROR).toBe('Incorrect username or password.');
  });

  it('refuses a deactivated user without revealing why', async () => {
    current = createTestDb();
    const alice = await seedAlice();
    await createUser({ name: 'Bob', username: 'bob', password: PASSWORD, role: 'admin' });
    setUserActive(alice.id, false);
    expect((await attemptLogin({ username: 'alice', password: PASSWORD, ip: IP })).status).toBe('invalid');
  });

  it('records every attempt in login_attempts', async () => {
    current = createTestDb();
    await seedAlice();
    await attemptLogin({ username: 'alice', password: 'wrong password!!', ip: IP });
    await attemptLogin({ username: 'alice', password: PASSWORD, ip: IP });
    const rows = current.sqlite.prepare('select username, ip, success from login_attempts order by id').all() as {
      username: string;
      ip: string;
      success: number;
    }[];
    expect(rows).toEqual([
      { username: 'alice', ip: IP, success: 0 },
      { username: 'alice', ip: IP, success: 1 },
    ]);
  });
});

describe('attemptLogin — lockout', () => {
  it('reports locked after 5 wrong passwords from one IP and refuses even the right password', async () => {
    current = createTestDb();
    await seedAlice();
    const t0 = new Date('2026-08-15T12:00:00.000Z');
    for (let i = 0; i < 5; i += 1) {
      await attemptLogin({ username: 'alice', password: 'wrong password!!', ip: IP, at: new Date(t0.getTime() + i * 1000) });
    }
    const result = await attemptLogin({ username: 'alice', password: PASSWORD, ip: IP, at: new Date(t0.getTime() + 6000) });
    expect(result.status).toBe('locked');
    if (result.status !== 'locked') throw new Error('unreachable');
    expect(result.retryAfterMs).toBeGreaterThan(0);
  });

  it('does not consume a lockout slot when the credentials are correct', async () => {
    current = createTestDb();
    await seedAlice();
    for (let i = 0; i < 10; i += 1) {
      expect((await attemptLogin({ username: 'alice', password: PASSWORD, ip: IP })).status).toBe('ok');
    }
  });

  it('re-checks lockout after password verification and denies the session if it flipped locked in the meantime (concurrent-overshoot guard)', async () => {
    current = createTestDb();
    await seedAlice();
    const spy = vi.spyOn(ratelimit, 'checkLockout');
    // Simulate a concurrent request recording enough failures to cross the
    // threshold during this request's own argon2 verify: the pre-verify check
    // reports unlocked, but by the time the password has been verified, a
    // second checkLockout call would report locked.
    spy.mockReturnValueOnce({ locked: false, reason: 'none', retryAfterMs: 0 });
    spy.mockReturnValueOnce({ locked: true, reason: 'user_ip', retryAfterMs: 12345 });
    const result = await attemptLogin({ username: 'alice', password: PASSWORD, ip: IP });
    expect(result.status).toBe('locked');
    if (result.status !== 'locked') throw new Error('unreachable');
    expect(result.retryAfterMs).toBe(12345);
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });
});

describe('attemptLogin — TOTP', () => {
  async function seedAliceWithTotp() {
    const alice = await seedAlice();
    const secret = generateTotpSecret();
    enableTotpForUser(alice.id, secret);
    return { alice, secret };
  }

  it('asks for a code when the password is right and MFA is on', async () => {
    current = createTestDb();
    await seedAliceWithTotp();
    expect((await attemptLogin({ username: 'alice', password: PASSWORD, ip: IP })).status).toBe('totp_required');
  });

  it('accepts a valid code', async () => {
    current = createTestDb();
    const { secret } = await seedAliceWithTotp();
    const at = new Date('2026-08-15T12:00:00.000Z');
    const result = await attemptLogin({
      username: 'alice',
      password: PASSWORD,
      totpCode: currentTotpToken(secret, at),
      ip: IP,
      at,
    });
    expect(result.status).toBe('ok');
  });

  it('rejects a wrong code as invalid and counts it as a failure', async () => {
    current = createTestDb();
    await seedAliceWithTotp();
    const result = await attemptLogin({ username: 'alice', password: PASSWORD, totpCode: '000000', ip: IP });
    expect(result.status).toBe('invalid');
    const failures = current.sqlite.prepare('select count(*) as c from login_attempts where success = 0').get() as { c: number };
    expect(failures.c).toBe(1);
  });

  it('accepts a single-use recovery code and burns it', async () => {
    current = createTestDb();
    const { alice } = await seedAliceWithTotp();
    const codes = generateRecoveryCodes();
    storeRecoveryCodes(alice.id, codes);
    expect((await attemptLogin({ username: 'alice', password: PASSWORD, recoveryCode: codes[0], ip: IP })).status).toBe('ok');
    expect(countUnusedRecoveryCodes(alice.id)).toBe(7);
    expect((await attemptLogin({ username: 'alice', password: PASSWORD, recoveryCode: codes[0], ip: IP })).status).toBe('invalid');
  });

  it('never lets a TOTP code in without the right password', async () => {
    current = createTestDb();
    const { secret } = await seedAliceWithTotp();
    const at = new Date('2026-08-15T12:00:00.000Z');
    const result = await attemptLogin({
      username: 'alice',
      password: 'wrong password!!',
      totpCode: currentTotpToken(secret, at),
      ip: IP,
      at,
    });
    expect(result.status).toBe('invalid');
  });

  it('treats an undecryptable stored TOTP secret (e.g. a rotated SECRET_KEY) as a clean failure, never a throw (ruling e)', async () => {
    current = createTestDb();
    const { alice } = await seedAliceWithTotp();
    // Corrupt the stored ciphertext directly so decryptTotpSecret throws.
    current.sqlite.prepare('update users set totp_secret_encrypted = ? where id = ?').run('not-a-valid-ciphertext', alice.id);
    await expect(attemptLogin({ username: 'alice', password: PASSWORD, totpCode: '123456', ip: IP })).resolves.toMatchObject({
      status: 'invalid',
    });
  });
});

describe('MUST-14.4: a successful login raises new_signin', () => {
  it('enqueues one row per enabled channel', async () => {
    current = createTestDb();
    const userId = await createLoginUser({ username: 'sam', password: 'correct horse battery staple' });
    saveSmtp({
      preset: 'brevo',
      host: 'h',
      port: 587,
      security: 'starttls',
      username: 'u',
      password: 'p',
      fromEmail: 'f@e.com',
      fromName: 'Budget Tracker',
      enabled: true,
    });
    saveEmailTarget({ userId, destination: 'sam@example.com', enabled: true });
    setNotifySenderForTests(async () => {});

    const result = await attemptLogin({ username: 'sam', password: 'correct horse battery staple', ip: '1.2.3.4' });
    expect(result.status).toBe('ok');
    const rows = current.sqlite.prepare(`select event_id from notification_outbox`).all() as { event_id: string }[];
    expect(rows.map((r) => r.event_id)).toEqual(['new_signin']);
    resetNotifySenderForTests();
  });

  it('a FAILED login enqueues nothing', async () => {
    current = createTestDb();
    const userId = await createLoginUser({ username: 'sam', password: 'correct horse battery staple' });
    saveEmailTarget({ userId, destination: 'sam@example.com', enabled: true });
    await attemptLogin({ username: 'sam', password: 'wrong', ip: '1.2.3.4' });
    const { n } = current.sqlite.prepare('select count(*) as n from notification_outbox').get() as { n: number };
    expect(n).toBe(0);
  });

  it('a login with no configured channel writes no row at all', async () => {
    current = createTestDb();
    await createLoginUser({ username: 'sam', password: 'correct horse battery staple' });
    const result = await attemptLogin({ username: 'sam', password: 'correct horse battery staple', ip: '1.2.3.4' });
    expect(result.status).toBe('ok');
    const { n } = current.sqlite.prepare('select count(*) as n from notification_outbox').get() as { n: number };
    expect(n).toBe(0);
  });
});

describe('MUST-14.4: a throwing raiseNewSignin does not fail the login', () => {
  it('a throwing raiseNewSignin still returns { status: "ok" }', async () => {
    current = createTestDb();
    await createLoginUser({ username: 'sam', password: 'correct horse battery staple' });
    const raise = vi.spyOn(raiseModule, 'raiseNewSignin').mockImplementation(() => {
      throw new Error('raise exploded');
    });
    try {
      const result = await attemptLogin({ username: 'sam', password: 'correct horse battery staple', ip: '1.2.3.4' });
      // Vitest's ESM transform makes named imports live bindings against the module
      // namespace object, so vi.spyOn here DOES intercept attemptLogin's bare
      // `raiseNewSignin(...)` call — confirmed by the mock's stack trace running through
      // attemptLogin. MUST-14.4/14.5: attemptLogin's own try/catch around the call is what
      // makes this "ok" regardless of whether the throw came from the spy or from a real
      // failure inside raise.ts.
      expect(result.status).toBe('ok');
    } finally {
      raise.mockRestore();
    }
  });
});

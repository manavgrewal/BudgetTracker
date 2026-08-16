import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createTestDb, type TestDb } from '../helpers/db';
import { createUser, findUserByUsername, setUserActive } from '@/lib/auth/users';
import { verifyPassword, hashPassword, MIN_PASSWORD_LENGTH as APP_MIN_PASSWORD_LENGTH } from '@/lib/auth/password';
import { createSession, validateSession } from '@/lib/auth/session';
import { checkLockout, recordLoginAttempt } from '@/lib/auth/ratelimit';
import { countUnusedRecoveryCodes, enableTotpForUser, generateRecoveryCodes, generateTotpSecret, storeRecoveryCodes } from '@/lib/auth/totp';
import { ARGON2_OPTIONS, MIN_PASSWORD_LENGTH, resetPassword, resolveDatabasePath } from '../../scripts/reset-admin-password';

/** Parses the "m=...,t=...,p=..." parameter segment out of a PHC-format argon2id hash. */
function argon2ParamSegment(hash: string): string {
  const match = hash.match(/\$argon2id\$v=\d+\$(m=\d+,t=\d+,p=\d+)\$/);
  if (!match) throw new Error(`unexpected argon2 hash format: ${hash}`);
  return match[1];
}

let current: TestDb | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
});

const OLD_PASSWORD = 'the original password';
const NEW_PASSWORD = 'a brand new password';

async function setup() {
  current = createTestDb();
  const alice = await createUser({ name: 'Alice', username: 'alice', password: OLD_PASSWORD, role: 'admin' });
  return { alice, dbPath: current.path };
}

/** Puts a user in the exact state the SECRET_KEY-loss FAQ describes: TOTP on, codes issued. */
function enrollTotp(userId: number): void {
  enableTotpForUser(userId, generateTotpSecret());
  storeRecoveryCodes(userId, generateRecoveryCodes());
}

function totpRow(userId: number): { totp_enabled: number; totp_secret_encrypted: string | null } {
  return current!.sqlite
    .prepare('select totp_enabled, totp_secret_encrypted from users where id = ?')
    .get(userId) as { totp_enabled: number; totp_secret_encrypted: string | null };
}

describe('resolveDatabasePath', () => {
  it('mirrors the app: BUDGET_DB_PATH, else DATA_DIR/budget.db, else /data/budget.db', () => {
    expect(resolveDatabasePath({ BUDGET_DB_PATH: '/tmp/x.db' } as unknown as NodeJS.ProcessEnv)).toBe('/tmp/x.db');
    expect(resolveDatabasePath({ DATA_DIR: '/srv/data' } as unknown as NodeJS.ProcessEnv)).toBe(path.join('/srv/data', 'budget.db'));
    expect(resolveDatabasePath({} as NodeJS.ProcessEnv)).toBe(path.join('/data', 'budget.db'));
  });
});

describe('argon2 parameters stay in step with the app', () => {
  // Drift-pin, not a copied-literal check: MIN_PASSWORD_LENGTH is compared
  // against the real value imported from src/lib/auth/password.ts, so if that
  // file's constant ever changes, this fails instead of silently agreeing with
  // whatever number was pasted into the rescue script.
  it('MIN_PASSWORD_LENGTH matches the app (imported from src/lib/auth/password.ts, not copied)', () => {
    expect(MIN_PASSWORD_LENGTH).toBe(APP_MIN_PASSWORD_LENGTH);
    expect(MIN_PASSWORD_LENGTH).toBe(10);
  });

  // Drift-pin for the argon2 cost parameters: rather than comparing
  // ARGON2_OPTIONS' fields against literals copied into this test (which pins
  // nothing — both sides could drift together undetected), hash the same
  // plaintext with the app's real hashPassword() and with the rescue script's
  // own ARGON2_OPTIONS, then compare the parsed "m=...,t=...,p=..." segment of
  // both PHC-format hashes. This also pins parallelism, which the previous
  // version of this test never actually exercised.
  it('produces the same argon2 cost parameters (m/t/p) as the app\'s own hashPassword()', async () => {
    const appHash = await hashPassword('drift-pin-probe-password-1');
    const { dbPath } = await setup();
    await resetPassword({ dbPath, username: 'alice', newPassword: NEW_PASSWORD });
    const rescueHash = findUserByUsername('alice')!.passwordHash;
    expect(argon2ParamSegment(rescueHash)).toBe(argon2ParamSegment(appHash));
  });

  it('produces a hash the app itself accepts', async () => {
    const { alice, dbPath } = await setup();
    await resetPassword({ dbPath, username: 'alice', newPassword: NEW_PASSWORD });
    const stored = findUserByUsername('alice')!;
    expect(stored.passwordHash).toContain('$argon2id$');
    expect(stored.passwordHash).toContain('m=65536');
    expect(stored.passwordHash).toContain('t=3');
    expect(await verifyPassword(stored.passwordHash, NEW_PASSWORD)).toBe(true);
    expect(await verifyPassword(stored.passwordHash, OLD_PASSWORD)).toBe(false);
    expect(alice.id).toBeGreaterThan(0);
  });
});

describe('resetPassword', () => {
  it('reports what it did', async () => {
    const { alice, dbPath } = await setup();
    createSession(alice.id);
    createSession(alice.id);
    recordLoginAttempt({ username: 'alice', ip: '10.0.0.5', success: false });

    const result = await resetPassword({ dbPath, username: 'alice', newPassword: NEW_PASSWORD });
    expect(result).toEqual({
      userId: alice.id,
      username: 'alice',
      sessionsRevoked: 2,
      attemptsCleared: 1,
      mfaCleared: false,
      recoveryCodesDeleted: 0,
      mfaStillRequired: false,
    });
  });

  it('signs every existing session out', async () => {
    const { alice, dbPath } = await setup();
    const session = createSession(alice.id);
    expect(validateSession(session.token)).not.toBeNull();
    await resetPassword({ dbPath, username: 'alice', newPassword: NEW_PASSWORD });
    expect(validateSession(session.token)).toBeNull();
  });

  it('clears a lockout so the user can sign in immediately', async () => {
    const { dbPath } = await setup();
    const at = new Date('2026-08-15T12:00:00.000Z');
    for (let i = 0; i < 6; i += 1) {
      recordLoginAttempt({ username: 'alice', ip: '10.0.0.5', success: false, at: new Date(at.getTime() + i * 1000) });
    }
    expect(checkLockout({ username: 'alice', ip: '10.0.0.5', at: new Date(at.getTime() + 7000) }).locked).toBe(true);

    await resetPassword({ dbPath, username: 'alice', newPassword: NEW_PASSWORD });
    expect(checkLockout({ username: 'alice', ip: '10.0.0.5', at: new Date(at.getTime() + 7000) }).locked).toBe(false);
  });

  it('reactivates a deactivated account', async () => {
    const { alice, dbPath } = await setup();
    await createUser({ name: 'Bob', username: 'bob', password: OLD_PASSWORD, role: 'admin' });
    setUserActive(alice.id, false);
    expect(findUserByUsername('alice')!.isActive).toBe(false);
    await resetPassword({ dbPath, username: 'alice', newPassword: NEW_PASSWORD });
    expect(findUserByUsername('alice')!.isActive).toBe(true);
  });

  it('matches the username case-insensitively', async () => {
    const { dbPath } = await setup();
    await expect(resetPassword({ dbPath, username: '  ALICE ', newPassword: NEW_PASSWORD })).resolves.toMatchObject({ username: 'alice' });
  });

  it('refuses an unknown user and lists the ones that exist', async () => {
    const { dbPath } = await setup();
    await expect(resetPassword({ dbPath, username: 'nobody', newPassword: NEW_PASSWORD })).rejects.toThrowError(/No user named "nobody"/);
    await expect(resetPassword({ dbPath, username: 'nobody', newPassword: NEW_PASSWORD })).rejects.toThrowError(/alice/);
  });

  it('refuses a password shorter than the policy minimum', async () => {
    const { dbPath } = await setup();
    await expect(resetPassword({ dbPath, username: 'alice', newPassword: 'short' })).rejects.toThrowError(/at least 10 characters/);
    expect(await verifyPassword(findUserByUsername('alice')!.passwordHash, OLD_PASSWORD)).toBe(true);
  });
});

describe('--clear-mfa — the documented SECRET_KEY-loss recovery path (C2)', () => {
  it('without the flag, TOTP is left completely alone and the result says so', async () => {
    const { alice, dbPath } = await setup();
    enrollTotp(alice.id);

    const result = await resetPassword({ dbPath, username: 'alice', newPassword: NEW_PASSWORD });

    expect(result.mfaCleared).toBe(false);
    expect(result.mfaStillRequired).toBe(true);
    expect(result.recoveryCodesDeleted).toBe(0);
    // The account is STILL unreachable if SECRET_KEY was lost — this is the
    // exact false claim the old INSTALL.md made ("bypasses two-factor").
    const row = totpRow(alice.id);
    expect(row.totp_enabled).toBe(1);
    expect(row.totp_secret_encrypted).not.toBeNull();
    expect(countUnusedRecoveryCodes(alice.id)).toBe(8);
  });

  it('with the flag, TOTP is off, the undecryptable secret is gone, and the recovery codes are deleted', async () => {
    const { alice, dbPath } = await setup();
    enrollTotp(alice.id);

    const result = await resetPassword({ dbPath, username: 'alice', newPassword: NEW_PASSWORD, clearMfa: true });

    expect(result.mfaCleared).toBe(true);
    expect(result.mfaStillRequired).toBe(false);
    expect(result.recoveryCodesDeleted).toBe(8);
    const row = totpRow(alice.id);
    expect(row.totp_enabled).toBe(0);
    expect(row.totp_secret_encrypted).toBeNull();
    expect(countUnusedRecoveryCodes(alice.id)).toBe(0);
    // And the password reset still happened.
    expect(await verifyPassword(findUserByUsername('alice')!.passwordHash, NEW_PASSWORD)).toBe(true);
  });

  it('touches only the named user — everyone else keeps their enrollment', async () => {
    const { alice, dbPath } = await setup();
    const bob = await createUser({ name: 'Bob', username: 'bob', password: OLD_PASSWORD, role: 'member' });
    enrollTotp(alice.id);
    enrollTotp(bob.id);

    await resetPassword({ dbPath, username: 'alice', newPassword: NEW_PASSWORD, clearMfa: true });

    expect(totpRow(bob.id).totp_enabled).toBe(1);
    expect(totpRow(bob.id).totp_secret_encrypted).not.toBeNull();
    expect(countUnusedRecoveryCodes(bob.id)).toBe(8);
  });

  it('is a no-op-but-honest when the account never had two-factor on', async () => {
    const { dbPath } = await setup();
    const result = await resetPassword({ dbPath, username: 'alice', newPassword: NEW_PASSWORD, clearMfa: true });
    expect(result.mfaCleared).toBe(false);
    expect(result.mfaStillRequired).toBe(false);
    expect(result.recoveryCodesDeleted).toBe(0);
  });
});

describe('the CLI as it runs inside the container', () => {
  const [major, minor] = process.versions.node.split('.').map(Number);
  const stripTypesSupported = major > 22 || (major === 22 && minor >= 6);
  const scriptPath = path.join(process.cwd(), 'scripts', 'reset-admin-password.ts');

  const runCli = (args: string[], dbPath: string) =>
    spawnSync(process.execPath, ['--experimental-strip-types', scriptPath, ...args], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, BUDGET_DB_PATH: dbPath },
    });

  it.runIf(stripTypesSupported)('resets a password end to end and prints what it did', async () => {
    const { dbPath } = await setup();
    const result = runCli(['alice', NEW_PASSWORD], dbPath);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Password reset for "alice"');
    expect(await verifyPassword(findUserByUsername('alice')!.passwordHash, NEW_PASSWORD)).toBe(true);
  });

  it.runIf(stripTypesSupported)('exits non-zero and explains itself when the user does not exist', async () => {
    const { dbPath } = await setup();
    const result = runCli(['nobody', NEW_PASSWORD], dbPath);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('No user named "nobody"');
  });

  it.runIf(stripTypesSupported)('prints usage and exits 2 with no arguments', async () => {
    const { dbPath } = await setup();
    const result = runCli([], dbPath);
    expect(result.status).toBe(2);
    expect(result.stdout).toContain('Usage:');
    expect(result.stdout).toContain('docker compose exec');
  });

  it.runIf(stripTypesSupported)('prints usage and exits 0 for --help', async () => {
    const { dbPath } = await setup();
    const result = runCli(['--help'], dbPath);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Usage:');
    expect(result.stdout).toContain('--clear-mfa');
  });

  it.runIf(stripTypesSupported)('warns that two-factor is still on when --clear-mfa was not passed (C2)', async () => {
    const { alice, dbPath } = await setup();
    enrollTotp(alice.id);

    const result = runCli(['alice', NEW_PASSWORD], dbPath);

    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/still ON/i);
    expect(result.stdout).toContain('--clear-mfa');
    expect(result.stdout).not.toMatch(/sign in with the new password immediately/i);
    expect(totpRow(alice.id).totp_enabled).toBe(1);
  });

  it.runIf(stripTypesSupported)('states exactly what --clear-mfa cleared', async () => {
    const { alice, dbPath } = await setup();
    enrollTotp(alice.id);

    const result = runCli(['alice', NEW_PASSWORD, '--clear-mfa'], dbPath);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Password reset for "alice"');
    expect(result.stdout).toMatch(/Two-factor authentication cleared/i);
    expect(result.stdout).toContain('8 recovery code(s) were deleted');
    expect(result.stdout).toMatch(/transactions, budgets, goals and every other user are unchanged/i);
    expect(totpRow(alice.id).totp_enabled).toBe(0);
    expect(totpRow(alice.id).totp_secret_encrypted).toBeNull();
  });

  it.runIf(stripTypesSupported)('accepts --clear-mfa before the positional arguments too', async () => {
    const { alice, dbPath } = await setup();
    enrollTotp(alice.id);
    const result = runCli(['--clear-mfa', 'alice', NEW_PASSWORD], dbPath);
    expect(result.status).toBe(0);
    expect(totpRow(alice.id).totp_enabled).toBe(0);
  });
});

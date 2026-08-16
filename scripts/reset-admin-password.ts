#!/usr/bin/env node
/**
 * Rescue tool: reset a user's password, clear their lockout, and (with
 * --clear-mfa) clear their two-factor enrollment.
 *
 * Run it inside the container:
 *   docker compose exec budget-tracker node --experimental-strip-types \
 *     scripts/reset-admin-password.ts <username> '<new password>' [--clear-mfa]
 *
 * This script is DELIBERATELY self-contained. The runtime image ships Next's
 * standalone output, which does not include the project's src/ tree, so the
 * "@/..." import alias cannot resolve in the container. It therefore talks to
 * better-sqlite3 and argon2 directly — both are already present in the image.
 *
 * tests/scripts/reset-admin-password.test.ts pins ARGON2_OPTIONS against
 * src/lib/auth/password.ts so the two can never drift apart unnoticed.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import argon2 from 'argon2';

/** Must stay identical to ARGON2_OPTIONS in src/lib/auth/password.ts. */
export const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 1,
};

export const MIN_PASSWORD_LENGTH = 10;

export function resolveDatabasePath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.BUDGET_DB_PATH;
  if (override && override.length > 0) return override;
  return path.join(env.DATA_DIR && env.DATA_DIR.length > 0 ? env.DATA_DIR : '/data', 'budget.db');
}

export interface ResetResult {
  userId: number;
  username: string;
  sessionsRevoked: number;
  attemptsCleared: number;
  /** true only when --clear-mfa was asked for AND the user actually had TOTP on. */
  mfaCleared: boolean;
  /** Rows deleted from totp_recovery_codes for this user (0 when --clear-mfa was not given). */
  recoveryCodesDeleted: number;
  /** true when the account still has TOTP enrollment after this run — the caller must say so. */
  mfaStillRequired: boolean;
}

export async function resetPassword(input: {
  dbPath: string;
  username: string;
  newPassword: string;
  /**
   * Clears TOTP enrollment as well. This is the SECRET_KEY-loss escape hatch:
   * a secret encrypted under a key nobody has anymore can never produce a
   * valid code again, so a password reset alone leaves the account
   * permanently unreachable.
   */
  clearMfa?: boolean;
}): Promise<ResetResult> {
  if (input.newPassword.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`The new password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }

  const username = input.username.trim().toLowerCase();

  // better-sqlite3 CREATES a database when the file is missing. For a rescue tool that
  // is the worst possible default: a typo in DATA_DIR (or running outside the container)
  // silently produced an empty database, and the script then reported "No user named
  // alice. Known users: (none)" — which reads as "the account is gone" rather than
  // "you are looking at the wrong file". It also littered a stray budget.db on disk.
  let db: Database.Database;
  try {
    db = new Database(input.dbPath, { fileMustExist: true });
  } catch {
    throw new Error(
      `No database at "${input.dbPath}". Set BUDGET_DB_PATH or DATA_DIR to the right location, ` +
        'or run this inside the container (docker compose exec budget-tracker ...) where /data is mounted.',
    );
  }

  try {
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');

    const user = db.prepare('select id, username, totp_enabled from users where username = ?').get(username) as
      | { id: number; username: string; totp_enabled: number }
      | undefined;
    if (!user) {
      const known = (db.prepare('select username from users order by username').all() as { username: string }[])
        .map((row) => row.username)
        .join(', ');
      throw new Error(`No user named "${username}". Known users: ${known || '(none)'}`);
    }

    const hash = await argon2.hash(input.newPassword, ARGON2_OPTIONS);
    db.prepare('update users set password_hash = ?, is_active = 1 where id = ?').run(hash, user.id);

    const hadMfa = Number(user.totp_enabled) === 1;
    let recoveryCodesDeleted = 0;
    if (input.clearMfa === true) {
      // Mirrors clearTotpEnrollment() in src/lib/auth/totp.ts: disable the
      // flag, drop the (now undecryptable) secret, and delete the recovery
      // codes, which are SHA-256 hashes tied to the enrollment being removed.
      db.prepare('update users set totp_enabled = 0, totp_secret_encrypted = null where id = ?').run(user.id);
      recoveryCodesDeleted = Number(
        db.prepare('delete from totp_recovery_codes where user_id = ?').run(user.id).changes ?? 0,
      );
    }

    const sessions = db.prepare('delete from sessions where user_id = ?').run(user.id);
    const attempts = db.prepare('delete from login_attempts where username = ?').run(username);

    return {
      userId: user.id,
      username: user.username,
      sessionsRevoked: Number(sessions.changes ?? 0),
      attemptsCleared: Number(attempts.changes ?? 0),
      mfaCleared: input.clearMfa === true && hadMfa,
      recoveryCodesDeleted,
      mfaStillRequired: hadMfa && input.clearMfa !== true,
    };
  } finally {
    db.close();
  }
}

function usage(): void {
  console.log(`Reset a Budget Tracker password and clear that account's lockout.

Usage:
  node --experimental-strip-types scripts/reset-admin-password.ts <username> '<new password>' [--clear-mfa]

Inside Docker:
  docker compose exec budget-tracker node --experimental-strip-types \\
    scripts/reset-admin-password.ts alice 'a brand new password'

The password must be at least ${MIN_PASSWORD_LENGTH} characters. The account is
reactivated if it was deactivated, every one of its sessions is signed out, and
its failed-login history is cleared so the lockout lifts immediately.

  --clear-mfa   Also turn off two-factor authentication for that user: clears
                totp_enabled, deletes the stored (encrypted) TOTP secret, and
                deletes their unused recovery codes. Use this when SECRET_KEY
                was lost or rotated — the stored secret is undecryptable then,
                so no authenticator app can ever produce an accepted code
                again. WITHOUT this flag the sign-in still asks for a
                two-factor code.

Database location: $BUDGET_DB_PATH, else $DATA_DIR/budget.db, else /data/budget.db.`);
}

export async function main(argv: string[]): Promise<number> {
  const raw = argv.slice(2);
  const clearMfa = raw.includes('--clear-mfa');
  const args = raw.filter((arg) => arg !== '--clear-mfa');
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    usage();
    return args.length === 0 ? 2 : 0;
  }
  if (args.length < 2) {
    console.error('error: both a username and a new password are required.\n');
    usage();
    return 2;
  }

  const dbPath = resolveDatabasePath();
  try {
    const result = await resetPassword({ dbPath, username: args[0], newPassword: args[1], clearMfa });
    console.log(
      `Password reset for "${result.username}" (id ${result.userId}). ` +
        `${result.sessionsRevoked} session(s) signed out, ${result.attemptsCleared} failed-login record(s) cleared.`,
    );
    if (clearMfa) {
      console.log(
        result.mfaCleared
          ? `Two-factor authentication cleared: TOTP is off and ${result.recoveryCodesDeleted} recovery code(s) were deleted. ` +
              'They can sign in with the new password alone, and can enroll a fresh authenticator from Settings → Profile.'
          : `Two-factor authentication was already off for this account; nothing to clear (${result.recoveryCodesDeleted} recovery code(s) deleted).`,
      );
      console.log('Nothing else was touched: transactions, budgets, goals and every other user are unchanged.');
    } else if (result.mfaStillRequired) {
      console.log(
        'Two-factor authentication is still ON for this account and was NOT touched — sign-in will ask for an ' +
          'authenticator code (or a recovery code) after the new password. If SECRET_KEY was lost or rotated, that ' +
          'code can never be accepted: re-run this with --clear-mfa.',
      );
    } else {
      console.log('They can sign in with the new password immediately.');
    }
    return 0;
  } catch (error) {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    console.error(`(database: ${dbPath})`);
    return 1;
  }
}

// Only run when invoked directly, so the test can import the functions.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv).then((code) => {
    process.exitCode = code;
  });
}

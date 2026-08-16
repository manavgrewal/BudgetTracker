#!/usr/bin/env node
/**
 * Rescue tool: reset a user's password and clear their lockout.
 *
 * Run it inside the container:
 *   docker compose exec budget-tracker node --experimental-strip-types \
 *     scripts/reset-admin-password.ts <username> '<new password>'
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
}

export async function resetPassword(input: {
  dbPath: string;
  username: string;
  newPassword: string;
}): Promise<ResetResult> {
  if (input.newPassword.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`The new password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }

  const username = input.username.trim().toLowerCase();
  const db = new Database(input.dbPath);
  try {
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');

    const user = db.prepare('select id, username from users where username = ?').get(username) as
      | { id: number; username: string }
      | undefined;
    if (!user) {
      const known = (db.prepare('select username from users order by username').all() as { username: string }[])
        .map((row) => row.username)
        .join(', ');
      throw new Error(`No user named "${username}". Known users: ${known || '(none)'}`);
    }

    const hash = await argon2.hash(input.newPassword, ARGON2_OPTIONS);
    db.prepare('update users set password_hash = ?, is_active = 1 where id = ?').run(hash, user.id);

    const sessions = db.prepare('delete from sessions where user_id = ?').run(user.id);
    const attempts = db.prepare('delete from login_attempts where username = ?').run(username);

    return {
      userId: user.id,
      username: user.username,
      sessionsRevoked: Number(sessions.changes ?? 0),
      attemptsCleared: Number(attempts.changes ?? 0),
    };
  } finally {
    db.close();
  }
}

function usage(): void {
  console.log(`Reset a Budget Tracker password and clear that account's lockout.

Usage:
  node --experimental-strip-types scripts/reset-admin-password.ts <username> '<new password>'

Inside Docker:
  docker compose exec budget-tracker node --experimental-strip-types \\
    scripts/reset-admin-password.ts alice 'a brand new password'

The password must be at least ${MIN_PASSWORD_LENGTH} characters. The account is
reactivated if it was deactivated, every one of its sessions is signed out, and
its failed-login history is cleared so the lockout lifts immediately.

Database location: $BUDGET_DB_PATH, else $DATA_DIR/budget.db, else /data/budget.db.`);
}

export async function main(argv: string[]): Promise<number> {
  const args = argv.slice(2);
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
    const result = await resetPassword({ dbPath, username: args[0], newPassword: args[1] });
    console.log(
      `Password reset for "${result.username}" (id ${result.userId}). ` +
        `${result.sessionsRevoked} session(s) signed out, ${result.attemptsCleared} failed-login record(s) cleared.`,
    );
    console.log('They can sign in with the new password immediately.');
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

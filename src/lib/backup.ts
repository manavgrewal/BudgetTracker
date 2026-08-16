import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getSqlite } from '@/db/client';
import { purgeOldLoginAttempts } from '@/lib/auth/ratelimit';
import { purgeExpiredSessions } from '@/lib/auth/session';
import { todayIso } from '@/lib/dates';
import { readEnv } from '@/lib/env';
import { purgeStagedFiles } from '@/lib/import/staging';
import { SETTING_BACKUP_RETENTION, getIntSetting, setIntSetting } from '@/lib/settings';

export const DEFAULT_BACKUP_RETENTION = 14;

const NIGHTLY_NAME_RE = /^budget-\d{4}-\d{2}-\d{2}\.db$/;
// randomUUID() always emits lowercase hex in the canonical 8-4-4-4-12 shape.
const ON_DEMAND_NAME_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.db$/;

export function backupsDir(): string {
  return path.join(readEnv().dataDir, 'backups');
}

export function tempDir(): string {
  return path.join(readEnv().dataDir, 'tmp');
}

export function nightlyBackupName(at: Date = new Date(), tz?: string): string {
  return `budget-${todayIso(at, tz)}.db`;
}

export interface BackupFile {
  name: string;
  path: string;
  bytes: number;
  modifiedAt: string;
}

/**
 * Controller ruling (b): a VACUUM INTO target must never be built from a
 * settings-injected or otherwise attacker-influenced string. Nightly names come
 * only from todayIso()'s fixed YYYY-MM-DD output and on-demand names only from
 * randomUUID() — neither can contain a path separator or "..". This check is a
 * second, load-bearing line of defence: it refuses any filename that doesn't
 * match its expected shape and confirms the resolved path still lands directly
 * inside the expected directory (no traversal) before any fs call touches it.
 */
function resolveSafeTarget(dir: string, name: string, pattern: RegExp): string {
  if (!pattern.test(name)) throw new Error(`Refusing unsafe backup filename: ${name}`);
  const resolvedDir = path.resolve(dir);
  const target = path.resolve(resolvedDir, name);
  if (path.dirname(target) !== resolvedDir) {
    throw new Error('Refusing to write a backup outside its directory');
  }
  return target;
}

export function listBackups(): BackupFile[] {
  const dir = backupsDir();
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => NIGHTLY_NAME_RE.test(name))
    .map((name) => {
      const file = path.join(dir, name);
      const stats = fs.statSync(file);
      return { name, path: file, bytes: stats.size, modifiedAt: new Date(stats.mtimeMs).toISOString() };
    })
    .sort((a, b) => (a.modifiedAt < b.modifiedAt ? 1 : a.modifiedAt > b.modifiedAt ? -1 : a.name < b.name ? 1 : -1));
}

export function getBackupRetention(): number {
  return Math.max(1, getIntSetting(SETTING_BACKUP_RETENTION, DEFAULT_BACKUP_RETENTION));
}

export function setBackupRetention(count: number): void {
  setIntSetting(SETTING_BACKUP_RETENTION, Math.max(1, Math.floor(count)));
}

function vacuumInto(target: string): void {
  // VACUUM cannot be a bound-parameter statement in every SQLite build, so the
  // path is escaped and inlined. Single quotes are doubled per SQLite rules.
  getSqlite().exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
}

/**
 * Spec section 8: delete the target if present, THEN VACUUM INTO.
 * VACUUM INTO errors on an existing file, so without the delete a container
 * restart after 02:00 would fail that day's backup permanently.
 */
export function runNightlyBackup(at: Date = new Date()): BackupFile {
  const dir = backupsDir();
  fs.mkdirSync(dir, { recursive: true });
  const name = nightlyBackupName(at);
  const target = resolveSafeTarget(dir, name, NIGHTLY_NAME_RE);
  fs.rmSync(target, { force: true });
  vacuumInto(target);
  const stats = fs.statSync(target);
  return { name, path: target, bytes: stats.size, modifiedAt: new Date(stats.mtimeMs).toISOString() };
}

export function pruneBackups(retain: number = getBackupRetention()): string[] {
  const files = listBackups();
  const doomed = files.slice(Math.max(0, retain));
  for (const file of doomed) fs.rmSync(file.path, { force: true });
  return doomed.map((file) => file.name);
}

/** Settings -> "Download backup now". Written to /data/tmp so it cannot collide with the nightly names. */
export function createOnDemandBackup(): { path: string; bytes: number } {
  const dir = tempDir();
  fs.mkdirSync(dir, { recursive: true });
  const name = `${randomUUID()}.db`;
  const target = resolveSafeTarget(dir, name, ON_DEMAND_NAME_RE);
  fs.rmSync(target, { force: true });
  vacuumInto(target);
  return { path: target, bytes: fs.statSync(target).size };
}

export interface SweepResult {
  sessionsPurged: number;
  loginAttemptsPurged: number;
  stagedFilesPurged: number;
}

export function runMaintenanceSweep(at: Date = new Date()): SweepResult {
  return {
    sessionsPurged: purgeExpiredSessions(at),
    loginAttemptsPurged: purgeOldLoginAttempts(at),
    stagedFilesPurged: purgeStagedFiles(undefined, at),
  };
}

export interface NightlyJobResult {
  backup: BackupFile;
  pruned: string[];
  sweep: SweepResult;
}

export function runNightlyJob(at: Date = new Date()): NightlyJobResult {
  const backup = runNightlyBackup(at);
  const pruned = pruneBackups();
  const sweep = runMaintenanceSweep(at);
  console.log(
    `[backup] wrote ${backup.name} (${backup.bytes} bytes), pruned ${pruned.length}, purged ${sweep.sessionsPurged} sessions / ${sweep.loginAttemptsPurged} login attempts / ${sweep.stagedFilesPurged} staged uploads`,
  );
  return { backup, pruned, sweep };
}

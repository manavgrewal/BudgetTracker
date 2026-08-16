import fs from 'node:fs';
import path from 'node:path';
import { purgeOldLoginAttempts } from '@/lib/auth/ratelimit';
import { purgeExpiredSessions } from '@/lib/auth/session';
import { purgeStagedFiles } from '@/lib/import/staging';
import { SETTING_BACKUP_RETENTION, getIntSetting, setIntSetting } from '@/lib/settings';
import {
  ARCHIVE_NAME_RE,
  LEGACY_NAME_RE,
  backupsDir,
  buildArchive,
  createOnDemandArchive,
  nightlyArchiveName,
  resolveSafeTarget,
  tempDir,
} from '@/lib/backup/archive';
import { listStoredFilenames } from '@/lib/warranty/items';
import { purgeOrphanReceipts } from '@/lib/warranty/receipts';

export const DEFAULT_BACKUP_RETENTION = 14;

// Re-exported so every existing importer of '@/lib/backup' keeps working unchanged.
export { backupsDir, tempDir };

export function nightlyBackupName(at: Date = new Date(), tz?: string): string {
  return nightlyArchiveName(at, tz);
}

export interface BackupFile {
  name: string;
  path: string;
  bytes: number;
  modifiedAt: string;
}

export function listBackups(): BackupFile[] {
  const dir = backupsDir();
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    // MUST-12.3: retention counting spans BOTH shapes, so a v1.0.0 install's existing
    // .db backups stay visible and prunable after the upgrade. Both patterns are anchored
    // with `$`, so a `budget-....tar.gz.partial` left by an interrupted buildArchive()
    // (src/lib/backup/archive.ts) never matches either one and is never listed, counted
    // toward retention, or evicted-in-place-of.
    .filter((name) => ARCHIVE_NAME_RE.test(name) || LEGACY_NAME_RE.test(name))
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

/**
 * Spec section 8: delete the target if present, THEN build the archive.
 * A VACUUM INTO target errors on an existing file, so without the delete a container
 * restart after 02:00 would fail that day's backup permanently.
 */
export function runNightlyBackup(at: Date = new Date()): BackupFile {
  const dir = backupsDir();
  fs.mkdirSync(dir, { recursive: true });
  const name = nightlyArchiveName(at);
  const target = resolveSafeTarget(dir, name, ARCHIVE_NAME_RE);
  fs.rmSync(target, { force: true });
  buildArchive(target);
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
  return createOnDemandArchive();
}

export interface SweepResult {
  sessionsPurged: number;
  loginAttemptsPurged: number;
  stagedFilesPurged: number;
  receiptOrphansPurged: number;
}

export function runMaintenanceSweep(at: Date = new Date()): SweepResult {
  return {
    sessionsPurged: purgeExpiredSessions(at),
    loginAttemptsPurged: purgeOldLoginAttempts(at),
    stagedFilesPurged: purgeStagedFiles(undefined, at),
    // MUST-4.9: files in receipts/ with no matching stored_filename row AND an mtime older
    // than 24 h. The age guard prevents a race with an in-flight upload.
    receiptOrphansPurged: purgeOrphanReceipts(new Set(listStoredFilenames()), undefined, at),
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
    `[backup] wrote ${backup.name} (${backup.bytes} bytes), pruned ${pruned.length}, purged ${sweep.sessionsPurged} sessions / ${sweep.loginAttemptsPurged} login attempts / ${sweep.stagedFilesPurged} staged uploads / ${sweep.receiptOrphansPurged} orphan receipts`,
  );
  return { backup, pruned, sweep };
}

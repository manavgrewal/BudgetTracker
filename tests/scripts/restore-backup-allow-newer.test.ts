import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';

/**
 * T1 review IMPORTANT 3 (controller ruling): --allow-newer is CLI-only, so it is exercised
 * here as a real subprocess against scripts/restore-backup.ts, in a NEW file — the existing
 * tests/scripts/restore-backup.test.ts must keep passing with zero edits (it is the
 * regression net for the extraction itself, not the place to add a new CLI flag's coverage).
 */
describe('scripts/restore-backup.ts --allow-newer (CLI-only bypass of the one-way guard)', () => {
  const [major, minor] = process.versions.node.split('.').map(Number);
  const stripTypesSupported = major > 22 || (major === 22 && minor >= 6);
  const scriptPath = path.join(process.cwd(), 'scripts', 'restore-backup.ts');

  let work: string;
  let dataDir: string;

  beforeEach(() => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'restore-cli-allow-newer-'));
    dataDir = path.join(work, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(work, { recursive: true, force: true });
  });

  /** A bare .db "backup" carrying one more applied migration than the real journal ships. */
  function makeNewerBackup(): string {
    const file = path.join(work, 'newer.db');
    const db = new Database(file);
    db.exec('create table users (id integer primary key)');
    db.exec('create table accounts (id integer primary key)');
    db.exec('create table transactions (id integer primary key)');
    db.exec('create table __drizzle_migrations (id integer primary key, hash text not null, created_at numeric)');
    const insert = db.prepare('insert into __drizzle_migrations (hash, created_at) values (?, ?)');
    // Comfortably newer than anything drizzle/meta/_journal.json ships in this checkout.
    insert.run('hash-future', 9999999999999);
    db.close();
    return file;
  }

  const runCli = (args: string[]) =>
    spawnSync(process.execPath, ['--experimental-strip-types', scriptPath, ...args], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });

  it.runIf(stripTypesSupported)('usage text documents --allow-newer and when to use it', () => {
    const result = runCli(['--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('--allow-newer');
    expect(result.stdout).toContain('rolling');
  });

  it.runIf(stripTypesSupported)('refuses a newer backup by default', () => {
    const artifact = makeNewerBackup();
    const result = runCli([artifact, '--data-dir', dataDir]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/newer version of Budget Tracker/i);
  });

  it.runIf(stripTypesSupported)('restores a newer backup when --allow-newer is passed', () => {
    const artifact = makeNewerBackup();
    const result = runCli([artifact, '--data-dir', dataDir, '--allow-newer']);
    expect(result.status).toBe(0);
    expect(fs.existsSync(path.join(dataDir, 'budget.db'))).toBe(true);
  });
});

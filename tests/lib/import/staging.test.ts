import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StagingError, deleteStagedFile, purgeStagedFiles, readStagedFile, stagedFilePath, stagingDir, writeStagedFile } from '@/lib/import/staging';

let tempDir: string;
let originalDataDir: string | undefined;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-staging-'));
  originalDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = tempDir;
});

afterEach(() => {
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('staging', () => {
  it('writes under DATA_DIR/tmp and reads back the exact bytes', () => {
    const payload = Buffer.from('03/02/2026,COFFEE,4.85,,0.00\n', 'utf8');
    const id = writeStagedFile(payload);
    expect(stagingDir()).toBe(path.join(tempDir, 'tmp'));
    expect(stagedFilePath(id).startsWith(stagingDir())).toBe(true);
    expect(readStagedFile(id).equals(payload)).toBe(true);
  });

  it('creates the staging directory if it is missing', () => {
    expect(fs.existsSync(path.join(tempDir, 'tmp'))).toBe(false);
    writeStagedFile(Buffer.from('x'));
    expect(fs.existsSync(path.join(tempDir, 'tmp'))).toBe(true);
  });

  it('returns a UUID as the staging id', () => {
    expect(writeStagedFile(Buffer.from('x'))).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('rejects a non-UUID staging id instead of joining it into a path', () => {
    expect(() => stagedFilePath('../../budget.db')).toThrowError(StagingError);
    expect(() => readStagedFile('..\\..\\budget.db')).toThrowError(StagingError);
    expect(() => readStagedFile('')).toThrowError(StagingError);
    expect(() => deleteStagedFile('nope')).toThrowError(StagingError);
  });

  it('throws a StagingError for an unknown but well-formed id', () => {
    expect(() => readStagedFile('00000000-0000-4000-8000-000000000000')).toThrowError(/expired|not found/i);
  });

  it('deletes a staged file and tolerates deleting it twice', () => {
    const id = writeStagedFile(Buffer.from('x'));
    deleteStagedFile(id);
    expect(fs.existsSync(stagedFilePath(id))).toBe(false);
    expect(() => deleteStagedFile(id)).not.toThrow();
  });

  it('purges only files older than the cutoff', () => {
    const stale = writeStagedFile(Buffer.from('old'));
    const fresh = writeStagedFile(Buffer.from('new'));
    const longAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
    fs.utimesSync(stagedFilePath(stale), longAgo, longAgo);

    expect(purgeStagedFiles(24 * 60 * 60 * 1000)).toBe(1);
    expect(fs.existsSync(stagedFilePath(stale))).toBe(false);
    expect(fs.existsSync(stagedFilePath(fresh))).toBe(true);
  });

  it('purging an absent directory is a no-op', () => {
    expect(purgeStagedFiles()).toBe(0);
  });

  it('skips a stale directory in the staging dir instead of crashing the sweep (Ruling P14)', () => {
    // src/lib/backup/archive.ts's buildArchive() stages a whole backup (budget.db +
    // receipts/) under a UUID-suffixed subdirectory of this same DATA_DIR/tmp while a
    // backup is being written. If a container is killed mid-backup, that directory can be
    // left behind; fs.rmSync on a directory without { recursive: true } throws, which
    // would otherwise take down the entire nightly maintenance sweep.
    const stale = writeStagedFile(Buffer.from('old'));
    const longAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
    fs.utimesSync(stagedFilePath(stale), longAgo, longAgo);

    const staleDir = path.join(stagingDir(), 'deadbeef-0000-4000-8000-000000000000-archive');
    fs.mkdirSync(staleDir, { recursive: true });
    fs.writeFileSync(path.join(staleDir, 'budget.db'), 'not actually swept by name');
    fs.utimesSync(staleDir, longAgo, longAgo);

    let removed = -1;
    expect(() => {
      removed = purgeStagedFiles(24 * 60 * 60 * 1000);
    }).not.toThrow();
    expect(removed).toBe(1); // only the stale .csv file, not the directory
    expect(fs.existsSync(stagedFilePath(stale))).toBe(false);
    // The stale directory is left alone by this sweep — it is not a staged upload.
    expect(fs.existsSync(staleDir)).toBe(true);
  });
});

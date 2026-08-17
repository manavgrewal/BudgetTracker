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

  it('does not crash on a directory in the staging dir instead of throwing (Ruling P14)', () => {
    // src/lib/backup/archive.ts's buildArchive() stages a whole backup (budget.db +
    // receipts/) under a `<uuid>-archive` subdirectory of this same DATA_DIR/tmp while a
    // backup is being written. fs.rmSync on a directory without { recursive: true } throws,
    // which would otherwise take down the entire nightly maintenance sweep the moment any
    // directory — stale-archive or otherwise — turns up in this folder.
    const stale = writeStagedFile(Buffer.from('old'));
    const longAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
    fs.utimesSync(stagedFilePath(stale), longAgo, longAgo);

    const staleDir = path.join(stagingDir(), 'deadbeef-0000-4000-8000-000000000000-archive');
    fs.mkdirSync(staleDir, { recursive: true });
    fs.writeFileSync(path.join(staleDir, 'budget.db'), 'not actually swept by name');
    fs.utimesSync(staleDir, longAgo, longAgo);

    expect(() => purgeStagedFiles(24 * 60 * 60 * 1000)).not.toThrow();
  });

  it('recursively removes an aged-out "-archive" directory left by a killed backup (Ruling P14, fix report IMPORTANT 3)', () => {
    // A stale, non-empty staging directory left behind by buildArchive() (e.g. the
    // container was SIGKILLed mid-tar) holds a full copy of the database. Leaving it alone
    // forever — the original P14 fix's behaviour — leaks disk space without bound, so once
    // it's old enough that no in-progress backup could still be writing it, the sweep must
    // remove it, and everything inside it, not just skip past it.
    const staleDir = path.join(stagingDir(), 'deadbeef-0000-4000-8000-000000000000-archive');
    fs.mkdirSync(path.join(staleDir, 'receipts'), { recursive: true });
    fs.writeFileSync(path.join(staleDir, 'budget.db'), 'a full db snapshot');
    fs.writeFileSync(path.join(staleDir, 'receipts', 'r.jpg'), 'x');
    const longAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
    fs.utimesSync(staleDir, longAgo, longAgo);

    expect(purgeStagedFiles(24 * 60 * 60 * 1000)).toBe(1);
    expect(fs.existsSync(staleDir)).toBe(false);
  });

  it('leaves a fresh "-archive" directory alone — a backup still being written must not be swept mid-flight', () => {
    const freshDir = path.join(stagingDir(), 'deadbeef-0000-4000-8000-000000000000-archive');
    fs.mkdirSync(freshDir, { recursive: true });
    fs.writeFileSync(path.join(freshDir, 'budget.db'), 'in progress');

    expect(purgeStagedFiles(24 * 60 * 60 * 1000)).toBe(0);
    expect(fs.existsSync(freshDir)).toBe(true);
  });

  it('recursively removes an aged-out "-restore" directory left by a killed stage (MUST-20.32)', () => {
    // src/lib/backup/restore.ts's stageRestore() builds one of these while validating and
    // staging a restore, holding a hard-linked (or copied) backup payload. Same argument,
    // same age constant, as the existing "-archive" rule above.
    const staleDir = path.join(stagingDir(), 'deadbeef-0000-4000-8000-000000000000-restore');
    fs.mkdirSync(staleDir, { recursive: true });
    fs.writeFileSync(path.join(staleDir, 'payload'), 'a full backup payload');
    fs.writeFileSync(path.join(staleDir, 'restore-request.json'), '{}');
    const longAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
    fs.utimesSync(staleDir, longAgo, longAgo);

    expect(purgeStagedFiles(24 * 60 * 60 * 1000)).toBe(1);
    expect(fs.existsSync(staleDir)).toBe(false);
  });

  it('leaves a fresh "-restore" directory alone — a stage still in progress must not be swept mid-flight', () => {
    const freshDir = path.join(stagingDir(), 'deadbeef-0000-4000-8000-000000000000-restore');
    fs.mkdirSync(freshDir, { recursive: true });
    fs.writeFileSync(path.join(freshDir, 'payload'), 'in progress');

    expect(purgeStagedFiles(24 * 60 * 60 * 1000)).toBe(0);
    expect(fs.existsSync(freshDir)).toBe(true);
  });

  it('leaves an aged-out directory alone when its name does not end in "-archive"', () => {
    // This sweep only removes things it can positively identify as its own leftovers.
    const otherDir = path.join(stagingDir(), 'some-other-directory');
    fs.mkdirSync(otherDir, { recursive: true });
    fs.writeFileSync(path.join(otherDir, 'file.txt'), 'not ours');
    const longAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
    fs.utimesSync(otherDir, longAgo, longAgo);

    expect(purgeStagedFiles(24 * 60 * 60 * 1000)).toBe(0);
    expect(fs.existsSync(otherDir)).toBe(true);
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSeededTestDb, insertTestUser, type TestDb } from '../../helpers/db';
import { createAccount } from '@/lib/accounts';
import { getBuiltinPreset, getProfileByName, listProfiles } from '@/lib/import/presets';
import { stagedFilePath, writeStagedFile } from '@/lib/import/staging';
import { ImportLimitError, MAX_FILE_BYTES } from '@/lib/import/parse';

const fixture = (name: string) => fs.readFileSync(path.join(process.cwd(), 'fixtures', name));

// Only runEngine is mocked; everything else in the module (buildContext,
// categorizeTransaction) keeps its real behaviour, since flow.ts's own logic
// (not the categorizer's) is what's under test here.
const runEngineMock = vi.fn();
vi.mock('@/lib/categorize/engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/categorize/engine')>();
  return { ...actual, runEngine: (...args: Parameters<typeof actual.runEngine>) => runEngineMock(...args) };
});

// commitStagedImport is imported after the mock is registered so it picks up the mocked binding.
const { commitStagedImport } = await import('@/lib/import/flow');

let current: TestDb | null = null;
let tempDir: string;
let originalDataDir: string | undefined;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-flow-unit-'));
  originalDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = tempDir;
  runEngineMock.mockReset();
});

afterEach(() => {
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  fs.rmSync(tempDir, { recursive: true, force: true });
  current?.cleanup();
  current = null;
});

function setup() {
  current = createSeededTestDb();
  const userId = insertTestUser(current.db, { name: 'Alice', username: 'alice' });
  const accountId = createAccount({ name: 'Joint Chequing', institution: 'TD Canada Trust', type: 'chequing', ownerUserId: null });
  const profileId = getProfileByName('TD Chequing/Debit')!.id;
  return { db: current.db, sqlite: current.sqlite, userId, accountId, profileId };
}

describe('commitStagedImport — engine-failure isolation (review finding 2)', () => {
  it('reports engineFailed instead of throwing when runEngine blows up after a successful commit, and still cleans up staging', () => {
    const { sqlite, userId, accountId, profileId } = setup();
    runEngineMock.mockImplementation(() => {
      throw new Error('categorizer exploded');
    });
    const stagingId = writeStagedFile(fixture('td-chequing.csv'));
    const mapping = getBuiltinPreset('TD Chequing/Debit');

    const result = commitStagedImport({ stagingId, filename: 'td.csv', accountId, profileId, mapping, userId });

    expect(result.engineFailed).toBe(true);
    expect(result.rowsAdded).toBe(9);
    expect(result.engine).toEqual({ processed: 0, categorized: 0, transfers: 0, skipped: 0 });
    // The rows are genuinely committed, not rolled back because categorization failed.
    expect((sqlite.prepare('select count(*) as c from transactions').get() as { c: number }).c).toBe(9);
    // Staging must not leak just because the engine threw.
    expect(fs.existsSync(stagedFilePath(stagingId))).toBe(false);
  });

  it('reports engineFailed: false and the real engine stats on the happy path', () => {
    const { userId, accountId, profileId } = setup();
    runEngineMock.mockImplementation((ids: number[]) => ({ processed: ids.length, categorized: 0, transfers: 1, skipped: 0 }));
    const stagingId = writeStagedFile(fixture('td-chequing.csv'));

    const result = commitStagedImport({ stagingId, filename: 'td.csv', accountId, profileId, mapping: getBuiltinPreset('TD Chequing/Debit'), userId });

    expect(result.engineFailed).toBe(false);
    expect(result.engine).toEqual({ processed: 9, categorized: 0, transfers: 1, skipped: 0 });
  });
});

describe('commitStagedImport — fork ordering (review finding 3)', () => {
  it('never forks the profile or repoints the account when the file fails validation', () => {
    const { sqlite, userId, accountId, profileId } = setup();
    const before = listProfiles().length;
    const oversized = Buffer.alloc(MAX_FILE_BYTES + 1, 'a');
    const stagingId = writeStagedFile(oversized);
    // An edited mapping, which WOULD trigger forkProfileIfBuiltin if reached.
    const edited = { ...getBuiltinPreset('TD Chequing/Debit'), encoding: 'utf-8' as const };

    expect(() => commitStagedImport({ stagingId, filename: 'huge.csv', accountId, profileId, mapping: edited, userId })).toThrow(ImportLimitError);

    expect(listProfiles()).toHaveLength(before);
    const account = sqlite.prepare('select import_profile_id from accounts where id = ?').get(accountId) as {
      import_profile_id: number | null;
    };
    expect(account.import_profile_id).toBeNull();
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSeededTestDb, categoryIdByName, insertTestUser, type TestDb } from '../helpers/db';
import { createAccount } from '@/lib/accounts';
import { buildPreview } from '@/lib/import/preview';
import { commitStagedImport } from '@/lib/import/flow';
import { stagedFilePath, writeStagedFile } from '@/lib/import/staging';
import { getBuiltinPreset, getProfileByName, listProfiles } from '@/lib/import/presets';
import { listImportHistory, previewUndoImport, undoImport } from '@/lib/import/commit';
import { confirmCategory, reviewQueueCount } from '@/lib/categorize/engine';
import { getVocabSize } from '@/lib/categorize/bayes';

const fixture = (name: string) => fs.readFileSync(path.join(process.cwd(), 'fixtures', name));

let current: TestDb | null = null;
let tempDir: string;
let originalDataDir: string | undefined;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-flow-'));
  originalDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = tempDir;
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

describe('upload → preview → commit', () => {
  it('runs the whole pipeline and reports the summary counts', () => {
    const { sqlite, userId, accountId, profileId } = setup();
    const stagingId = writeStagedFile(fixture('td-chequing.csv'));
    const mapping = getBuiltinPreset('TD Chequing/Debit');

    const preview = buildPreview({ stagingId, filename: 'td.csv', accountId, profileId, mapping });
    expect(preview.totalRows).toBe(9);
    expect(preview.duplicateCount).toBe(0);

    const result = commitStagedImport({ stagingId, filename: 'td.csv', accountId, profileId, mapping, userId });
    expect(result).toMatchObject({ rowsAdded: 9, rowsDuplicate: 0, rowsError: 0, profileId });
    expect(result.engine.processed).toBe(9);
    expect(result.engine.transfers).toBe(1); // TFR-TO C/C
    expect(result.needsReview).toBe(8);
    expect(reviewQueueCount()).toBe(8);
    expect((sqlite.prepare('select count(*) as c from transactions').get() as { c: number }).c).toBe(9);
  });

  it('deletes the staged file after a successful commit', () => {
    const { userId, accountId, profileId } = setup();
    const stagingId = writeStagedFile(fixture('td-chequing.csv'));
    commitStagedImport({ stagingId, filename: 'td.csv', accountId, profileId, mapping: getBuiltinPreset('TD Chequing/Debit'), userId });
    expect(fs.existsSync(stagedFilePath(stagingId))).toBe(false);
  });

  it('remembers the profile on the account and forks a built-in that was edited', () => {
    const { sqlite, userId, accountId, profileId } = setup();
    const stagingId = writeStagedFile(fixture('td-chequing.csv'));
    const edited = { ...getBuiltinPreset('TD Chequing/Debit'), encoding: 'utf-8' as const };

    const result = commitStagedImport({ stagingId, filename: 'td.csv', accountId, profileId, mapping: edited, userId });
    expect(result.profileId).not.toBe(profileId);
    expect(listProfiles()).toHaveLength(5);
    const account = sqlite.prepare('select import_profile_id from accounts where id = ?').get(accountId) as { import_profile_id: number };
    expect(account.import_profile_id).toBe(result.profileId);
    // The shared built-in is untouched.
    expect(getProfileByName('TD Chequing/Debit')!.mapping!.encoding).toBe('auto');
  });
});

describe('overlapping second import then undo of the first', () => {
  it('keeps the shared rows and deletes only the exclusive ones', () => {
    const { sqlite, userId, accountId, profileId } = setup();
    const mapping = getBuiltinPreset('TD Chequing/Debit');

    const firstStaging = writeStagedFile(fixture('td-chequing.csv'));
    const first = commitStagedImport({ stagingId: firstStaging, filename: 'march-1-7.csv', accountId, profileId, mapping, userId });

    // A second export that repeats the whole file plus one new row. The new
    // row uses the preset's ISO date format (dateFormat 'YYYY-MM-DD' — see
    // src/lib/import/presets.ts) to actually parse instead of erroring out.
    const overlapping = Buffer.concat([fixture('td-chequing.csv'), Buffer.from('2026-03-10,NEW ROW ONLY IN SECOND FILE,15.00,,3576.53\n', 'utf8')]);
    const secondStaging = writeStagedFile(overlapping);
    const second = commitStagedImport({ stagingId: secondStaging, filename: 'march-1-10.csv', accountId, profileId: first.profileId, mapping, userId });

    expect(second).toMatchObject({ rowsAdded: 1, rowsDuplicate: 9 });
    expect((sqlite.prepare('select count(*) as c from transactions').get() as { c: number }).c).toBe(10);

    expect(previewUndoImport(first.importId)).toMatchObject({ willDelete: 0, willKeep: 9 });
    expect(undoImport(first.importId)).toEqual({ deleted: 0, kept: 9, loanLinksReversed: 0 });
    expect((sqlite.prepare('select count(*) as c from transactions').get() as { c: number }).c).toBe(10);

    expect(listImportHistory()).toHaveLength(1);
    expect(undoImport(second.importId)).toEqual({ deleted: 10, kept: 0, loanLinksReversed: 0 });
    expect((sqlite.prepare('select count(*) as c from transactions').get() as { c: number }).c).toBe(0);
  });

  it('reverses Bayes training for the rows undo actually deletes', () => {
    const { db, userId, accountId, profileId } = setup();
    const mapping = getBuiltinPreset('TD Chequing/Debit');
    const stagingId = writeStagedFile(fixture('td-chequing.csv'));
    const result = commitStagedImport({ stagingId, filename: 'td.csv', accountId, profileId, mapping, userId });

    const groceries = categoryIdByName(db, 'Groceries');
    const ids = (current!.sqlite.prepare('select id from transactions order by id').all() as { id: number }[]).map((r) => r.id);
    confirmCategory({ transactionId: ids[0], categoryId: groceries, userId });
    expect(getVocabSize()).toBeGreaterThan(0);

    undoImport(result.importId);
    expect(getVocabSize()).toBe(0);
    expect((current!.sqlite.prepare('select count(*) as c from bayes_tokens').get() as { c: number }).c).toBe(0);
  });
});

describe('the Amex fixture end to end', () => {
  it('imports quoted multi-line rows with the right signs', () => {
    const { sqlite, userId } = setup();
    const amexAccount = createAccount({ name: 'Amex Cobalt', institution: 'American Express Canada', type: 'credit', ownerUserId: null });
    const amexProfile = getProfileByName('Amex Canada')!.id;
    const stagingId = writeStagedFile(fixture('amex.csv'));

    const result = commitStagedImport({
      stagingId,
      filename: 'amex.csv',
      accountId: amexAccount,
      profileId: amexProfile,
      mapping: getBuiltinPreset('Amex Canada'),
      userId,
    });
    // The fixture has 6 data rows, all of which parse cleanly under the
    // corrected Amex preset (17-col layout, descCols [2], amountCol 5).
    expect(result.rowsAdded).toBe(6);
    const rows = sqlite.prepare('select amount_cents, is_transfer from transactions where account_id = ? order by id').all(amexAccount) as {
      amount_cents: number;
      is_transfer: number;
    }[];
    expect(rows.map((r) => r.amount_cents)).toEqual([-1875, -4420, 35000, -660, 5999, -2745]);
    expect(rows[2].is_transfer).toBe(1); // AMEX PAYMENT RECEIVED - THANK YOU
  });
});

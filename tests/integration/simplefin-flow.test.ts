import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSeededTestDb, insertTestUser, type TestDb } from '../helpers/db';
import { claimSetupToken, type Fetcher } from '@/lib/simplefin/client';
import { getAccessUrl, isSimplefinManaged, linkAccount, saveClaimedConnection, unlinkAccount } from '@/lib/simplefin/connection';
import { runSync } from '@/lib/simplefin/sync';
import { createAccount } from '@/lib/accounts';
import { commitStagedImport } from '@/lib/import/flow';
import { writeStagedFile } from '@/lib/import/staging';
import { getBuiltinPreset, getProfileByName } from '@/lib/import/presets';
import { previewUndoImport, undoImport } from '@/lib/import/commit';

const fixture = (name: string) => fs.readFileSync(path.join(process.cwd(), 'fixtures', name));
const CLAIM_URL = 'https://bridge.example/simplefin/claim/DEMO';
const SETUP_TOKEN = Buffer.from(CLAIM_URL, 'utf8').toString('base64');
const ACCESS_URL = 'https://abc123:s3cr3t@bridge.example/simplefin';
const NOW = new Date('2026-08-15T12:00:00.000Z');

let current: TestDb | null = null;
let dataDir: string;
let originalDataDir: string | undefined;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-simplefin-'));
  originalDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = dataDir;
});

afterEach(() => {
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  fs.rmSync(dataDir, { recursive: true, force: true });
  current?.cleanup();
  current = null;
});

function bridge(body: unknown): Fetcher {
  return vi.fn(async () => ({ ok: true, status: 200, text: async () => JSON.stringify(body) }));
}

const txn = (id: string, iso: string, amount: string, description: string) => ({
  id,
  posted: Math.floor(Date.parse(iso) / 1000),
  amount,
  description,
  pending: false,
});

function payload(transactions: Record<string, unknown>[]) {
  return {
    accounts: [{ id: 'remote-1', name: 'Bridge Chequing', currency: 'CAD', balance: '1000.00', 'balance-date': 1755216000, transactions }],
    errlist: [],
  };
}

describe('claim → link → sync', () => {
  it('claims once and stores the access URL encrypted, never in plaintext', async () => {
    current = createSeededTestDb();
    const claimFetcher = vi.fn(async () => ({ ok: true, status: 200, text: async () => ACCESS_URL }));
    const accessUrl = await claimSetupToken(SETUP_TOKEN, claimFetcher);
    saveClaimedConnection(accessUrl, NOW);

    const stored = current.sqlite.prepare('select access_url_encrypted from simplefin_connections').get() as { access_url_encrypted: string };
    expect(stored.access_url_encrypted).not.toContain('s3cr3t');
    expect(stored.access_url_encrypted).not.toContain('bridge.example');
    expect(getAccessUrl()).toBe(ACCESS_URL);
  });

  it('rejects reusing a spent setup token', async () => {
    current = createSeededTestDb();
    const spent = vi.fn(async () => ({ ok: false, status: 403, text: async () => 'Forbidden' }));
    await expect(claimSetupToken(SETUP_TOKEN, spent)).rejects.toThrowError(/only be claimed once/i);
  });

  it('imports, then re-syncs an overlapping window with no duplicates', async () => {
    current = createSeededTestDb();
    const userId = insertTestUser(current.db, { name: 'Alice', username: 'alice' });
    const accountId = createAccount({ name: 'Bridge Chequing', institution: 'Bridge Bank', type: 'chequing', ownerUserId: null });
    saveClaimedConnection(ACCESS_URL, NOW);
    linkAccount({ simplefinAccountId: 'remote-1', accountId, currency: 'CAD' });

    const first = await runSync({
      userId,
      now: NOW,
      fetcher: bridge(payload([txn('t1', '2026-08-10T15:00:00Z', '-12.34', 'TIM HORTONS'), txn('t2', '2026-08-11T15:00:00Z', '-45.00', 'PETRO-CANADA')])),
    });
    expect(first.totalAdded).toBe(2);

    // Second sync: the same two rows plus one new one, exactly what a 5-day overlap produces.
    const second = await runSync({
      userId,
      now: new Date('2026-08-16T12:00:00.000Z'),
      fetcher: bridge(
        payload([
          txn('t1', '2026-08-10T15:00:00Z', '-12.34', 'TIM HORTONS'),
          txn('t2', '2026-08-11T15:00:00Z', '-45.00', 'PETRO-CANADA'),
          txn('t3', '2026-08-15T15:00:00Z', '-8.75', 'LOBLAWS'),
        ]),
      ),
    });
    expect(second.totalAdded).toBe(1);
    expect(second.totalDuplicates).toBe(2);
    expect((current.sqlite.prepare('select count(*) as c from transactions').get() as { c: number }).c).toBe(3);
  });

  it('undo of a sync behaves exactly like undo of a CSV import', async () => {
    current = createSeededTestDb();
    const userId = insertTestUser(current.db, { name: 'Alice', username: 'alice' });
    const accountId = createAccount({ name: 'Bridge Chequing', institution: 'Bridge Bank', type: 'chequing', ownerUserId: null });
    saveClaimedConnection(ACCESS_URL, NOW);
    linkAccount({ simplefinAccountId: 'remote-1', accountId, currency: 'CAD' });

    const rows = [txn('t1', '2026-08-10T15:00:00Z', '-12.34', 'TIM HORTONS'), txn('t2', '2026-08-11T15:00:00Z', '-45.00', 'PETRO-CANADA')];
    const first = await runSync({ userId, now: NOW, fetcher: bridge(payload(rows)) });
    const second = await runSync({ userId, now: new Date('2026-08-16T12:00:00.000Z'), fetcher: bridge(payload(rows)) });

    // Both syncs saw both rows, so the first sync owns nothing exclusively.
    const firstImportId = first.accounts[0].importId!;
    expect(previewUndoImport(firstImportId)).toMatchObject({ willDelete: 0, willKeep: 2 });
    expect(undoImport(firstImportId)).toEqual({ deleted: 0, kept: 2, loanLinksReversed: 0 });
    expect((current.sqlite.prepare('select count(*) as c from transactions').get() as { c: number }).c).toBe(2);

    expect(undoImport(second.accounts[0].importId!)).toEqual({ deleted: 2, kept: 0, loanLinksReversed: 0 });
    expect((current.sqlite.prepare('select count(*) as c from transactions').get() as { c: number }).c).toBe(0);
  });
});

describe('CSV vs SimpleFIN exclusivity', () => {
  it('refuses a CSV import into a linked account, and allows it again after unlinking', async () => {
    current = createSeededTestDb();
    const userId = insertTestUser(current.db, { name: 'Alice', username: 'alice' });
    const accountId = createAccount({ name: 'Bridge Chequing', institution: 'TD Canada Trust', type: 'chequing', ownerUserId: null });
    const profileId = getProfileByName('TD Chequing/Debit')!.id;
    saveClaimedConnection(ACCESS_URL, NOW);
    linkAccount({ simplefinAccountId: 'remote-1', accountId, currency: 'CAD' });
    expect(isSimplefinManaged(accountId)).toBe(true);

    const stagingId = writeStagedFile(fixture('td-chequing.csv'));
    expect(() =>
      commitStagedImport({
        stagingId,
        filename: 'td.csv',
        accountId,
        profileId,
        mapping: getBuiltinPreset('TD Chequing/Debit'),
        userId,
      }),
    ).toThrowError(/synced from SimpleFIN/i);
    expect((current.sqlite.prepare('select count(*) as c from transactions').get() as { c: number }).c).toBe(0);

    unlinkAccount('remote-1');
    expect(isSimplefinManaged(accountId)).toBe(false);
    const retry = writeStagedFile(fixture('td-chequing.csv'));
    const result = commitStagedImport({
      stagingId: retry,
      filename: 'td.csv',
      accountId,
      profileId,
      mapping: getBuiltinPreset('TD Chequing/Debit'),
      userId,
    });
    expect(result.rowsAdded).toBe(9);
  });

  it('leaves unlinked accounts importing normally', async () => {
    current = createSeededTestDb();
    const userId = insertTestUser(current.db, { name: 'Alice', username: 'alice' });
    const linked = createAccount({ name: 'Bridge Chequing', institution: 'Bridge', type: 'chequing', ownerUserId: null });
    const csvOnly = createAccount({ name: 'Joint Visa', institution: 'TD Canada Trust', type: 'credit', ownerUserId: null });
    saveClaimedConnection(ACCESS_URL, NOW);
    linkAccount({ simplefinAccountId: 'remote-1', accountId: linked, currency: 'CAD' });

    const stagingId = writeStagedFile(fixture('td-visa.csv'));
    const result = commitStagedImport({
      stagingId,
      filename: 'visa.csv',
      accountId: csvOnly,
      profileId: getProfileByName('TD Visa')!.id,
      mapping: getBuiltinPreset('TD Visa'),
      userId,
    });
    expect(result.rowsAdded).toBe(6);
  });
});

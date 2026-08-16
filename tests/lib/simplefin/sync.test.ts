import { describe, it, expect, afterEach, vi } from 'vitest';
import { createSeededTestDb, insertTestAccount, insertTestUser, type TestDb } from '../../helpers/db';
import { amountToCents, postedToIsoDate, runSync, syncWindow } from '@/lib/simplefin/sync';
import { DAILY_REQUEST_LIMIT, getConnection, linkAccount, listLinks, remainingRequestsToday, saveClaimedConnection } from '@/lib/simplefin/connection';
import type { Fetcher } from '@/lib/simplefin/client';
import { listImportHistory } from '@/lib/import/commit';

let current: TestDb | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
});

const ACCESS_URL = 'https://abc123:s3cr3t@bridge.example/simplefin';
const NOW = new Date('2026-08-15T12:00:00.000Z');

function bridge(body: unknown): Fetcher {
  return vi.fn(async () => ({ ok: true, status: 200, text: async () => JSON.stringify(body) }));
}

function accountSet(transactions: Record<string, unknown>[], over: Record<string, unknown> = {}) {
  return {
    accounts: [
      {
        id: 'remote-1',
        name: 'Bridge Chequing',
        currency: 'CAD',
        balance: '1234.56',
        'balance-date': 1755216000,
        transactions,
        ...over,
      },
    ],
    errlist: [],
  };
}

function setup() {
  current = createSeededTestDb();
  const userId = insertTestUser(current.db, { name: 'Alice', username: 'alice' });
  const accountId = insertTestAccount(current.db, { name: 'Joint Chequing' });
  saveClaimedConnection(ACCESS_URL, NOW);
  linkAccount({ simplefinAccountId: 'remote-1', accountId, currency: 'CAD' });
  return { db: current.db, sqlite: current.sqlite, userId, accountId };
}

describe('pure helpers', () => {
  it('converts amounts to integer cents, negative = debit', () => {
    expect(amountToCents('-12.34')).toBe(-1234);
    expect(amountToCents('12.34')).toBe(1234);
    expect(amountToCents('0.05')).toBe(5);
    expect(amountToCents('-1234.5')).toBe(-123450);
    expect(amountToCents('1,234.56')).toBe(123456);
    expect(amountToCents('nope')).toBeNull();
    expect(amountToCents('')).toBeNull();
  });

  it('rounds correctly at 3+ decimal places instead of losing a cent to float error (SimpleFIN permits arbitrary precision)', () => {
    expect(amountToCents('8.165')).toBe(817);
    expect(amountToCents('-8.165')).toBe(-817);
  });

  it('converts unix posted to an ISO date in the configured zone', () => {
    // 2026-03-15T02:30:00Z is still 2026-03-14 in Toronto.
    expect(postedToIsoDate(1773541800, 'America/Toronto')).toBe(postedToIsoDate(1773541800, 'America/Toronto'));
    expect(postedToIsoDate(Math.floor(Date.parse('2026-03-15T02:30:00.000Z') / 1000), 'America/Toronto')).toBe('2026-03-14');
    expect(postedToIsoDate(Math.floor(Date.parse('2026-03-15T02:30:00.000Z') / 1000), 'UTC')).toBe('2026-03-15');
  });

  it('asks for 90 days on a first sync', () => {
    const window = syncWindow({ lastSyncAt: null, now: NOW });
    expect(window.endDate).toBe(Math.floor(NOW.getTime() / 1000));
    expect(window.endDate - window.startDate).toBe(90 * 86400);
  });

  it('uses a 5-day overlap on later syncs', () => {
    const lastSync = new Date('2026-08-14T12:00:00.000Z').toISOString();
    const window = syncWindow({ lastSyncAt: lastSync, now: NOW });
    expect(window.endDate - window.startDate).toBe(6 * 86400);
  });

  it('never exceeds 90 days even after a long gap', () => {
    const lastSync = new Date('2025-01-01T00:00:00.000Z').toISOString();
    const window = syncWindow({ lastSyncAt: lastSync, now: NOW });
    expect(window.endDate - window.startDate).toBe(90 * 86400);
  });
});

describe('runSync', () => {
  it('inserts settled rows, skips pending ones, and records an imports row', async () => {
    const { sqlite, userId } = setup();
    const fetcher = bridge(
      accountSet([
        { id: 'txn-1', posted: Math.floor(Date.parse('2026-08-10T15:00:00Z') / 1000), amount: '-12.34', description: 'TIM HORTONS #4821', pending: false },
        { id: 'txn-2', posted: Math.floor(Date.parse('2026-08-11T15:00:00Z') / 1000), amount: '2145.67', description: 'PAYROLL DEPOSIT', pending: false },
        { id: 'txn-3', posted: Math.floor(Date.parse('2026-08-14T15:00:00Z') / 1000), amount: '-99.99', description: 'STILL SETTLING', pending: true },
      ]),
    );

    const result = await runSync({ userId, fetcher, now: NOW });

    expect(result.totalAdded).toBe(2);
    expect(result.accounts[0]).toMatchObject({ simplefinAccountId: 'remote-1', added: 2, duplicates: 0, skippedPending: 1 });
    expect((sqlite.prepare('select count(*) as c from transactions').get() as { c: number }).c).toBe(2);

    const rows = sqlite.prepare('select date, raw_description, amount_cents, external_id, dedup_hash from transactions order by date').all() as Record<string, unknown>[];
    expect(rows[0]).toMatchObject({ date: '2026-08-10', raw_description: 'TIM HORTONS #4821', amount_cents: -1234, external_id: 'txn-1', dedup_hash: null });
    expect(rows[1]).toMatchObject({ date: '2026-08-11', amount_cents: 214567, external_id: 'txn-2' });

    const history = listImportHistory();
    expect(history).toHaveLength(1);
    expect(history[0].filename).toMatch(/^simplefin /);
    expect(history[0].rowsAdded).toBe(2);
  });

  it('runs the categorization engine on the inserted rows', async () => {
    const { sqlite, userId } = setup();
    const fetcher = bridge(
      accountSet([
        { id: 'txn-1', posted: Math.floor(Date.parse('2026-08-10T15:00:00Z') / 1000), amount: '500.00', description: 'PAYMENT - THANK YOU', pending: false },
      ]),
    );
    const result = await runSync({ userId, fetcher, now: NOW });
    expect(result.engine.transfers).toBe(1);
    const row = sqlite.prepare('select is_transfer, normalized_merchant from transactions').get() as { is_transfer: number; normalized_merchant: string };
    expect(row.is_transfer).toBe(1);
    expect(row.normalized_merchant).toBe('PAYMENT - THANK YOU');
  });

  it('is idempotent across an overlapping window — external_id catches the repeats', async () => {
    const { sqlite, userId } = setup();
    const payload = accountSet([
      { id: 'txn-1', posted: Math.floor(Date.parse('2026-08-10T15:00:00Z') / 1000), amount: '-12.34', description: 'TIM HORTONS', pending: false },
      { id: 'txn-2', posted: Math.floor(Date.parse('2026-08-11T15:00:00Z') / 1000), amount: '-45.00', description: 'PETRO-CANADA', pending: false },
    ]);

    const first = await runSync({ userId, fetcher: bridge(payload), now: NOW });
    expect(first.totalAdded).toBe(2);

    const second = await runSync({ userId, fetcher: bridge(payload), now: new Date('2026-08-15T13:00:00.000Z') });
    expect(second.totalAdded).toBe(0);
    expect(second.totalDuplicates).toBe(2);
    expect((sqlite.prepare('select count(*) as c from transactions').get() as { c: number }).c).toBe(2);
    expect(listImportHistory()).toHaveLength(2);
  });

  it('records duplicate associations so undo stays safe across syncs', async () => {
    const { sqlite, userId } = setup();
    const payload = accountSet([
      { id: 'txn-1', posted: Math.floor(Date.parse('2026-08-10T15:00:00Z') / 1000), amount: '-12.34', description: 'TIM HORTONS', pending: false },
    ]);
    await runSync({ userId, fetcher: bridge(payload), now: NOW });
    await runSync({ userId, fetcher: bridge(payload), now: new Date('2026-08-15T13:00:00.000Z') });

    const links = sqlite.prepare('select count(*) as c from transaction_imports').get() as { c: number };
    expect(links.c).toBe(2); // one transaction, associated with both syncs
  });

  it('counts each request against the daily budget and refuses past the limit', async () => {
    const { userId } = setup();
    const payload = accountSet([]);
    expect(remainingRequestsToday(NOW)).toBe(DAILY_REQUEST_LIMIT);

    await runSync({ userId, fetcher: bridge(payload), now: NOW });
    expect(remainingRequestsToday(NOW)).toBe(DAILY_REQUEST_LIMIT - 1);

    for (let i = 1; i < DAILY_REQUEST_LIMIT; i += 1) {
      await runSync({ userId, fetcher: bridge(payload), now: NOW });
    }
    expect(remainingRequestsToday(NOW)).toBe(0);

    const blocked = bridge(payload);
    await expect(runSync({ userId, fetcher: blocked, now: NOW })).rejects.toThrowError(/request budget/i);
    expect(blocked).not.toHaveBeenCalled();
  });

  it('resets the daily counter on a new day', async () => {
    const { userId } = setup();
    const payload = accountSet([]);
    for (let i = 0; i < DAILY_REQUEST_LIMIT; i += 1) {
      await runSync({ userId, fetcher: bridge(payload), now: NOW });
    }
    expect(remainingRequestsToday(NOW)).toBe(0);
    const tomorrow = new Date('2026-08-16T12:00:00.000Z');
    expect(remainingRequestsToday(tomorrow)).toBe(DAILY_REQUEST_LIMIT);
    await expect(runSync({ userId, fetcher: bridge(payload), now: tomorrow })).resolves.toBeTruthy();
  });

  it('surfaces errlist entries instead of swallowing them', async () => {
    const { userId } = setup();
    const fetcher = bridge({ accounts: [], errlist: ['Bank X needs re-authentication'] });
    const result = await runSync({ userId, fetcher, now: NOW });
    expect(result.errlist).toEqual(['Bank X needs re-authentication']);
    expect(result.totalAdded).toBe(0);
  });

  it('warns on a non-CAD account but still imports it', async () => {
    const { userId } = setup();
    const fetcher = bridge(
      accountSet(
        [{ id: 'txn-1', posted: Math.floor(Date.parse('2026-08-10T15:00:00Z') / 1000), amount: '-12.34', description: 'AMAZON US', pending: false }],
        { currency: 'USD' },
      ),
    );
    const result = await runSync({ userId, fetcher, now: NOW });
    expect(result.accounts[0].currencyWarning).toMatch(/USD/);
    expect(result.accounts[0].added).toBe(1);
  });

  it('ignores remote accounts that are not linked', async () => {
    const { userId, sqlite } = setup();
    const fetcher = bridge({
      accounts: [
        { id: 'remote-999', name: 'Not linked', currency: 'CAD', balance: '0', transactions: [{ id: 'x', posted: 1755216000, amount: '-1.00', description: 'NOPE' }] },
      ],
      errlist: [],
    });
    const result = await runSync({ userId, fetcher, now: NOW });
    expect(result.accounts).toHaveLength(0);
    expect((sqlite.prepare('select count(*) as c from transactions').get() as { c: number }).c).toBe(0);
  });

  it('records the reported balance on the link', async () => {
    const { userId } = setup();
    await runSync({ userId, fetcher: bridge(accountSet([])), now: NOW });
    const link = listLinks()[0];
    expect(link.lastBalanceCents).toBe(123456);
    expect(link.lastBalanceDate).not.toBeNull();
  });

  it('counts unparseable rows as errors rather than crashing the sync', async () => {
    const { userId } = setup();
    const fetcher = bridge(
      accountSet([
        { id: 'txn-good', posted: Math.floor(Date.parse('2026-08-10T15:00:00Z') / 1000), amount: '-12.34', description: 'GOOD ROW', pending: false },
        { id: 'txn-bad', posted: Math.floor(Date.parse('2026-08-10T15:00:00Z') / 1000), amount: 'not-a-number', description: 'BAD ROW', pending: false },
        { id: '', posted: 0, amount: '-1.00', description: 'NO ID', pending: false },
      ]),
    );
    const result = await runSync({ userId, fetcher, now: NOW });
    expect(result.accounts[0].added).toBe(1);
    expect(result.accounts[0].errors).toBe(2);
  });

  it('updates last_sync_at so the next window narrows', async () => {
    const { userId } = setup();
    expect(getConnection()?.lastSyncAt).toBeNull();
    await runSync({ userId, fetcher: bridge(accountSet([])), now: NOW });
    expect(getConnection()?.lastSyncAt).toBe(NOW.toISOString());
  });

  it('refuses to sync when nothing is configured', async () => {
    current = createSeededTestDb();
    const userId = insertTestUser(current.db);
    await expect(runSync({ userId, fetcher: bridge(accountSet([])), now: NOW })).rejects.toThrowError(/no SimpleFIN connection/i);
  });

  it('counts a malformed posted date as an error instead of crashing the whole sync (Intl.DateTimeFormat would otherwise throw on an Invalid Date)', async () => {
    const { userId, sqlite } = setup();
    const fetcher = bridge(
      accountSet([
        { id: 'txn-good', posted: Math.floor(Date.parse('2026-08-10T15:00:00Z') / 1000), amount: '-12.34', description: 'GOOD ROW', pending: false },
        { id: 'txn-bad-posted', posted: 'not-a-timestamp', amount: '-1.00', description: 'BAD POSTED', pending: false },
      ]),
    );
    const result = await runSync({ userId, fetcher, now: NOW });
    expect(result.accounts[0].added).toBe(1);
    expect(result.accounts[0].errors).toBe(1);
    expect((sqlite.prepare('select count(*) as c from transactions').get() as { c: number }).c).toBe(1);
  });

  it('does not crash when the account balance-date is malformed — the balance itself is still recorded', async () => {
    const { userId } = setup();
    const fetcher = bridge(accountSet([], { 'balance-date': 'not-a-timestamp' }));
    await expect(runSync({ userId, fetcher, now: NOW })).resolves.toBeTruthy();
    const link = listLinks()[0];
    expect(link.lastBalanceCents).toBe(123456);
    expect(link.lastBalanceDate).toBeNull();
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb, insertTestUser, type TestDb } from '../../helpers/db';
import { saveEmailTarget, saveSmtp } from '@/lib/notify/config';
import { resetOutboxPumpForTests } from '@/lib/notify/outbox';
import { resetNotifySenderForTests, setNotifySenderForTests } from '@/lib/notify/send';
import { RESTORE_NOTIFY_MAX_AGE_MS, raiseBackupFailed, raiseNewSignin, raiseRestoreOutcome } from '@/lib/notify/raise';

const readRestoreState = vi.hoisted(() => vi.fn());
vi.mock('@/lib/backup/restore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/backup/restore')>()),
  readRestoreState,
}));

let t: TestDb;

beforeEach(() => {
  t = createTestDb();
  resetOutboxPumpForTests();
  setNotifySenderForTests(async () => {});
  readRestoreState.mockReset().mockReturnValue({ staged: null, result: null });
});

afterEach(() => {
  resetNotifySenderForTests();
  resetOutboxPumpForTests();
  t.cleanup();
});

function emailUser(role: 'admin' | 'member' = 'admin'): number {
  const userId = insertTestUser(t.db, { role, username: `u${Math.random().toString(36).slice(2, 8)}`, name: 'Sam' });
  saveSmtp({
    preset: 'brevo',
    host: 'h',
    port: 587,
    security: 'starttls',
    username: 'u',
    password: 'p',
    fromEmail: 'f@e.com',
    fromName: 'Budget Tracker',
    enabled: true,
  });
  saveEmailTarget({ userId, destination: 'sam@example.com', enabled: true });
  return userId;
}

function rows(): { user_id: number; event_id: string; dedup_key: string; subject: string; body: string }[] {
  return t.sqlite
    .prepare('select user_id, event_id, dedup_key, subject, body from notification_outbox order by id')
    .all() as never;
}

describe('MUST-6.19: raiseNewSignin', () => {
  it('enqueues one row keyed on the session created_at', () => {
    const userId = emailUser();
    raiseNewSignin({
      userId,
      at: new Date('2026-08-17T21:14:00Z'),
      ip: '192.168.1.44',
      userAgent: 'Mozilla/5.0',
      sessionCreatedAt: '2026-08-17T21:14:00.000Z',
    });
    expect(rows()).toHaveLength(1);
    expect(rows()[0]?.dedup_key).toBe('signin:2026-08-17T21:14:00.000Z');
    expect(rows()[0]?.body).toContain('192.168.1.44');
  });

  it('never throws, even when the database is unusable', () => {
    t.sqlite.close();
    expect(() =>
      raiseNewSignin({ userId: 1, at: new Date(), ip: '1.2.3.4', userAgent: null, sessionCreatedAt: 'x' }),
    ).not.toThrow();
  });
});

describe('MUST-6.19 / MUST-14.1: raiseBackupFailed', () => {
  it('enqueues one row per active admin, keyed on the calendar day', () => {
    const admin = emailUser('admin');
    const member = emailUser('member');
    // vitest.config.ts pins TZ to America/Toronto (EDT, UTC-4 in August): 06:00Z is 02:00
    // local on the same calendar day the dedup key below asserts.
    raiseBackupFailed({ error: new Error('ENOSPC: no space left'), at: new Date('2026-08-17T06:00:00Z') });
    expect(rows().map((r) => r.user_id)).toEqual([admin]);
    expect(rows()[0]?.dedup_key).toBe('backup-failed:2026-08-17');
    expect(rows()[0]?.body).toContain('ENOSPC: no space left');
    expect(member).toBeGreaterThan(0);
  });

  it('fires at most once per calendar day', () => {
    emailUser('admin');
    raiseBackupFailed({ error: new Error('a'), at: new Date('2026-08-17T06:00:00Z') });
    raiseBackupFailed({ error: new Error('b'), at: new Date('2026-08-17T07:00:00Z') });
    expect(rows()).toHaveLength(1);
  });

  it('never throws', () => {
    t.sqlite.close();
    expect(() => raiseBackupFailed({ error: new Error('x'), at: new Date() })).not.toThrow();
  });
});

describe('MUST-14.2: raiseRestoreOutcome', () => {
  const outcome = {
    version: 1,
    status: 'success',
    sourceName: 'budget-2026-08-16.tar.gz',
    kind: 'archive',
    requestedByUserId: 1,
    requestedByUsername: 'manav',
    requestedAt: '2026-08-17T03:00:00.000Z',
    finishedAt: '2026-08-17T03:12:04.000Z',
    safetyCopy: null,
    receiptsMovedAside: null,
    receiptsRestored: 12,
    missingReceiptRows: 1,
    receiptsTouched: 13,
    error: null,
  } as const;

  it('enqueues for every admin when the outcome is fresh', () => {
    const admin = emailUser('admin');
    readRestoreState.mockReturnValue({ staged: null, result: outcome });
    raiseRestoreOutcome(new Date('2026-08-17T04:00:00Z'));
    expect(rows().map((r) => r.user_id)).toEqual([admin]);
    expect(rows()[0]?.dedup_key).toBe('restore:2026-08-17T03:12:04.000Z');
    expect(rows()[0]?.subject).toBe('Restore succeeded');
  });

  it('skips an outcome older than 24 hours — result.json persists across boots', () => {
    emailUser('admin');
    readRestoreState.mockReturnValue({ staged: null, result: outcome });
    raiseRestoreOutcome(new Date(new Date(outcome.finishedAt).getTime() + RESTORE_NOTIFY_MAX_AGE_MS + 1000));
    expect(rows()).toHaveLength(0);
  });

  it('does nothing when there is no result at all', () => {
    emailUser('admin');
    raiseRestoreOutcome(new Date('2026-08-17T04:00:00Z'));
    expect(rows()).toHaveLength(0);
  });

  it('never throws', () => {
    readRestoreState.mockImplementation(() => {
      throw new Error('unreadable');
    });
    expect(() => raiseRestoreOutcome(new Date())).not.toThrow();
  });
});

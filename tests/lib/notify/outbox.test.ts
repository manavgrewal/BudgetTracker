import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTestDb, insertTestUser, type TestDb } from '../../helpers/db';
import { getSmtp, saveEmailTarget, saveSmtp, saveTelegramTarget, getTarget, removeTarget } from '@/lib/notify/config';
import { CREDENTIAL_UNREADABLE } from '@/lib/notify/crypto';
import { NotifyError, resetNotifySenderForTests, setNotifySenderForTests, type DeliveryRequest } from '@/lib/notify/send';
import {
  CHANNEL_REMOVED_ERROR,
  DEFERRED_ERROR,
  MAX_ATTEMPTS,
  MAX_BACKOFF_MS,
  OUTBOX_RETENTION_DAYS,
  PENDING_EXPIRED_ERROR,
  backoffMs,
  countPendingOutbox,
  drainOutboxForTests,
  enqueue,
  expireStalePending,
  listRecentDeliveries,
  pumpOutbox,
  purgeOldOutboxRows,
  resetOutboxPumpForTests,
} from '@/lib/notify/outbox';

const TOKEN = '123456789:AAHk3f-EXAMPLE-tokenxxxxxxxxxxxxxxxxxx';

let t: TestDb;
let sent: DeliveryRequest[];

beforeEach(() => {
  t = createTestDb();
  sent = [];
  resetOutboxPumpForTests();
  setNotifySenderForTests(async (request) => {
    sent.push(request);
  });
});

afterEach(() => {
  resetNotifySenderForTests();
  resetOutboxPumpForTests();
  t.cleanup();
});

function configuredUser(): number {
  const userId = insertTestUser(t.db, { role: 'admin', username: `u${Math.random().toString(36).slice(2, 8)}` });
  saveSmtp({
    preset: 'brevo',
    host: 'smtp-relay.brevo.com',
    port: 587,
    security: 'starttls',
    username: 'me@example.com',
    password: 'pw',
    fromEmail: 'me@example.com',
    fromName: 'Budget Tracker',
    enabled: true,
  });
  saveEmailTarget({ userId, destination: 'sam@example.com', enabled: true });
  saveTelegramTarget({ userId, destination: '5551234', botToken: TOKEN, enabled: true });
  return userId;
}

describe('MUST-7.6: the backoff ladder', () => {
  it('is 2/4/8/16/32/64/128/256 minutes and caps at six hours', () => {
    const minutes = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => backoffMs(n) / 60_000);
    expect(minutes).toEqual([2, 4, 8, 16, 32, 64, 128, 256]);
    expect(backoffMs(12)).toBe(MAX_BACKOFF_MS);
    expect(MAX_ATTEMPTS).toBe(8);
  });
});

describe('MUST-7.1 / MUST-3.9: enqueue', () => {
  it('inserts one row per enabled channel', () => {
    const userId = configuredUser();
    const result = enqueue({ userId, eventId: 'coming_due', dedupKey: 'due:1:2026-09-01', subject: 's', body: 'b' });
    expect(result.inserted.sort()).toEqual(['email', 'telegram']);
    expect(countPendingOutbox()).toBe(2);
  });

  it('a duplicate enqueue inserts nothing and reports it', () => {
    const userId = configuredUser();
    enqueue({ userId, eventId: 'coming_due', dedupKey: 'due:1:2026-09-01', subject: 's', body: 'b' });
    const again = enqueue({ userId, eventId: 'coming_due', dedupKey: 'due:1:2026-09-01', subject: 's', body: 'b' });
    expect(again.inserted).toEqual([]);
    expect(countPendingOutbox()).toBe(2);
  });

  it('MUST-4.2: enqueues nothing for a user with no channel', () => {
    const userId = insertTestUser(t.db, { username: 'bare' });
    expect(enqueue({ userId, eventId: 'coming_due', dedupKey: 'k', subject: 's', body: 'b' }).inserted).toEqual([]);
    expect(countPendingOutbox()).toBe(0);
  });

  it('sets attempts 0 and next_attempt_at = created_at', () => {
    const userId = configuredUser();
    enqueue({ userId, eventId: 'coming_due', dedupKey: 'k', subject: 's', body: 'b', at: new Date('2026-08-17T12:00:00Z') });
    const row = t.sqlite.prepare('select attempts, next_attempt_at, created_at from notification_outbox limit 1').get() as {
      attempts: number;
      next_attempt_at: string;
      created_at: string;
    };
    expect(row.attempts).toBe(0);
    expect(row.next_attempt_at).toBe(row.created_at);
    expect(row.created_at).toBe('2026-08-17T12:00:00.000Z');
  });
});

describe('MUST-7.3: the pump', () => {
  it('sends both channels and marks the rows sent', async () => {
    const userId = configuredUser();
    enqueue({ userId, eventId: 'coming_due', dedupKey: 'k', subject: 'Subject', body: 'Body', at: new Date('2026-08-17T12:00:00Z') });
    const result = await pumpOutbox(new Date('2026-08-17T12:05:00Z'));
    expect(result).toEqual({ sent: 2, failed: 0, deferred: 0 });
    expect(sent.map((r) => r.channel).sort()).toEqual(['email', 'telegram']);
    expect(sent.every((r) => r.subject === 'Subject' && r.body === 'Body')).toBe(true);
    const rows = t.sqlite.prepare(`select status, attempts, sent_at from notification_outbox`).all() as {
      status: string;
      attempts: number;
      sent_at: string | null;
    }[];
    expect(rows.every((r) => r.status === 'sent' && r.attempts === 1 && r.sent_at !== null)).toBe(true);
  });

  it('MUST-7.3: per-channel isolation — a Telegram throw leaves email rows untouched', async () => {
    const userId = configuredUser();
    enqueue({ userId, eventId: 'coming_due', dedupKey: 'k1', subject: 's', body: 'b', at: new Date('2026-08-17T12:00:00Z') });
    setNotifySenderForTests(async (request) => {
      if (request.channel === 'telegram') throw new NotifyError('telegram down', { permanent: false });
      sent.push(request);
    });
    const result = await pumpOutbox(new Date('2026-08-17T12:05:00Z'));
    expect(result.sent).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.channel).toBe('email');
    const telegram = t.sqlite
      .prepare(`select status, attempts from notification_outbox where channel = 'telegram'`)
      .get() as { status: string; attempts: number };
    expect(telegram.status).toBe('pending');
    expect(telegram.attempts).toBe(1);
  });

  it('MUST-7.4: the first transient failure defers the rest of that channel group untried', async () => {
    const userId = configuredUser();
    removeTarget(userId, 'email');
    for (let i = 0; i < 4; i += 1) {
      enqueue({ userId, eventId: 'coming_due', dedupKey: `k${i}`, subject: 's', body: 'b', at: new Date('2026-08-17T12:00:00Z') });
    }
    let calls = 0;
    setNotifySenderForTests(async () => {
      calls += 1;
      throw new NotifyError('relay unreachable', { permanent: false });
    });
    const result = await pumpOutbox(new Date('2026-08-17T12:05:00Z'));
    expect(calls).toBe(1);
    expect(result.deferred).toBe(3);
    const rows = t.sqlite.prepare(`select attempts, next_attempt_at, last_error from notification_outbox order by id`).all() as {
      attempts: number;
      next_attempt_at: string;
      last_error: string;
    }[];
    // Every row in the group shares the same next_attempt_at; only the attempted one
    // incremented its counter.
    expect(rows.map((r) => r.attempts)).toEqual([1, 0, 0, 0]);
    expect(new Set(rows.map((r) => r.next_attempt_at)).size).toBe(1);
    // The attempted row carries the real (scrubbed) transport error; the three skipped rows
    // carry the fixed DEFERRED_ERROR constant, never the propagated message (MUST-7.4).
    expect(rows[0]?.last_error).toBe('relay unreachable');
    expect(rows.slice(1).every((r) => r.last_error === DEFERRED_ERROR)).toBe(true);
  });

  it('MUST-7.7: a permanent failure flips to failed on the first attempt', async () => {
    const userId = configuredUser();
    removeTarget(userId, 'telegram');
    enqueue({ userId, eventId: 'coming_due', dedupKey: 'k', subject: 's', body: 'b', at: new Date('2026-08-17T12:00:00Z') });
    setNotifySenderForTests(async () => {
      throw new NotifyError('550 no such recipient', { permanent: true });
    });
    const result = await pumpOutbox(new Date('2026-08-17T12:05:00Z'));
    expect(result.failed).toBe(1);
    const row = t.sqlite.prepare(`select status, attempts, last_error from notification_outbox`).get() as {
      status: string;
      attempts: number;
      last_error: string;
    };
    expect(row.status).toBe('failed');
    expect(row.attempts).toBe(1);
    expect(row.last_error).toBe('550 no such recipient');
  });

  it('MUST-7.6: attempt 8 flips the row to failed', async () => {
    const userId = configuredUser();
    removeTarget(userId, 'telegram');
    enqueue({ userId, eventId: 'coming_due', dedupKey: 'k', subject: 's', body: 'b', at: new Date('2026-08-17T12:00:00Z') });
    setNotifySenderForTests(async () => {
      throw new NotifyError('temporary', { permanent: false });
    });
    let clock = new Date('2026-08-17T12:00:00Z').getTime();
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      await pumpOutbox(new Date(clock));
      clock += MAX_BACKOFF_MS;
    }
    const row = t.sqlite.prepare(`select status, attempts from notification_outbox`).get() as {
      status: string;
      attempts: number;
    };
    expect(row.attempts).toBe(MAX_ATTEMPTS);
    expect(row.status).toBe('failed');
  });

  it('honours a retryAfterMs from the transport over the computed backoff', async () => {
    const userId = configuredUser();
    removeTarget(userId, 'email');
    enqueue({ userId, eventId: 'coming_due', dedupKey: 'k', subject: 's', body: 'b', at: new Date('2026-08-17T12:00:00Z') });
    setNotifySenderForTests(async () => {
      throw new NotifyError('429 slow down', { permanent: false, retryAfterMs: 45_000 });
    });
    await pumpOutbox(new Date('2026-08-17T12:00:00Z'));
    const row = t.sqlite.prepare(`select next_attempt_at from notification_outbox`).get() as { next_attempt_at: string };
    expect(row.next_attempt_at).toBe('2026-08-17T12:00:45.000Z');
  });

  it('MUST-7.5: pre-send revalidation refuses a removed target and sends nothing', async () => {
    const userId = configuredUser();
    enqueue({ userId, eventId: 'coming_due', dedupKey: 'k', subject: 's', body: 'b', at: new Date('2026-08-17T12:00:00Z') });
    removeTarget(userId, 'telegram');
    const result = await pumpOutbox(new Date('2026-08-17T12:05:00Z'));
    expect(result.sent).toBe(1);
    expect(result.failed).toBe(1);
    expect(sent.map((r) => r.channel)).toEqual(['email']);
    const row = t.sqlite
      .prepare(`select status, last_error from notification_outbox where channel = 'telegram'`)
      .get() as { status: string; last_error: string };
    expect(row.status).toBe('failed');
    expect(row.last_error).toBe(CHANNEL_REMOVED_ERROR);
  });

  it('MUST-7.5: a disabled relay stops queued email rows too', async () => {
    const userId = configuredUser();
    removeTarget(userId, 'telegram');
    enqueue({ userId, eventId: 'coming_due', dedupKey: 'k', subject: 's', body: 'b', at: new Date('2026-08-17T12:00:00Z') });
    saveSmtp({
      preset: 'brevo',
      host: 'smtp-relay.brevo.com',
      port: 587,
      security: 'starttls',
      username: 'me@example.com',
      password: null,
      fromEmail: 'me@example.com',
      fromName: 'Budget Tracker',
      enabled: false,
    });
    await pumpOutbox(new Date('2026-08-17T12:05:00Z'));
    expect(sent).toHaveLength(0);
    const row = t.sqlite.prepare(`select status, last_error from notification_outbox`).get() as {
      status: string;
      last_error: string;
    };
    expect(row.status).toBe('failed');
    expect(row.last_error).toBe(CHANNEL_REMOVED_ERROR);
  });

  it('ignores rows whose next_attempt_at is in the future', async () => {
    const userId = configuredUser();
    removeTarget(userId, 'telegram');
    enqueue({ userId, eventId: 'coming_due', dedupKey: 'k', subject: 's', body: 'b', at: new Date('2026-08-17T13:00:00Z') });
    const result = await pumpOutbox(new Date('2026-08-17T12:00:00Z'));
    expect(result).toEqual({ sent: 0, failed: 0, deferred: 0 });
    expect(sent).toHaveLength(0);
  });

  it('MUST-7.10: outcomes land on the target row', async () => {
    const userId = configuredUser();
    removeTarget(userId, 'email');
    enqueue({ userId, eventId: 'coming_due', dedupKey: 'k1', subject: 's', body: 'b', at: new Date('2026-08-17T12:00:00Z') });
    setNotifySenderForTests(async () => {
      throw new NotifyError('chat not found', { permanent: true });
    });
    await pumpOutbox(new Date('2026-08-17T12:00:00Z'));
    expect(getTarget(userId, 'telegram')?.lastError).toBe('chat not found');
    setNotifySenderForTests(async (request) => {
      sent.push(request);
    });
    enqueue({ userId, eventId: 'coming_due', dedupKey: 'k2', subject: 's', body: 'b', at: new Date('2026-08-17T12:01:00Z') });
    await pumpOutbox(new Date('2026-08-17T12:01:00Z'));
    expect(getTarget(userId, 'telegram')?.lastError).toBeNull();
    expect(getTarget(userId, 'telegram')?.lastSuccessAt).toBe('2026-08-17T12:01:00.000Z');
  });

  it('MUST-7.10: an unreadable Telegram credential is recorded on the target row', async () => {
    const userId = configuredUser();
    removeTarget(userId, 'email');
    enqueue({ userId, eventId: 'coming_due', dedupKey: 'k', subject: 's', body: 'b', at: new Date('2026-08-17T12:00:00Z') });
    // Corrupts the stored ciphertext so decryptSecret() throws NotifyCredentialError, exactly
    // as a rotated SECRET_KEY or a tampered column would.
    t.sqlite.prepare(`update notification_targets set secret_encrypted = 'not-valid-ciphertext' where user_id = ? and channel = 'telegram'`).run(userId);
    const result = await pumpOutbox(new Date('2026-08-17T12:05:00Z'));
    expect(result.failed).toBe(1);
    expect(sent).toHaveLength(0);
    expect(getTarget(userId, 'telegram')?.lastError).toBe(CREDENTIAL_UNREADABLE);
    const row = t.sqlite.prepare(`select status, last_error from notification_outbox`).get() as {
      status: string;
      last_error: string;
    };
    expect(row.status).toBe('failed');
    expect(row.last_error).toBe(CREDENTIAL_UNREADABLE);
  });

  it('MUST-7.10: an unreadable SMTP credential is recorded on the relay row', async () => {
    const userId = configuredUser();
    removeTarget(userId, 'telegram');
    enqueue({ userId, eventId: 'coming_due', dedupKey: 'k', subject: 's', body: 'b', at: new Date('2026-08-17T12:00:00Z') });
    t.sqlite.prepare(`update notification_smtp set password_encrypted = 'not-valid-ciphertext' where id = 1`).run();
    const result = await pumpOutbox(new Date('2026-08-17T12:05:00Z'));
    expect(result.failed).toBe(1);
    expect(sent).toHaveLength(0);
    expect(getSmtp()?.lastError).toBe(CREDENTIAL_UNREADABLE);
  });

  it('MUST-6.3: an overlapping pump is a no-op rather than a double send', async () => {
    const userId = configuredUser();
    removeTarget(userId, 'telegram');
    enqueue({ userId, eventId: 'coming_due', dedupKey: 'k', subject: 's', body: 'b', at: new Date('2026-08-17T12:00:00Z') });
    // A holder object, not a bare `let`: TypeScript narrows a `let` assigned only inside a
    // callback to `never` at the later call site and refuses to invoke it.
    const gate: { release: (() => void) | undefined } = { release: undefined };
    setNotifySenderForTests(
      (request) =>
        new Promise<void>((resolve) => {
          sent.push(request);
          gate.release = resolve;
        }),
    );
    const first = pumpOutbox(new Date('2026-08-17T12:00:00Z'));
    const second = await pumpOutbox(new Date('2026-08-17T12:00:00Z'));
    expect(second).toEqual({ sent: 0, failed: 0, deferred: 0 });
    gate.release?.();
    await first;
    await drainOutboxForTests();
    expect(sent).toHaveLength(1);
  });
});

describe('MUST-7.8: boot expiry', () => {
  it('fails a 25-hour-old pending row and leaves a 23-hour-old one alone', () => {
    const userId = configuredUser();
    removeTarget(userId, 'telegram');
    enqueue({ userId, eventId: 'coming_due', dedupKey: 'old', subject: 's', body: 'b', at: new Date('2026-08-16T11:00:00Z') });
    enqueue({ userId, eventId: 'coming_due', dedupKey: 'new', subject: 's', body: 'b', at: new Date('2026-08-16T13:00:00Z') });
    const expired = expireStalePending(new Date('2026-08-17T12:00:00Z'));
    expect(expired).toBe(1);
    const rows = t.sqlite
      .prepare(`select dedup_key, status, last_error from notification_outbox order by dedup_key`)
      .all() as { dedup_key: string; status: string; last_error: string | null }[];
    expect(rows).toEqual([
      { dedup_key: 'new', status: 'pending', last_error: null },
      { dedup_key: 'old', status: 'failed', last_error: PENDING_EXPIRED_ERROR },
    ]);
  });
});

describe('MUST-3.14: retention', () => {
  it('purges sent and failed rows older than 400 days and keeps pending ones', () => {
    const userId = configuredUser();
    removeTarget(userId, 'telegram');
    enqueue({ userId, eventId: 'coming_due', dedupKey: 'a', subject: 's', body: 'b', at: new Date('2025-01-01T00:00:00Z') });
    enqueue({ userId, eventId: 'coming_due', dedupKey: 'b', subject: 's', body: 'b', at: new Date('2025-01-01T00:00:00Z') });
    enqueue({ userId, eventId: 'coming_due', dedupKey: 'c', subject: 's', body: 'b', at: new Date('2026-08-17T00:00:00Z') });
    t.db.run(sql`update notification_outbox set status = 'sent' where dedup_key = 'a'`);
    t.db.run(sql`update notification_outbox set status = 'failed' where dedup_key = 'b'`);
    const purged = purgeOldOutboxRows(new Date('2026-08-17T12:00:00Z'));
    expect(purged).toBe(2);
    const remaining = t.sqlite.prepare(`select dedup_key from notification_outbox`).all() as { dedup_key: string }[];
    expect(remaining.map((r) => r.dedup_key)).toEqual(['c']);
  });

  it('MUST-3.12/R3: keeps a 399-day-old sent row and purges a 401-day-old one', () => {
    expect(OUTBOX_RETENTION_DAYS).toBe(400);
    const userId = configuredUser();
    removeTarget(userId, 'telegram');
    const at = new Date('2026-08-17T12:00:00Z');
    const day = 24 * 60 * 60 * 1000;
    enqueue({ userId, eventId: 'coming_due', dedupKey: '399-old', subject: 's', body: 'b', at: new Date(at.getTime() - 399 * day) });
    enqueue({ userId, eventId: 'coming_due', dedupKey: '401-old', subject: 's', body: 'b', at: new Date(at.getTime() - 401 * day) });
    t.db.run(sql`update notification_outbox set status = 'sent' where dedup_key in ('399-old', '401-old')`);
    const purged = purgeOldOutboxRows(at);
    expect(purged).toBe(1);
    const remaining = t.sqlite.prepare(`select dedup_key from notification_outbox`).all() as { dedup_key: string }[];
    expect(remaining.map((r) => r.dedup_key)).toEqual(['399-old']);
  });
});

describe('§11.6: recent deliveries', () => {
  it('returns the newest rows for one user, and household-wide for a null userId', async () => {
    const a = configuredUser();
    const b = insertTestUser(t.db, { username: 'second' });
    saveEmailTarget({ userId: b, destination: 'b@example.com', enabled: true });
    enqueue({ userId: a, eventId: 'coming_due', dedupKey: 'a', subject: 'A', body: 'b' });
    enqueue({ userId: b, eventId: 'coming_due', dedupKey: 'b', subject: 'B', body: 'b' });
    expect(listRecentDeliveries({ userId: a }).map((r) => r.subject)).toEqual(['A', 'A']);
    expect(listRecentDeliveries({ userId: null }).map((r) => r.subject).sort()).toEqual(['A', 'A', 'B']);
    expect(listRecentDeliveries({ userId: null, limit: 1 })).toHaveLength(1);
  });
});

describe('MUST-7.11: logging never contains a subject or a body', () => {
  it('logs one summary line per non-empty run and nothing more', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const userId = configuredUser();
    enqueue({ userId, eventId: 'coming_due', dedupKey: 'k', subject: 'SECRET SUBJECT', body: 'SECRET BODY', at: new Date('2026-08-17T12:00:00Z') });
    await pumpOutbox(new Date('2026-08-17T12:00:00Z'));
    const lines = log.mock.calls.map((call) => call.join(' '));
    expect(lines.some((line) => line.startsWith('[notify] sent 2'))).toBe(true);
    expect(lines.join('\n')).not.toContain('SECRET SUBJECT');
    expect(lines.join('\n')).not.toContain('SECRET BODY');
    log.mockRestore();
  });

  it('logs nothing for an empty run', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await pumpOutbox(new Date('2026-08-17T12:00:00Z'));
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });
});

import { and, asc, desc, eq, inArray, lt, lte, sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { notificationOutbox } from '@/db/schema';
import { nowIso } from '@/lib/clock';
import {
  getSmtp,
  getSmtpPassword,
  getTarget,
  getTelegramToken,
  isEventEnabled,
  recordSmtpOutcome,
  recordTargetOutcome,
} from '@/lib/notify/config';
import { CREDENTIAL_UNREADABLE, NotifyCredentialError, authPlainBase64, scrubSecrets } from '@/lib/notify/crypto';
import { CHANNELS, type Channel } from '@/lib/notify/events';
import { NotifyError, deliver, type DeliveryRequest } from '@/lib/notify/send';

/** §19.16: the numbers, in one place. */
export const OUTBOX_BATCH = 50;
export const MAX_ATTEMPTS = 8;
export const MAX_BACKOFF_MS = 6 * 60 * 60 * 1000;
export const PENDING_MAX_AGE_HOURS = 24;
/**
 * MUST-3.14/R3: must exceed the maximum `comingDueDays` window (365, the top of the 1-365
 * range in notification_user_settings) with margin. A shorter retention would let the sweep
 * delete a 'sent' coming_due row while the item is still inside the user's lookahead window,
 * resurrecting its dedup key and re-alerting on the same item every retention period.
 */
export const OUTBOX_RETENTION_DAYS = 400;

export const CHANNEL_REMOVED_ERROR = 'Channel was removed before delivery.';
export const PENDING_EXPIRED_ERROR = 'Not delivered within 24 hours.';
/** MUST-7.4: written on every row a broken channel group skips without attempting. */
export const DEFERRED_ERROR = 'Deferred: an earlier send this pass failed for this channel.';

/** MUST-7.6: 2, 4, 8, 16, 32, 64, 128, 256 minutes, capped at six hours. */
export function backoffMs(attempts: number): number {
  return Math.min(2 ** attempts * 60_000, MAX_BACKOFF_MS);
}

/**
 * MUST-7.1: resolves the user's enabled channels for the event via isEventEnabled() and
 * inserts ONE ROW PER CHANNEL, each with ON CONFLICT DO NOTHING. Enqueueing is the only
 * place channel fan-out happens, so per-channel isolation is structural: two rows, two
 * independent lifecycles.
 *
 * MUST-7.2: subject and body are rendered by the CALLER, at evaluation time. Re-rendering
 * at send time after three retries would produce a "budget at 82%" alert that says 91%.
 */
export function enqueue(input: {
  userId: number;
  eventId: string;
  dedupKey: string;
  subject: string;
  body: string;
  at?: Date;
}): { inserted: Channel[] } {
  const db = getDb();
  const at = nowIso(input.at ?? new Date());
  const inserted: Channel[] = [];

  for (const channel of CHANNELS) {
    if (!isEventEnabled(input.userId, input.eventId, channel)) continue;
    // MUST-3.9: the row that was sent IS the dedup guard. `changes === 0` means
    // "already fired": there is no separate bookkeeping that could drift.
    const result = db
      .insert(notificationOutbox)
      .values({
        userId: input.userId,
        channel,
        eventId: input.eventId,
        dedupKey: input.dedupKey,
        subject: input.subject,
        body: input.body,
        status: 'pending',
        attempts: 0,
        nextAttemptAt: at,
        createdAt: at,
      })
      .onConflictDoNothing()
      .run();
    if (result.changes > 0) inserted.push(channel);
  }

  return { inserted };
}

/** MUST-6.4: the other half of the dormancy bail. */
export function countPendingOutbox(): number {
  const row = getDb()
    .select({ n: sql<number>`count(*)` })
    .from(notificationOutbox)
    .where(eq(notificationOutbox.status, 'pending'))
    .get();
  return row?.n ?? 0;
}

/**
 * MUST-7.8: on the first tick after boot, every pending row older than 24 hours is
 * abandoned. This covers a container that was off for a week, and also a RESTORED OLDER
 * DATABASE whose outbox still holds rows that were pending when the backup was taken;
 * without it a restore would emit a flood of stale alerts about a world that no longer
 * exists.
 */
export function expireStalePending(now: Date = new Date()): number {
  const cutoff = nowIso(new Date(now.getTime() - PENDING_MAX_AGE_HOURS * 60 * 60 * 1000));
  const result = getDb()
    .update(notificationOutbox)
    .set({ status: 'failed', lastError: PENDING_EXPIRED_ERROR })
    .where(and(eq(notificationOutbox.status, 'pending'), lt(notificationOutbox.createdAt, cutoff)))
    .run();
  return result.changes;
}

/** MUST-3.14: the sixth purge in runMaintenanceSweep(). */
export function purgeOldOutboxRows(at: Date = new Date()): number {
  const cutoff = nowIso(new Date(at.getTime() - OUTBOX_RETENTION_DAYS * 24 * 60 * 60 * 1000));
  const result = getDb()
    .delete(notificationOutbox)
    .where(and(inArray(notificationOutbox.status, ['sent', 'failed']), lt(notificationOutbox.createdAt, cutoff)))
    .run();
  return result.changes;
}

export interface DeliveryRow {
  id: number;
  userId: number;
  channel: Channel;
  eventId: string;
  subject: string;
  status: 'pending' | 'sent' | 'failed';
  attempts: number;
  lastError: string | null;
  createdAt: string;
  sentAt: string | null;
}

/** §11.6: served by notification_outbox_user_idx. `userId: null` is the admin's view. */
export function listRecentDeliveries(input: { userId: number | null; limit?: number }): DeliveryRow[] {
  const limit = input.limit ?? 20;
  const base = getDb()
    .select({
      id: notificationOutbox.id,
      userId: notificationOutbox.userId,
      channel: notificationOutbox.channel,
      eventId: notificationOutbox.eventId,
      subject: notificationOutbox.subject,
      status: notificationOutbox.status,
      attempts: notificationOutbox.attempts,
      lastError: notificationOutbox.lastError,
      createdAt: notificationOutbox.createdAt,
      sentAt: notificationOutbox.sentAt,
    })
    .from(notificationOutbox);
  const rows =
    input.userId === null
      ? base.orderBy(desc(notificationOutbox.id)).limit(limit).all()
      : base.where(eq(notificationOutbox.userId, input.userId)).orderBy(desc(notificationOutbox.id)).limit(limit).all();
  return rows;
}

type PendingRow = {
  id: number;
  userId: number;
  channel: Channel;
  subject: string;
  body: string;
  attempts: number;
};

/**
 * MUST-7.5: pre-send revalidation. Re-reads the row's target immediately before sending.
 * If the target is gone or disabled, or (for email) the relay is gone or disabled, NOTHING
 * IS SENT. Removing a channel therefore stops egress at once, including for rows already
 * in the queue: the dormancy rule holds even with a full outbox.
 *
 * Returns the request to send, or null with the reason the row is dead.
 */
function buildRequest(row: PendingRow): { request: DeliveryRequest } | { dead: string } {
  const target = getTarget(row.userId, row.channel);
  if (!target || !target.enabled) return { dead: CHANNEL_REMOVED_ERROR };

  if (row.channel === 'telegram') {
    let botToken: string;
    try {
      botToken = getTelegramToken(row.userId);
    } catch (error) {
      if (error instanceof NotifyCredentialError) return { dead: error.message };
      throw error;
    }
    return {
      request: { channel: 'telegram', destination: target.destination, botToken, subject: row.subject, body: row.body },
    };
  }

  // NOT the same as the re-read removed from runTest in v1.3.1 (spec MUST-17.7/17.8). THIS one
  // is live and mandated by MUST-7.5's pre-send revalidation: enqueue and pump are separated in
  // time -- minutes, or hours across a retry ladder -- so the relay genuinely can be changed or
  // removed in between. Do not "simplify" it by analogy with runTest's.
  const relay = getSmtp();
  if (!relay || !relay.enabled) return { dead: CHANNEL_REMOVED_ERROR };
  let password: string;
  try {
    password = getSmtpPassword();
  } catch (error) {
    if (error instanceof NotifyCredentialError) return { dead: error.message };
    throw error;
  }
  return {
    request: {
      channel: 'email',
      destination: target.destination,
      smtp: {
        host: relay.host,
        port: relay.port,
        security: relay.security,
        username: relay.username,
        password,
        fromEmail: relay.fromEmail,
        fromName: relay.fromName,
      },
      subject: row.subject,
      body: row.body,
    },
  };
}

/** MUST-5.5: everything written to last_error goes through here first. */
function scrubForRow(message: string, request: DeliveryRequest | null): string {
  if (!request) return message;
  const secrets =
    request.channel === 'telegram'
      ? [request.botToken]
      : [request.smtp.password, authPlainBase64(request.smtp.username, request.smtp.password)];
  return scrubSecrets(message, secrets);
}

function markSent(id: number, attempts: number, at: string): void {
  getDb()
    .update(notificationOutbox)
    .set({ status: 'sent', attempts, sentAt: at, lastError: null })
    .where(eq(notificationOutbox.id, id))
    .run();
}

function markFailed(id: number, attempts: number, message: string): void {
  getDb()
    .update(notificationOutbox)
    .set({ status: 'failed', attempts, lastError: message })
    .where(eq(notificationOutbox.id, id))
    .run();
}

function markRetry(id: number, attempts: number, message: string, nextAt: string): void {
  getDb()
    .update(notificationOutbox)
    .set({ attempts, lastError: message, nextAttemptAt: nextAt })
    .where(eq(notificationOutbox.id, id))
    .run();
}

function deferRow(id: number, nextAt: string): void {
  getDb()
    .update(notificationOutbox)
    .set({ nextAttemptAt: nextAt, lastError: DEFERRED_ERROR })
    .where(eq(notificationOutbox.id, id))
    .run();
}

/**
 * MUST-6.3: single-flight, the pump: Promise<void> | null pattern of
 * src/lib/warranty/ocr/queue.ts, verbatim. A tick that arrives while the previous one is
 * still draining returns immediately.
 */
let pump: Promise<{ sent: number; failed: number; deferred: number }> | null = null;

export function resetOutboxPumpForTests(): void {
  pump = null;
}

export async function drainOutboxForTests(): Promise<void> {
  while (pump !== null) {
    await pump;
  }
}

export function pumpOutbox(now: Date = new Date()): Promise<{ sent: number; failed: number; deferred: number }> {
  if (pump !== null) return Promise.resolve({ sent: 0, failed: 0, deferred: 0 });
  const run = drain(now).finally(() => {
    pump = null;
  });
  pump = run;
  return run;
}

/** Fire-and-forget kick used by the immediate raisers (§6.6) and the server actions. */
export function kickOutbox(now?: Date): void {
  void pumpOutbox(now).catch((error) => {
    console.error('[notify] outbox pump failed', error);
  });
}

async function drain(now: Date): Promise<{ sent: number; failed: number; deferred: number }> {
  const at = nowIso(now);
  // MUST-7.3: served by notification_outbox_due_idx.
  const rows = getDb()
    .select({
      id: notificationOutbox.id,
      userId: notificationOutbox.userId,
      channel: notificationOutbox.channel,
      subject: notificationOutbox.subject,
      body: notificationOutbox.body,
      attempts: notificationOutbox.attempts,
    })
    .from(notificationOutbox)
    .where(and(eq(notificationOutbox.status, 'pending'), lte(notificationOutbox.nextAttemptAt, at)))
    .orderBy(asc(notificationOutbox.id))
    .limit(OUTBOX_BATCH)
    .all();

  let sent = 0;
  let failed = 0;
  let deferred = 0;

  // MUST-7.3: grouped by channel, each group inside its own try/catch. A Telegram group
  // that throws at the transport level cannot touch a single email row, and vice versa.
  for (const channel of CHANNELS) {
    const group = rows.filter((row) => row.channel === channel);
    if (group.length === 0) continue;

    try {
      let broken: string | null = null;
      let brokenNextAt = at;

      for (const row of group) {
        if (broken !== null) {
          // MUST-7.4: the per-channel circuit break. Every remaining row is deferred to
          // the same next_attempt_at WITHOUT being attempted, so a dead relay cannot cost
          // 50 × 15 s of connect timeouts inside one tick.
          deferRow(row.id, brokenNextAt);
          deferred += 1;
          continue;
        }

        const built = buildRequest(row);
        if ('dead' in built) {
          // MUST-7.10: an unreadable credential (a rotated SECRET_KEY, a tampered ciphertext)
          // is still an outcome worth surfacing in Settings, unlike CHANNEL_REMOVED_ERROR
          // where the target/relay row is simply gone and there is nothing left to record it
          // on.
          if (built.dead === CREDENTIAL_UNREADABLE) {
            if (channel === 'telegram') {
              recordTargetOutcome({ userId: row.userId, channel, ok: false, error: CREDENTIAL_UNREADABLE, at: now });
            } else {
              recordSmtpOutcome({ ok: false, error: CREDENTIAL_UNREADABLE, at: now });
            }
          }
          markFailed(row.id, row.attempts, built.dead);
          failed += 1;
          continue;
        }

        const attempts = row.attempts + 1;
        try {
          await deliver(built.request);
          markSent(row.id, attempts, at);
          recordTargetOutcome({ userId: row.userId, channel, ok: true, at: now });
          if (channel === 'email') recordSmtpOutcome({ ok: true, at: now });
          sent += 1;
        } catch (error) {
          const notifyError =
            error instanceof NotifyError
              ? error
              : new NotifyError(error instanceof Error ? error.message : 'Send failed.', { permanent: false });
          const message = scrubForRow(notifyError.message, built.request);

          if (notifyError.scope === 'relay') recordSmtpOutcome({ ok: false, error: message, at: now });
          else recordTargetOutcome({ userId: row.userId, channel, ok: false, error: message, at: now });

          if (notifyError.permanent) {
            // MUST-7.7: skip backoff entirely and fail on the first attempt.
            markFailed(row.id, attempts, message);
            failed += 1;
            console.error(`[notify] permanent ${channel} failure on row ${row.id}: ${message}`);
            continue;
          }

          const waitMs = notifyError.retryAfterMs ?? backoffMs(attempts);
          const nextAt = nowIso(new Date(now.getTime() + waitMs));
          if (attempts >= MAX_ATTEMPTS) {
            markFailed(row.id, attempts, message);
            failed += 1;
          } else {
            markRetry(row.id, attempts, message, nextAt);
          }
          broken = message;
          brokenNextAt = nextAt;
        }
      }
    } catch (error) {
      // A genuine bug in the group loop must not stop the other channel.
      console.error(`[notify] ${channel} group aborted`, error);
    }
  }

  // MUST-7.11: one summary line per NON-EMPTY run. Never a subject, never a body, never a
  // credential.
  if (sent + failed + deferred > 0) console.log(`[notify] sent ${sent}, failed ${failed}, deferred ${deferred}`);
  return { sent, failed, deferred };
}

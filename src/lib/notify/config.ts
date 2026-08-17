import { and, asc, eq } from 'drizzle-orm';
import { getDb } from '@/db/client';
import {
  notificationPrefs,
  notificationSmtp,
  notificationTargets,
  notificationUserSettings,
  users,
} from '@/db/schema';
import { nowIso } from '@/lib/clock';
import { SMTP_HKDF_INFO, TELEGRAM_HKDF_INFO, decryptSecret, encryptSecret } from '@/lib/notify/crypto';
import { eventDef, type Channel } from '@/lib/notify/events';

export type SmtpPreset = 'brevo' | 'smtp2go' | 'gmail' | 'custom';
export type SmtpSecurity = 'tls' | 'starttls' | 'none';

export interface SmtpPresetDefaults {
  host: string;
  port: number;
  security: SmtpSecurity;
}

/**
 * MUST-8.15: the picker prefills host / port / security and swaps the guide panel
 * (§11.7.2). Every field stays editable afterwards; `preset` is stored so the right guide
 * is shown and NEVER changes connection behaviour.
 */
export const SMTP_PRESETS: Record<SmtpPreset, SmtpPresetDefaults> = {
  brevo: { host: 'smtp-relay.brevo.com', port: 587, security: 'starttls' },
  smtp2go: { host: 'mail.smtp2go.com', port: 587, security: 'starttls' },
  gmail: { host: 'smtp.gmail.com', port: 465, security: 'tls' },
  custom: { host: '', port: 587, security: 'starttls' },
};

export interface SmtpRecord {
  preset: SmtpPreset;
  host: string;
  port: number;
  security: SmtpSecurity;
  username: string;
  fromEmail: string;
  fromName: string;
  enabled: boolean;
  /** MUST-5.3: the page learns THAT a password exists, never what it is. */
  passwordSet: boolean;
  lastError: string | null;
  lastErrorAt: string | null;
  lastSuccessAt: string | null;
}

export function getSmtp(): SmtpRecord | null {
  const row = getDb().select().from(notificationSmtp).where(eq(notificationSmtp.id, 1)).get();
  if (!row) return null;
  return {
    preset: row.preset,
    host: row.host,
    port: row.port,
    security: row.security,
    username: row.username,
    fromEmail: row.fromEmail,
    fromName: row.fromName,
    enabled: row.enabled,
    passwordSet: row.passwordEncrypted.length > 0,
    lastError: row.lastError,
    lastErrorAt: row.lastErrorAt,
    lastSuccessAt: row.lastSuccessAt,
  };
}

/** Server-side only. Throws NotifyCredentialError when the stored value is unreadable. */
export function getSmtpPassword(): string {
  const row = getDb()
    .select({ payload: notificationSmtp.passwordEncrypted })
    .from(notificationSmtp)
    .where(eq(notificationSmtp.id, 1))
    .get();
  if (!row) throw new Error('no SMTP relay is configured');
  return decryptSecret(row.payload, SMTP_HKDF_INFO);
}

/**
 * MUST-5.6: `password: null` means "keep what is stored". Creating a row with a null
 * password is a validation error the action layer refuses before reaching here; this
 * function throws rather than writing an empty credential.
 */
export function saveSmtp(input: {
  preset: SmtpPreset;
  host: string;
  port: number;
  security: SmtpSecurity;
  username: string;
  password: string | null;
  fromEmail: string;
  fromName: string;
  enabled: boolean;
  at?: Date;
}): void {
  const db = getDb();
  const at = nowIso(input.at ?? new Date());
  const existing = db
    .select({ payload: notificationSmtp.passwordEncrypted, createdAt: notificationSmtp.createdAt })
    .from(notificationSmtp)
    .where(eq(notificationSmtp.id, 1))
    .get();

  let payload: string;
  if (input.password !== null && input.password.length > 0) {
    payload = encryptSecret(input.password, SMTP_HKDF_INFO);
  } else if (existing) {
    payload = existing.payload;
  } else {
    throw new Error('a password is required when creating the relay');
  }

  const values = {
    id: 1 as const,
    preset: input.preset,
    host: input.host,
    port: input.port,
    security: input.security,
    username: input.username,
    passwordEncrypted: payload,
    fromEmail: input.fromEmail,
    fromName: input.fromName,
    enabled: input.enabled,
    createdAt: existing?.createdAt ?? at,
    updatedAt: at,
  };

  db.insert(notificationSmtp)
    .values(values)
    .onConflictDoUpdate({ target: notificationSmtp.id, set: { ...values, createdAt: undefined } })
    .run();
}

export function removeSmtp(): void {
  getDb().delete(notificationSmtp).where(eq(notificationSmtp.id, 1)).run();
}

/**
 * MUST-7.10: success clears last_error and sets last_success_at; failure sets the
 * (already scrubbed) last_error and last_error_at. Settings renders both, so "email
 * stopped working three weeks ago" is visible on the page rather than only in docker logs.
 */
export function recordSmtpOutcome(input: { ok: boolean; error?: string; at?: Date }): void {
  const at = nowIso(input.at ?? new Date());
  getDb()
    .update(notificationSmtp)
    .set(
      input.ok
        ? { lastError: null, lastErrorAt: null, lastSuccessAt: at, updatedAt: at }
        : { lastError: input.error ?? 'Send failed.', lastErrorAt: at, updatedAt: at },
    )
    .where(eq(notificationSmtp.id, 1))
    .run();
}

export interface TargetRecord {
  id: number;
  userId: number;
  channel: Channel;
  destination: string;
  /** MUST-5.3: never the token itself. */
  secretSet: boolean;
  enabled: boolean;
  verifiedAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  lastSuccessAt: string | null;
}

function toTargetRecord(row: typeof notificationTargets.$inferSelect): TargetRecord {
  return {
    id: row.id,
    userId: row.userId,
    channel: row.channel,
    destination: row.destination,
    secretSet: (row.secretEncrypted ?? '').length > 0,
    enabled: row.enabled,
    verifiedAt: row.verifiedAt,
    lastError: row.lastError,
    lastErrorAt: row.lastErrorAt,
    lastSuccessAt: row.lastSuccessAt,
  };
}

export function getTarget(userId: number, channel: Channel): TargetRecord | null {
  const row = getDb()
    .select()
    .from(notificationTargets)
    .where(and(eq(notificationTargets.userId, userId), eq(notificationTargets.channel, channel)))
    .get();
  return row ? toTargetRecord(row) : null;
}

export function listTargets(userId: number): TargetRecord[] {
  return getDb()
    .select()
    .from(notificationTargets)
    .where(eq(notificationTargets.userId, userId))
    .orderBy(asc(notificationTargets.channel))
    .all()
    .map(toTargetRecord);
}

/** MUST-3.5 / MUST-8.9: each user's OWN token, decrypted server-side, never a parameter. */
export function getTelegramToken(userId: number): string {
  const row = getDb()
    .select({ payload: notificationTargets.secretEncrypted })
    .from(notificationTargets)
    .where(and(eq(notificationTargets.userId, userId), eq(notificationTargets.channel, 'telegram')))
    .get();
  if (!row || row.payload === null) throw new Error('no Telegram token is stored for this user');
  return decryptSecret(row.payload, TELEGRAM_HKDF_INFO);
}

function upsertTarget(input: {
  userId: number;
  channel: Channel;
  destination: string;
  secretEncrypted: string | null;
  enabled: boolean;
  at: string;
  /** A changed destination invalidates a previous verification. */
  resetVerified: boolean;
}): void {
  const db = getDb();
  const existing = db
    .select({ id: notificationTargets.id, createdAt: notificationTargets.createdAt })
    .from(notificationTargets)
    .where(and(eq(notificationTargets.userId, input.userId), eq(notificationTargets.channel, input.channel)))
    .get();

  if (existing) {
    db.update(notificationTargets)
      .set({
        destination: input.destination,
        secretEncrypted: input.secretEncrypted,
        enabled: input.enabled,
        updatedAt: input.at,
        ...(input.resetVerified ? { verifiedAt: null } : {}),
      })
      .where(eq(notificationTargets.id, existing.id))
      .run();
    return;
  }

  db.insert(notificationTargets)
    .values({
      userId: input.userId,
      channel: input.channel,
      destination: input.destination,
      secretEncrypted: input.secretEncrypted,
      enabled: input.enabled,
      createdAt: input.at,
      updatedAt: input.at,
    })
    .run();
}

export function saveTelegramTarget(input: {
  userId: number;
  destination: string;
  /** MUST-5.6: null means "keep the stored token". */
  botToken: string | null;
  enabled: boolean;
  at?: Date;
}): void {
  const at = nowIso(input.at ?? new Date());
  const existing = getDb()
    .select({ payload: notificationTargets.secretEncrypted, destination: notificationTargets.destination })
    .from(notificationTargets)
    .where(and(eq(notificationTargets.userId, input.userId), eq(notificationTargets.channel, 'telegram')))
    .get();

  const payload =
    input.botToken !== null && input.botToken.length > 0
      ? encryptSecret(input.botToken, TELEGRAM_HKDF_INFO)
      : (existing?.payload ?? null);

  upsertTarget({
    userId: input.userId,
    channel: 'telegram',
    destination: input.destination,
    secretEncrypted: payload,
    enabled: input.enabled,
    at,
    resetVerified: existing?.destination !== input.destination || (input.botToken?.length ?? 0) > 0,
  });
}

export function saveEmailTarget(input: { userId: number; destination: string; enabled: boolean; at?: Date }): void {
  const at = nowIso(input.at ?? new Date());
  const existing = getDb()
    .select({ destination: notificationTargets.destination })
    .from(notificationTargets)
    .where(and(eq(notificationTargets.userId, input.userId), eq(notificationTargets.channel, 'email')))
    .get();

  upsertTarget({
    userId: input.userId,
    channel: 'email',
    destination: input.destination,
    // The SQL pairing CHECK requires NULL here for email (§3.3).
    secretEncrypted: null,
    enabled: input.enabled,
    at,
    resetVerified: existing?.destination !== input.destination,
  });
}

export function removeTarget(userId: number, channel: Channel): void {
  getDb()
    .delete(notificationTargets)
    .where(and(eq(notificationTargets.userId, userId), eq(notificationTargets.channel, channel)))
    .run();
}

/** MUST-12.7: only a SUCCESSFUL test sets verified_at, and only when `verify` is set. */
export function recordTargetOutcome(input: {
  userId: number;
  channel: Channel;
  ok: boolean;
  error?: string;
  verify?: boolean;
  at?: Date;
}): void {
  const at = nowIso(input.at ?? new Date());
  getDb()
    .update(notificationTargets)
    .set(
      input.ok
        ? {
            lastError: null,
            lastErrorAt: null,
            lastSuccessAt: at,
            updatedAt: at,
            ...(input.verify ? { verifiedAt: at } : {}),
          }
        : { lastError: input.error ?? 'Send failed.', lastErrorAt: at, updatedAt: at },
    )
    .where(and(eq(notificationTargets.userId, input.userId), eq(notificationTargets.channel, input.channel)))
    .run();
}

/** MUST-6.4: half of the dormancy bail. One indexed read against an empty table. */
export function hasAnyEnabledTarget(): boolean {
  const row = getDb()
    .select({ id: notificationTargets.id })
    .from(notificationTargets)
    .where(eq(notificationTargets.enabled, true))
    .limit(1)
    .get();
  return row !== undefined;
}

export interface UserSettings {
  comingDueDays: number;
  budgetThresholdPct: number;
  staleImportWeeks: number;
  dailyHour: number;
  digestWeekday: number;
  digestHour: number;
}

/** §3.5: an ABSENT row means every default applies. Nothing seeds this table. */
export const DEFAULT_USER_SETTINGS: UserSettings = {
  comingDueDays: 14,
  budgetThresholdPct: 80,
  staleImportWeeks: 3,
  dailyHour: 8,
  digestWeekday: 1,
  digestHour: 8,
};

export function getUserSettings(userId: number): UserSettings {
  const row = getDb()
    .select()
    .from(notificationUserSettings)
    .where(eq(notificationUserSettings.userId, userId))
    .get();
  if (!row) return { ...DEFAULT_USER_SETTINGS };
  return {
    comingDueDays: row.comingDueDays,
    budgetThresholdPct: row.budgetThresholdPct,
    staleImportWeeks: row.staleImportWeeks,
    dailyHour: row.dailyHour,
    digestWeekday: row.digestWeekday,
    digestHour: row.digestHour,
  };
}

export function saveUserSettings(userId: number, next: UserSettings, at?: Date): void {
  const stamp = nowIso(at ?? new Date());
  getDb()
    .insert(notificationUserSettings)
    .values({ userId, ...next, createdAt: stamp, updatedAt: stamp })
    .onConflictDoUpdate({
      target: notificationUserSettings.userId,
      set: { ...next, updatedAt: stamp },
    })
    .run();
}

function prefKey(eventId: string, channel: Channel): string {
  return `${eventId}:${channel}`;
}

export function getPrefs(userId: number): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const row of getDb().select().from(notificationPrefs).where(eq(notificationPrefs.userId, userId)).all()) {
    out[prefKey(row.eventId, row.channel)] = row.enabled;
  }
  return out;
}

export function setPref(userId: number, eventId: string, channel: Channel, enabled: boolean): void {
  getDb()
    .insert(notificationPrefs)
    .values({ userId, eventId, channel, enabled })
    .onConflictDoUpdate({
      target: [notificationPrefs.userId, notificationPrefs.eventId, notificationPrefs.channel],
      set: { enabled },
    })
    .run();
}

export function clearPref(userId: number, eventId: string, channel: Channel): void {
  getDb()
    .delete(notificationPrefs)
    .where(
      and(
        eq(notificationPrefs.userId, userId),
        eq(notificationPrefs.eventId, eventId),
        eq(notificationPrefs.channel, channel),
      ),
    )
    .run();
}

/**
 * MUST-3.7 (sparse storage) — a row exists ONLY where a user has actively changed a
 * toggle. Saving a value that equals the registry default deletes the row instead of
 * storing a redundant one, so a later change to a default propagates to everyone who never
 * expressed an opinion. An unknown event id is ignored entirely (MUST-3.6): the stored row
 * a downgrade left behind is neither read nor deleted.
 */
export function applyPref(userId: number, eventId: string, channel: Channel, enabled: boolean): void {
  const def = eventDef(eventId);
  if (!def) return;
  if (enabled === def.defaultEnabled) clearPref(userId, eventId, channel);
  else setPref(userId, eventId, channel, enabled);
}

/** MUST-3.7: `row?.enabled ?? registryDefault(event_id)`; unknown ids resolve to false. */
export function effectivePref(userId: number, eventId: string, channel: Channel): boolean {
  const def = eventDef(eventId);
  if (!def) return false;
  const row = getDb()
    .select({ enabled: notificationPrefs.enabled })
    .from(notificationPrefs)
    .where(
      and(
        eq(notificationPrefs.userId, userId),
        eq(notificationPrefs.eventId, eventId),
        eq(notificationPrefs.channel, channel),
      ),
    )
    .get();
  return row?.enabled ?? def.defaultEnabled;
}

/**
 * §4.3 — all five conditions, in this order, in ONE function. No caller re-implements any
 * part of it:
 *   1. the effective toggle (MUST-3.7),
 *   2. the user is active (MUST-14.6),
 *   3. the user's role satisfies the event's audience (MUST-4.3 / MUST-14.7),
 *   4. an ENABLED notification_targets row exists for (userId, channel) — MUST-4.2,
 *   5. for channel 'email', an ENABLED notification_smtp row exists.
 */
export function isEventEnabled(userId: number, eventId: string, channel: Channel): boolean {
  const def = eventDef(eventId);
  if (!def) return false;
  if (!effectivePref(userId, eventId, channel)) return false;

  const user = getDb()
    .select({ role: users.role, isActive: users.isActive })
    .from(users)
    .where(eq(users.id, userId))
    .get();
  if (!user || !user.isActive) return false;
  if (def.audience === 'admin' && user.role !== 'admin') return false;

  const target = getDb()
    .select({ enabled: notificationTargets.enabled })
    .from(notificationTargets)
    .where(and(eq(notificationTargets.userId, userId), eq(notificationTargets.channel, channel)))
    .get();
  if (!target || !target.enabled) return false;

  if (channel === 'email') {
    const relay = getDb()
      .select({ enabled: notificationSmtp.enabled })
      .from(notificationSmtp)
      .where(eq(notificationSmtp.id, 1))
      .get();
    if (!relay || !relay.enabled) return false;
  }

  return true;
}

export interface NotifiableUser {
  id: number;
  name: string;
  role: 'admin' | 'member';
}

/** MUST-14.6: evaluation skips deactivated members without deleting their configuration. */
export function notifiableUsers(): NotifiableUser[] {
  return getDb()
    .select({ id: users.id, name: users.name, role: users.role })
    .from(users)
    .where(eq(users.isActive, true))
    .orderBy(asc(users.id))
    .all();
}

export function adminUserIds(): number[] {
  return getDb()
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.isActive, true), eq(users.role, 'admin')))
    .orderBy(asc(users.id))
    .all()
    .map((row) => row.id);
}

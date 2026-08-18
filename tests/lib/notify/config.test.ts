import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTestDb, insertTestUser, type TestDb } from '../../helpers/db';
import { NotifyCredentialError } from '@/lib/notify/crypto';
import {
  DEFAULT_USER_SETTINGS,
  SMTP_PRESETS,
  applyPref,
  effectivePref,
  getSmtp,
  getSmtpPassword,
  getTarget,
  getTelegramToken,
  getUserSettings,
  hasAnyEnabledTarget,
  isEventEnabled,
  notifiableUsers,
  recordSmtpOutcome,
  recordTargetOutcome,
  removeSmtp,
  removeTarget,
  saveEmailTarget,
  saveSmtp,
  saveTelegramTarget,
  saveUserSettings,
  setPref,
} from '@/lib/notify/config';

const TOKEN = '123456789:AAHk3f-EXAMPLE-tokenxxxxxxxxxxxxxxxxxx';
const PASSWORD = 'xsmtpsib-not-a-real-key';

let t: TestDb;
beforeEach(() => {
  t = createTestDb();
});
afterEach(() => {
  t.cleanup();
});

function relay(over: Partial<Parameters<typeof saveSmtp>[0]> = {}): void {
  saveSmtp({
    preset: 'brevo',
    host: 'smtp-relay.brevo.com',
    port: 587,
    security: 'starttls',
    username: 'me@example.com',
    password: PASSWORD,
    fromEmail: 'me@example.com',
    fromName: 'Budget Tracker',
    enabled: true,
    ...over,
  });
}

describe('MUST-8.15: the preset table', () => {
  it('matches the spec exactly', () => {
    expect(SMTP_PRESETS).toEqual({
      brevo: { host: 'smtp-relay.brevo.com', port: 587, security: 'starttls' },
      smtp2go: { host: 'mail.smtp2go.com', port: 587, security: 'starttls' },
      gmail: { host: 'smtp.gmail.com', port: 465, security: 'tls' },
      custom: { host: '', port: 587, security: 'starttls' },
    });
  });
});

describe('§3.2 / MUST-5.3: the relay row', () => {
  it('round-trips the config and never returns the password', () => {
    relay();
    const record = getSmtp();
    expect(record).not.toBeNull();
    expect(record?.host).toBe('smtp-relay.brevo.com');
    expect(record?.passwordSet).toBe(true);
    expect(JSON.stringify(record)).not.toContain(PASSWORD);
    expect(getSmtpPassword()).toBe(PASSWORD);
  });

  it('stores the password encrypted, not in plaintext', () => {
    relay();
    const row = t.sqlite.prepare('select password_encrypted from notification_smtp where id = 1').get() as {
      password_encrypted: string;
    };
    expect(row.password_encrypted).not.toContain(PASSWORD);
    expect(Buffer.from(row.password_encrypted, 'base64').length).toBeGreaterThan(28);
  });

  it('MUST-5.6: a null password on update keeps the stored value', () => {
    relay();
    relay({ password: null, fromName: 'Renamed' });
    expect(getSmtp()?.fromName).toBe('Renamed');
    expect(getSmtpPassword()).toBe(PASSWORD);
  });

  it('MUST-5.4: an unreadable stored credential throws NotifyCredentialError', () => {
    relay();
    t.db.run(sql`update notification_smtp set password_encrypted = ${'AAAA'} where id = 1`);
    expect(() => getSmtpPassword()).toThrowError(NotifyCredentialError);
  });

  it('records success and failure outcomes', () => {
    relay();
    recordSmtpOutcome({ ok: false, error: 'connect ECONNREFUSED', at: new Date('2026-08-17T10:00:00Z') });
    expect(getSmtp()?.lastError).toBe('connect ECONNREFUSED');
    expect(getSmtp()?.lastErrorAt).toBe('2026-08-17T10:00:00.000Z');
    recordSmtpOutcome({ ok: true, at: new Date('2026-08-17T11:00:00Z') });
    expect(getSmtp()?.lastError).toBeNull();
    expect(getSmtp()?.lastSuccessAt).toBe('2026-08-17T11:00:00.000Z');
  });

  it('removeSmtp deletes the singleton', () => {
    relay();
    removeSmtp();
    expect(getSmtp()).toBeNull();
  });
});

describe('§3.3: per-user targets', () => {
  it('stores the bot token encrypted and never returns it in the record', () => {
    const userId = insertTestUser(t.db);
    saveTelegramTarget({ userId, destination: '5551234', botToken: TOKEN, enabled: true });
    const target = getTarget(userId, 'telegram');
    expect(target?.destination).toBe('5551234');
    expect(target?.secretSet).toBe(true);
    expect(JSON.stringify(target)).not.toContain('AAHk3f');
    expect(getTelegramToken(userId)).toBe(TOKEN);
  });

  it('MUST-5.6: a null token on update keeps the stored one', () => {
    const userId = insertTestUser(t.db);
    saveTelegramTarget({ userId, destination: '5551234', botToken: TOKEN, enabled: true });
    saveTelegramTarget({ userId, destination: '-100999', botToken: null, enabled: true });
    expect(getTarget(userId, 'telegram')?.destination).toBe('-100999');
    expect(getTelegramToken(userId)).toBe(TOKEN);
  });

  it('refuses to create a telegram target with no token (the SQL pairing CHECK)', () => {
    const userId = insertTestUser(t.db);
    expect(() => saveTelegramTarget({ userId, destination: '5551234', botToken: null, enabled: true })).toThrow();
  });

  it('Round 2 fix (LOW): refuses to enable a telegram target with an empty chat ID, even called directly', () => {
    const userId = insertTestUser(t.db);
    expect(() => saveTelegramTarget({ userId, destination: '', botToken: TOKEN, enabled: true })).toThrow();
    expect(getTarget(userId, 'telegram')).toBeNull();
  });

  it('a token-only save (empty chat ID, enabled false) is fine — the invariant only guards enabled=true', () => {
    const userId = insertTestUser(t.db);
    saveTelegramTarget({ userId, destination: '', botToken: TOKEN, enabled: false });
    const target = getTarget(userId, 'telegram');
    expect(target?.destination).toBe('');
    expect(target?.secretSet).toBe(true);
    expect(target?.enabled).toBe(false);
  });

  it('an email target stores no secret at all', () => {
    const userId = insertTestUser(t.db);
    saveEmailTarget({ userId, destination: 'sam@example.com', enabled: true });
    expect(getTarget(userId, 'email')?.secretSet).toBe(false);
    const row = t.sqlite
      .prepare(`select secret_encrypted from notification_targets where user_id = ? and channel = 'email'`)
      .get(userId) as { secret_encrypted: string | null };
    expect(row.secret_encrypted).toBeNull();
  });

  it('MUST-12.7: only a successful test sets verified_at', () => {
    const userId = insertTestUser(t.db);
    saveEmailTarget({ userId, destination: 'sam@example.com', enabled: true });
    recordTargetOutcome({ userId, channel: 'email', ok: false, error: 'nope', verify: true });
    expect(getTarget(userId, 'email')?.verifiedAt).toBeNull();
    recordTargetOutcome({ userId, channel: 'email', ok: true, verify: true, at: new Date('2026-08-17T12:00:00Z') });
    expect(getTarget(userId, 'email')?.verifiedAt).toBe('2026-08-17T12:00:00.000Z');
  });

  it('removeTarget removes only that user and channel', () => {
    const a = insertTestUser(t.db, { username: 'a' });
    const b = insertTestUser(t.db, { username: 'b' });
    saveEmailTarget({ userId: a, destination: 'a@example.com', enabled: true });
    saveEmailTarget({ userId: b, destination: 'b@example.com', enabled: true });
    removeTarget(a, 'email');
    expect(getTarget(a, 'email')).toBeNull();
    expect(getTarget(b, 'email')?.destination).toBe('b@example.com');
  });

  it('MUST-6.4: hasAnyEnabledTarget is false on a dormant install', () => {
    expect(hasAnyEnabledTarget()).toBe(false);
    const userId = insertTestUser(t.db);
    saveEmailTarget({ userId, destination: 'sam@example.com', enabled: false });
    expect(hasAnyEnabledTarget()).toBe(false);
    saveEmailTarget({ userId, destination: 'sam@example.com', enabled: true });
    expect(hasAnyEnabledTarget()).toBe(true);
  });
});

describe('§3.5: per-user knobs', () => {
  it('returns every default for an absent row', () => {
    const userId = insertTestUser(t.db);
    expect(getUserSettings(userId)).toEqual(DEFAULT_USER_SETTINGS);
    expect(DEFAULT_USER_SETTINGS).toEqual({
      comingDueDays: 14,
      budgetThresholdPct: 80,
      staleImportWeeks: 3,
      dailyHour: 8,
      digestWeekday: 1,
      digestHour: 8,
    });
  });

  it('creates the row lazily on first save and updates it thereafter', () => {
    const userId = insertTestUser(t.db);
    saveUserSettings(userId, { ...DEFAULT_USER_SETTINGS, dailyHour: 19, budgetThresholdPct: 90 });
    expect(getUserSettings(userId).dailyHour).toBe(19);
    saveUserSettings(userId, { ...DEFAULT_USER_SETTINGS, dailyHour: 6 });
    expect(getUserSettings(userId).dailyHour).toBe(6);
    expect(getUserSettings(userId).budgetThresholdPct).toBe(80);
  });
});

describe('MUST-3.7: sparse preference resolution', () => {
  it('falls back to the registry default when no row exists', () => {
    const userId = insertTestUser(t.db);
    expect(effectivePref(userId, 'coming_due', 'email')).toBe(true);
    expect(effectivePref(userId, 'weekly_digest', 'email')).toBe(false);
  });

  it('a stored row wins over the default, in both directions', () => {
    const userId = insertTestUser(t.db);
    setPref(userId, 'coming_due', 'email', false);
    setPref(userId, 'weekly_digest', 'email', true);
    expect(effectivePref(userId, 'coming_due', 'email')).toBe(false);
    expect(effectivePref(userId, 'weekly_digest', 'email')).toBe(true);
  });

  it('MUST-3.6: an unknown event_id is ignored on read but not deleted', () => {
    const userId = insertTestUser(t.db);
    t.sqlite
      .prepare(`insert into notification_prefs (user_id, event_id, channel, enabled) values (?, 'on_pace_overshoot', 'email', 1)`)
      .run(userId);
    expect(effectivePref(userId, 'on_pace_overshoot', 'email')).toBe(false);
    expect(isEventEnabled(userId, 'on_pace_overshoot', 'email')).toBe(false);
    const { n } = t.sqlite.prepare('select count(*) as n from notification_prefs').get() as { n: number };
    expect(n).toBe(1);
  });

  it('nothing seeds the table', () => {
    insertTestUser(t.db);
    const { n } = t.sqlite.prepare('select count(*) as n from notification_prefs').get() as { n: number };
    expect(n).toBe(0);
  });

  it('applyPref keeps the table sparse in both directions', () => {
    const userId = insertTestUser(t.db);
    const count = () => (t.sqlite.prepare('select count(*) as n from notification_prefs').get() as { n: number }).n;

    // Matching the default writes nothing.
    applyPref(userId, 'coming_due', 'email', true);
    applyPref(userId, 'weekly_digest', 'email', false);
    expect(count()).toBe(0);

    // Differing from it writes a row...
    applyPref(userId, 'coming_due', 'email', false);
    expect(count()).toBe(1);
    expect(effectivePref(userId, 'coming_due', 'email')).toBe(false);

    // ...and going back to the default removes it again.
    applyPref(userId, 'coming_due', 'email', true);
    expect(count()).toBe(0);
    expect(effectivePref(userId, 'coming_due', 'email')).toBe(true);
  });

  it('applyPref ignores an event id that is not in the registry', () => {
    const userId = insertTestUser(t.db);
    applyPref(userId, 'on_pace_overshoot', 'email', true);
    const { n } = t.sqlite.prepare('select count(*) as n from notification_prefs').get() as { n: number };
    expect(n).toBe(0);
  });
});

describe('§4.3: the five-condition isEventEnabled chain, each failed in isolation', () => {
  function ready(role: 'admin' | 'member' = 'admin'): number {
    const userId = insertTestUser(t.db, { role, username: `u${Math.random().toString(36).slice(2, 8)}` });
    relay();
    saveEmailTarget({ userId, destination: 'sam@example.com', enabled: true });
    saveTelegramTarget({ userId, destination: '5551234', botToken: TOKEN, enabled: true });
    return userId;
  }

  it('is true when all five conditions hold', () => {
    const userId = ready();
    expect(isEventEnabled(userId, 'coming_due', 'email')).toBe(true);
    expect(isEventEnabled(userId, 'coming_due', 'telegram')).toBe(true);
  });

  it('1. the stored pref says no', () => {
    const userId = ready();
    setPref(userId, 'coming_due', 'email', false);
    expect(isEventEnabled(userId, 'coming_due', 'email')).toBe(false);
    expect(isEventEnabled(userId, 'coming_due', 'telegram')).toBe(true);
  });

  it('2. MUST-14.6: the user is deactivated', () => {
    const userId = ready();
    t.db.run(sql`update users set is_active = 0 where id = ${userId}`);
    expect(isEventEnabled(userId, 'coming_due', 'email')).toBe(false);
  });

  it('3. MUST-4.3/14.7: the role does not satisfy the audience', () => {
    const memberId = ready('member');
    expect(isEventEnabled(memberId, 'backup_failed', 'email')).toBe(false);
    expect(isEventEnabled(memberId, 'coming_due', 'email')).toBe(true);
  });

  it('4. no enabled target for that channel', () => {
    const userId = ready();
    removeTarget(userId, 'telegram');
    expect(isEventEnabled(userId, 'coming_due', 'telegram')).toBe(false);
    expect(isEventEnabled(userId, 'coming_due', 'email')).toBe(true);
    saveEmailTarget({ userId, destination: 'sam@example.com', enabled: false });
    expect(isEventEnabled(userId, 'coming_due', 'email')).toBe(false);
  });

  it('5. email additionally needs an enabled relay', () => {
    const userId = ready();
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
    expect(isEventEnabled(userId, 'coming_due', 'email')).toBe(false);
    expect(isEventEnabled(userId, 'coming_due', 'telegram')).toBe(true);
    removeSmtp();
    expect(isEventEnabled(userId, 'coming_due', 'email')).toBe(false);
  });

  it('an unknown event id is never enabled', () => {
    const userId = ready();
    expect(isEventEnabled(userId, 'not_a_real_event', 'email')).toBe(false);
  });
});

describe('notifiableUsers', () => {
  it('lists active users with their roles and skips deactivated ones', () => {
    const a = insertTestUser(t.db, { username: 'active', role: 'admin', name: 'Ada' });
    insertTestUser(t.db, { username: 'gone', role: 'member', isActive: false });
    expect(notifiableUsers()).toEqual([{ id: a, name: 'Ada', role: 'admin' }]);
  });
});

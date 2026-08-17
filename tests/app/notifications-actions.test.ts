import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb, insertTestUser, type TestDb } from '../helpers/db';
import { getSmtp, getTarget, getUserSettings, saveEmailTarget, saveSmtp, saveTelegramTarget } from '@/lib/notify/config';
import { resetNotifyRateLimitsForTests } from '@/lib/notify/ratelimit';
import { resetNotifySenderForTests, setNotifySenderForTests, NotifyError } from '@/lib/notify/send';
import { resetOutboxPumpForTests } from '@/lib/notify/outbox';

const TOKEN = '123456789:AAHk3f-EXAMPLE-tokenxxxxxxxxxxxxxxxxxx';
const PASSWORD = 'xsmtpsib-not-a-real-key';

const headerBag = vi.hoisted(() => ({ value: new Headers({ host: 'budget.local', origin: 'http://budget.local' }) }));
const currentUser = vi.hoisted(() => ({ value: { id: 0, name: 'Sam', username: 'sam', role: 'admin' as 'admin' | 'member' } }));
const fetchChats = vi.hoisted(() => vi.fn());

vi.mock('next/headers', () => ({ headers: async () => headerBag.value }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/auth/session', () => ({
  requireUser: async () => currentUser.value,
  requireAdmin: async () => {
    if (currentUser.value.role !== 'admin') throw new Error('forbidden');
    return currentUser.value;
  },
}));
vi.mock('@/lib/notify/send/telegram', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/notify/send/telegram')>()),
  fetchTelegramChats: fetchChats,
}));

const actions = await import('@/app/(app)/settings/notifications/actions');

let t: TestDb;

function relay(): void {
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
  });
}

function form(entries: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(entries)) data.append(key, value);
  return data;
}

beforeEach(() => {
  t = createTestDb();
  currentUser.value = { id: insertTestUser(t.db, { role: 'admin', username: 'sam', name: 'Sam' }), name: 'Sam', username: 'sam', role: 'admin' };
  headerBag.value = new Headers({ host: 'budget.local', origin: 'http://budget.local' });
  resetNotifyRateLimitsForTests();
  resetOutboxPumpForTests();
  setNotifySenderForTests(async () => {});
  fetchChats.mockReset();
});

afterEach(() => {
  resetNotifySenderForTests();
  resetNotifyRateLimitsForTests();
  resetOutboxPumpForTests();
  t.cleanup();
});

describe('MUST-12.1: every mutating action rejects a cross-origin request first', () => {
  it('refuses all nine before touching auth, validation or the database', async () => {
    headerBag.value = new Headers({ host: 'budget.local', origin: 'http://evil.example' });
    const empty = form({});
    const results = [
      await actions.saveSmtpAction({}, empty),
      await actions.removeSmtpAction(),
      await actions.testSmtpAction(),
      await actions.saveTelegramTargetAction({}, empty),
      await actions.saveEmailTargetAction({}, empty),
      await actions.removeTargetAction(empty),
      await actions.testTargetAction(empty),
      await actions.savePreferencesAction({}, empty),
      await actions.detectTelegramChatIdAction(),
    ];
    expect(results).toHaveLength(9);
    for (const result of results) expect(result.error).toBe('Cross-origin request rejected');
    const { n } = t.sqlite.prepare('select count(*) as n from notification_smtp').get() as { n: number };
    expect(n).toBe(0);
  });
});

describe('MUST-12.3: the admin gate', () => {
  it('refuses a member on the three SMTP actions and allows them everything else', async () => {
    currentUser.value.role = 'member';
    await expect(actions.saveSmtpAction({}, form({}))).rejects.toThrow();
    await expect(actions.removeSmtpAction()).rejects.toThrow();
    await expect(actions.testSmtpAction()).rejects.toThrow();
    const ok = await actions.saveEmailTargetAction({}, form({ destination: 'sam@example.com', enabled: 'on' }));
    expect(ok.error).toBeUndefined();
  });
});

describe('MUST-12.4: no action accepts a userId, and none accepts an outbox row id', () => {
  it('removeTargetAction takes only a channel and derives the user from the session', async () => {
    const other = insertTestUser(t.db, { username: 'other' });
    saveEmailTarget({ userId: other, destination: 'other@example.com', enabled: true });
    saveEmailTarget({ userId: currentUser.value.id, destination: 'sam@example.com', enabled: true });

    // Even with a userId field present in the body, the other member's row survives.
    await actions.removeTargetAction(form({ channel: 'email', userId: String(other) }));
    expect(getTarget(currentUser.value.id, 'email')).toBeNull();
    expect(getTarget(other, 'email')?.destination).toBe('other@example.com');
  });

  it('detectTelegramChatIdAction has zero declared parameters', () => {
    expect(actions.detectTelegramChatIdAction.length).toBe(0);
  });
});

describe('MUST-12.5 / MUST-5.6: SMTP validation and masking', () => {
  it('creates the relay and never returns the password', async () => {
    const result = await actions.saveSmtpAction(
      {},
      form({
        preset: 'brevo',
        host: 'smtp-relay.brevo.com',
        port: '587',
        security: 'starttls',
        username: 'me@example.com',
        password: PASSWORD,
        fromEmail: 'me@example.com',
        fromName: 'Budget Tracker',
        enabled: 'on',
      }),
    );
    expect(result.error).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(PASSWORD);
    expect(getSmtp()?.passwordSet).toBe(true);
  });

  it('a blank password on CREATE is a validation error', async () => {
    const result = await actions.saveSmtpAction(
      {},
      form({
        preset: 'custom',
        host: 'mail.local',
        port: '587',
        security: 'starttls',
        username: 'u',
        password: '',
        fromEmail: 'f@e.com',
        fromName: 'Budget Tracker',
        enabled: 'on',
      }),
    );
    expect(result.error).toMatch(/password/i);
    expect(getSmtp()).toBeNull();
  });

  it('a blank password on UPDATE keeps the stored value', async () => {
    relay();
    const result = await actions.saveSmtpAction(
      {},
      form({
        preset: 'brevo',
        host: 'smtp-relay.brevo.com',
        port: '587',
        security: 'starttls',
        username: 'me@example.com',
        password: '',
        fromEmail: 'new@example.com',
        fromName: 'Budget Tracker',
        enabled: 'on',
      }),
    );
    expect(result.error).toBeUndefined();
    expect(getSmtp()?.fromEmail).toBe('new@example.com');
    expect(getSmtp()?.passwordSet).toBe(true);
  });

  it('MUST-8.16: security "none" is refused unless the preset is custom', async () => {
    const base = {
      host: 'mail.local',
      port: '25',
      security: 'none',
      username: 'u',
      password: 'p',
      fromEmail: 'f@e.com',
      fromName: 'Budget Tracker',
      enabled: 'on',
    };
    expect((await actions.saveSmtpAction({}, form({ ...base, preset: 'gmail' }))).error).toMatch(/custom/i);
    expect((await actions.saveSmtpAction({}, form({ ...base, preset: 'custom' }))).error).toBeUndefined();
  });

  it('rejects a host with a scheme, a bad port, and a bad From address', async () => {
    const base = {
      preset: 'custom',
      port: '587',
      security: 'starttls',
      username: 'u',
      password: 'p',
      fromEmail: 'f@e.com',
      fromName: 'Budget Tracker',
      enabled: 'on',
    };
    expect((await actions.saveSmtpAction({}, form({ ...base, host: 'https://mail.local' }))).error).toBeDefined();
    expect((await actions.saveSmtpAction({}, form({ ...base, host: 'mail.local', port: '70000' }))).error).toBeDefined();
    expect((await actions.saveSmtpAction({}, form({ ...base, host: 'mail.local', fromEmail: 'nope' }))).error).toBeDefined();
  });
});

describe('MUST-12.5: Telegram validation', () => {
  it('rejects a malformed token and a malformed chat id', async () => {
    expect((await actions.saveTelegramTargetAction({}, form({ destination: '5551234', botToken: 'nope', enabled: 'on' }))).error).toBeDefined();
    expect((await actions.saveTelegramTargetAction({}, form({ destination: 'abc', botToken: TOKEN, enabled: 'on' }))).error).toBeDefined();
    expect((await actions.saveTelegramTargetAction({}, form({ destination: '-1001234567890', botToken: TOKEN, enabled: 'on' }))).error).toBeUndefined();
  });

  it('never returns the token', async () => {
    const result = await actions.saveTelegramTargetAction({}, form({ destination: '5551234', botToken: TOKEN, enabled: 'on' }));
    expect(JSON.stringify(result)).not.toContain('AAHk3f');
  });
});

describe('MUST-12.7: Send test bypasses the outbox', () => {
  it('calls the sender directly, writes no outbox row, and sets verified_at', async () => {
    relay();
    saveEmailTarget({ userId: currentUser.value.id, destination: 'sam@example.com', enabled: true });
    const calls: string[] = [];
    setNotifySenderForTests(async (request) => {
      calls.push(request.channel);
    });
    const result = await actions.testTargetAction(form({ channel: 'email' }));
    expect(result.message).toBeDefined();
    expect(calls).toEqual(['email']);
    const { n } = t.sqlite.prepare('select count(*) as n from notification_outbox').get() as { n: number };
    expect(n).toBe(0);
    expect(getTarget(currentUser.value.id, 'email')?.verifiedAt).not.toBeNull();
  });

  it('surfaces the transport error and does not verify on failure', async () => {
    relay();
    saveEmailTarget({ userId: currentUser.value.id, destination: 'sam@example.com', enabled: true });
    setNotifySenderForTests(async () => {
      throw new NotifyError('535 auth failed', { permanent: true, scope: 'relay' });
    });
    const result = await actions.testTargetAction(form({ channel: 'email' }));
    expect(result.error).toContain('535 auth failed');
    expect(getTarget(currentUser.value.id, 'email')?.verifiedAt).toBeNull();
  });

  it('MUST-13.1: the fourth test send in a window is refused and calls no sender', async () => {
    relay();
    saveEmailTarget({ userId: currentUser.value.id, destination: 'sam@example.com', enabled: true });
    let calls = 0;
    setNotifySenderForTests(async () => {
      calls += 1;
    });
    for (let i = 0; i < 3; i += 1) await actions.testTargetAction(form({ channel: 'email' }));
    const refused = await actions.testTargetAction(form({ channel: 'email' }));
    expect(refused.error).toMatch(/Too many test messages\. Try again in \d+ minutes\./);
    expect(calls).toBe(3);
  });
});

describe('MUST-3.7: savePreferencesAction writes only changed toggles', () => {
  it('stores a row only where the value differs from the registry default', async () => {
    const result = await actions.savePreferencesAction(
      {},
      form({
        // coming_due defaults to ON: unchecking it must write a row.
        'pref:weekly_digest:email': 'on', // default OFF -> row
        comingDueDays: '21',
        budgetThresholdPct: '85',
        staleImportWeeks: '2',
        dailyHour: '19',
        digestWeekday: '5',
        digestHour: '7',
      }),
    );
    expect(result.error).toBeUndefined();
    const rows = t.sqlite
      .prepare('select event_id, channel, enabled from notification_prefs order by event_id, channel')
      .all() as { event_id: string; channel: string; enabled: number }[];
    expect(rows).toContainEqual({ event_id: 'weekly_digest', channel: 'email', enabled: 1 });
    expect(rows).toContainEqual({ event_id: 'coming_due', channel: 'email', enabled: 0 });
    // MUST-3.7: a value that MATCHES the registry default writes no row at all.
    // budget_threshold defaults to off and was left unchecked, so it must be absent.
    expect(rows.some((r) => r.event_id === 'budget_threshold')).toBe(false);
    expect(rows.some((r) => r.event_id === 'stale_import')).toBe(false);
    expect(getUserSettings(currentUser.value.id)).toEqual({
      comingDueDays: 21,
      budgetThresholdPct: 85,
      staleImportWeeks: 2,
      dailyHour: 19,
      digestWeekday: 5,
      digestHour: 7,
    });
  });

  it('range-checks every knob in zod as well as in SQL', async () => {
    const base = {
      comingDueDays: '14',
      budgetThresholdPct: '80',
      staleImportWeeks: '3',
      dailyHour: '8',
      digestWeekday: '1',
      digestHour: '8',
    };
    expect((await actions.savePreferencesAction({}, form({ ...base, budgetThresholdPct: '100' }))).error).toBeDefined();
    expect((await actions.savePreferencesAction({}, form({ ...base, comingDueDays: '0' }))).error).toBeDefined();
    expect((await actions.savePreferencesAction({}, form({ ...base, dailyHour: '24' }))).error).toBeDefined();
  });

  it('MUST-4.3: a member cannot enable an admin-only event', async () => {
    currentUser.value.role = 'member';
    await actions.savePreferencesAction(
      {},
      form({
        'pref:backup_failed:email': 'on',
        comingDueDays: '14',
        budgetThresholdPct: '80',
        staleImportWeeks: '3',
        dailyHour: '8',
        digestWeekday: '1',
        digestHour: '8',
      }),
    );
    const rows = t.sqlite.prepare(`select event_id from notification_prefs where event_id = 'backup_failed'`).all();
    expect(rows).toHaveLength(0);
  });
});

describe('MUST-8.9 / MUST-8.11 / MUST-12.8: detectTelegramChatIdAction', () => {
  it('refuses with the exact sentence when no token is saved', async () => {
    const result = await actions.detectTelegramChatIdAction();
    expect(result.error).toBe('Save your bot token first.');
    expect(fetchChats).not.toHaveBeenCalled();
  });

  it('returns only the caller’s own bot’s chats', async () => {
    const other = insertTestUser(t.db, { username: 'other' });
    saveTelegramTarget({ userId: other, destination: '1', botToken: '999999999:OTHERtokenxxxxxxxxxxxxxxxxxxxx', enabled: true });
    saveTelegramTarget({ userId: currentUser.value.id, destination: '2', botToken: TOKEN, enabled: true });
    fetchChats.mockResolvedValue([{ chatId: '2', title: 'Sam', kind: 'private', lastMessageAt: null }]);

    const result = await actions.detectTelegramChatIdAction();
    expect(fetchChats).toHaveBeenCalledTimes(1);
    expect(fetchChats.mock.calls[0]?.[0]).toBe(TOKEN);
    expect(result.chats).toEqual([{ chatId: '2', title: 'Sam', kind: 'private', lastMessageAt: null }]);
    expect(JSON.stringify(result)).not.toContain('AAHk3f');
    expect(JSON.stringify(result)).not.toContain('OTHERtoken');
  });

  it('MUST-8.10: an empty list is not an error — the caller renders the empty state', async () => {
    saveTelegramTarget({ userId: currentUser.value.id, destination: '2', botToken: TOKEN, enabled: true });
    fetchChats.mockResolvedValue([]);
    expect(await actions.detectTelegramChatIdAction()).toEqual({ chats: [] });
  });

  it('surfaces the transport’s sentence unchanged, scrubbed of the token', async () => {
    saveTelegramTarget({ userId: currentUser.value.id, destination: '2', botToken: TOKEN, enabled: true });
    fetchChats.mockRejectedValue(new Error(`boom for bot${TOKEN}`));
    const result = await actions.detectTelegramChatIdAction();
    expect(result.error).not.toContain('AAHk3f');
    expect(result.chats).toBeUndefined();
  });

  it('MUST-13.1a: the eleventh call in a window performs no fetch', async () => {
    saveTelegramTarget({ userId: currentUser.value.id, destination: '2', botToken: TOKEN, enabled: true });
    fetchChats.mockResolvedValue([]);
    for (let i = 0; i < 10; i += 1) await actions.detectTelegramChatIdAction();
    const refused = await actions.detectTelegramChatIdAction();
    expect(refused.error).toMatch(/Too many attempts\. Try again in \d+ minutes\./);
    expect(fetchChats).toHaveBeenCalledTimes(10);
  });
});

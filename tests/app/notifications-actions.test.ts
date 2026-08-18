import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb, insertTestUser, type TestDb } from '../helpers/db';
import {
  effectivePref,
  getSmtp,
  getTarget,
  getUserSettings,
  hasAnyEnabledTarget,
  isEventEnabled,
  saveEmailTarget,
  saveSmtp,
  saveTelegramTarget,
  saveUserSettings,
  setPref,
} from '@/lib/notify/config';
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

describe('Fix: the bot token is saveable ALONE, before a chat ID is known (chicken-and-egg)', () => {
  it('token-only save round-trip: token stored, destination stays empty, enabled stays false', async () => {
    const result = await actions.saveTelegramTargetAction({}, form({ destination: '', botToken: TOKEN }));
    expect(result.error).toBeUndefined();
    expect(result.message).toBe('Token saved. Add your chat ID (press Detect) and save again to enable.');

    const stored = getTarget(currentUser.value.id, 'telegram');
    expect(stored?.secretSet).toBe(true);
    expect(stored?.destination).toBe('');
    expect(stored?.enabled).toBe(false);
  });

  it('a token-only target never receives sends: isEventEnabled and hasAnyEnabledTarget both see it as unconfigured', async () => {
    await actions.saveTelegramTargetAction({}, form({ destination: '', botToken: TOKEN }));
    expect(isEventEnabled(currentUser.value.id, 'coming_due', 'telegram')).toBe(false);
    expect(hasAnyEnabledTarget()).toBe(false);
  });

  it('enabling with an empty chat ID is rejected server-side with a clear message, and the row stays disabled', async () => {
    await actions.saveTelegramTargetAction({}, form({ destination: '', botToken: TOKEN }));
    const result = await actions.saveTelegramTargetAction({}, form({ destination: '', botToken: '', enabled: 'on' }));
    expect(result.error).toBe('Enter a chat ID (or press Detect chat ID below) before enabling Telegram.');
    expect(getTarget(currentUser.value.id, 'telegram')?.enabled).toBe(false);
  });

  it('saving both token and chat ID together still works exactly as before', async () => {
    const result = await actions.saveTelegramTargetAction({}, form({ destination: '5551234', botToken: TOKEN, enabled: 'on' }));
    expect(result.error).toBeUndefined();
    expect(result.message).toBe('Telegram saved. Press Send test message to prove it works.');
    const stored = getTarget(currentUser.value.id, 'telegram');
    expect(stored?.destination).toBe('5551234');
    expect(stored?.enabled).toBe(true);
  });

  it('Detect chat ID works right after a token-only save — the fix\'s whole point', async () => {
    const saved = await actions.saveTelegramTargetAction({}, form({ destination: '', botToken: TOKEN }));
    expect(saved.error).toBeUndefined();

    fetchChats.mockResolvedValue([{ chatId: '5551234', title: 'Sam', kind: 'private', lastMessageAt: null }]);
    const detected = await actions.detectTelegramChatIdAction();
    expect(detected.error).toBeUndefined();
    expect(detected.chats).toEqual([{ chatId: '5551234', title: 'Sam', kind: 'private', lastMessageAt: null }]);
  });

  it('filling in the chat ID afterwards and saving again enables normally', async () => {
    await actions.saveTelegramTargetAction({}, form({ destination: '', botToken: TOKEN }));
    const result = await actions.saveTelegramTargetAction({}, form({ destination: '5551234', botToken: '', enabled: 'on' }));
    expect(result.error).toBeUndefined();
    const stored = getTarget(currentUser.value.id, 'telegram');
    expect(stored?.destination).toBe('5551234');
    expect(stored?.enabled).toBe(true);
    expect(stored?.secretSet).toBe(true);
  });

  // Round 2 regression: the actual reported bug. notifications-client.tsx's Enabled checkbox
  // used to default to CHECKED for a brand-new target, so the exact form state a first-time
  // user submits by following guides.tsx step 6 verbatim (paste token, press Save, nothing
  // else touched) is token + empty chat ID + enabled=on — not enabled omitted. This is the
  // regression test for that real DOM default, not the earlier tests' hand-picked "enabled
  // omitted" state.
  it('Round 2 regression: first-time save with the DOM default (token + empty chat ID + Enabled checked) saves the token instead of rejecting everything', async () => {
    const result = await actions.saveTelegramTargetAction({}, form({ destination: '', botToken: TOKEN, enabled: 'on' }));
    expect(result.error).toBeUndefined();
    expect(result.message).toBe('Token saved. Add your chat ID (press Detect) and save again to enable.');

    const stored = getTarget(currentUser.value.id, 'telegram');
    expect(stored?.secretSet).toBe(true);
    expect(stored?.destination).toBe('');
    expect(stored?.enabled).toBe(false);
  });

  it('Round 2: the hard rejection is reserved for an EXISTING target being toggled on with no other change', async () => {
    // First-time save with the DOM default (enabled=on) must NOT be rejected (tested above).
    // Only a later save that changes nothing but the checkbox — no new token, chat ID still
    // empty — hits the hard "not yet" rejection.
    await actions.saveTelegramTargetAction({}, form({ destination: '', botToken: TOKEN, enabled: 'on' }));
    const result = await actions.saveTelegramTargetAction({}, form({ destination: '', botToken: '', enabled: 'on' }));
    expect(result.error).toBe('Enter a chat ID (or press Detect chat ID below) before enabling Telegram.');
    expect(getTarget(currentUser.value.id, 'telegram')?.enabled).toBe(false);
  });
});

describe('Round 2 fix (MED): a token-only Telegram target cannot fire a live test send', () => {
  it('testTargetAction refuses with "Set this channel up first." and spends no quota', async () => {
    await actions.saveTelegramTargetAction({}, form({ destination: '', botToken: TOKEN }));
    let calls = 0;
    setNotifySenderForTests(async () => {
      calls += 1;
    });
    for (let i = 0; i < 5; i += 1) {
      const result = await actions.testTargetAction(form({ channel: 'telegram' }));
      expect(result.error).toBe('Set this channel up first.');
    }
    expect(calls).toBe(0);

    // Confirm the guard is about the empty destination, not a missing token: filling in a
    // chat ID and enabling the channel lets a test send through immediately afterwards.
    await actions.saveTelegramTargetAction({}, form({ destination: '5551234', botToken: '', enabled: 'on' }));
    const sent = await actions.testTargetAction(form({ channel: 'telegram' }));
    expect(sent.message).toBeDefined();
    expect(calls).toBe(1);
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

  it('an unconfigured target never spends test-send quota, so a later configured send still gets its full three', async () => {
    // No target saved at all: every one of these must fail on the guard, not the limiter,
    // and must not touch the bucket.
    for (let i = 0; i < 5; i += 1) {
      const result = await actions.testTargetAction(form({ channel: 'email' }));
      expect(result.error).toBe('Set this channel up first.');
    }

    relay();
    saveEmailTarget({ userId: currentUser.value.id, destination: 'sam@example.com', enabled: true });
    let calls = 0;
    setNotifySenderForTests(async () => {
      calls += 1;
    });
    for (let i = 0; i < 3; i += 1) {
      const result = await actions.testTargetAction(form({ channel: 'email' }));
      expect(result.message).toBeDefined();
    }
    expect(calls).toBe(3);
    const refused = await actions.testTargetAction(form({ channel: 'email' }));
    expect(refused.error).toMatch(/Too many test messages\. Try again in \d+ minutes\./);
  });

  it('a missing relay never spends test-send quota either', async () => {
    // Target configured, but no SMTP relay saved yet: the relay guard must refuse before
    // the limiter is touched.
    saveEmailTarget({ userId: currentUser.value.id, destination: 'sam@example.com', enabled: true });
    for (let i = 0; i < 5; i += 1) {
      const result = await actions.testTargetAction(form({ channel: 'email' }));
      expect(result.error).toBe('An admin needs to set up outbound email before this can send.');
    }

    relay();
    let calls = 0;
    setNotifySenderForTests(async () => {
      calls += 1;
    });
    for (let i = 0; i < 3; i += 1) await actions.testTargetAction(form({ channel: 'email' }));
    expect(calls).toBe(3);
    const refused = await actions.testTargetAction(form({ channel: 'email' }));
    expect(refused.error).toMatch(/Too many test messages\. Try again in \d+ minutes\./);
  });
});

describe('Review fix (IMPORTANT): testSmtpAction can verify a fresh relay before any personal target exists', () => {
  it('sends to the relay’s own from_email when the calling admin has no email target yet', async () => {
    relay();
    const sent: string[] = [];
    setNotifySenderForTests(async (request) => {
      sent.push(request.destination);
    });
    const result = await actions.testSmtpAction();
    expect(result.error).toBeUndefined();
    expect(sent).toEqual(['me@example.com']);
    expect(result.message).toBe('Test email sent to me@example.com. Check the inbox.');
  });

  it('sends to the admin’s own target when one exists (existing behaviour)', async () => {
    relay();
    saveEmailTarget({ userId: currentUser.value.id, destination: 'sam@example.com', enabled: true });
    const sent: string[] = [];
    setNotifySenderForTests(async (request) => {
      sent.push(request.destination);
    });
    const result = await actions.testSmtpAction();
    expect(result.error).toBeUndefined();
    expect(sent).toEqual(['sam@example.com']);
    expect(result.message).toBe('Test email sent to sam@example.com. Check the inbox.');
  });

  it('still refuses when no relay has been saved at all — the relay-exists guard runs before quota is spent', async () => {
    const result = await actions.testSmtpAction();
    expect(result.error).toBe('An admin needs to set up outbound email before this can send.');
  });
});

describe('MUST-3.7: savePreferencesAction writes only changed toggles', () => {
  it('stores a row only where the value differs from the registry default, for a configured channel', async () => {
    // Review fix (IMPORTANT, the seam bug): a channel's checkboxes are rendered disabled
    // until it has a configured, enabled target (they never submit), so this pinning test
    // needs an actual configured channel to exercise the write path at all.
    saveEmailTarget({ userId: currentUser.value.id, destination: 'sam@example.com', enabled: true });
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

  it('MUST-12.4: a forged userId field does not touch another member\'s prefs or knobs', async () => {
    const other = insertTestUser(t.db, { username: 'other' });
    saveUserSettings(other, {
      comingDueDays: 30,
      budgetThresholdPct: 50,
      staleImportWeeks: 5,
      dailyHour: 6,
      digestWeekday: 2,
      digestHour: 9,
    });
    setPref(other, 'weekly_digest', 'email', true);

    // Even with a userId field present in the body, the other member's settings survive
    // untouched — the id comes from the session, never a field.
    await actions.savePreferencesAction(
      {},
      form({
        userId: String(other),
        'pref:weekly_digest:email': 'off',
        comingDueDays: '14',
        budgetThresholdPct: '80',
        staleImportWeeks: '3',
        dailyHour: '8',
        digestWeekday: '1',
        digestHour: '8',
      }),
    );

    expect(getUserSettings(other)).toEqual({
      comingDueDays: 30,
      budgetThresholdPct: 50,
      staleImportWeeks: 5,
      dailyHour: 6,
      digestWeekday: 2,
      digestHour: 9,
    });
    const row = t.sqlite
      .prepare('select enabled from notification_prefs where user_id = ? and event_id = ? and channel = ?')
      .get(other, 'weekly_digest', 'email') as { enabled: number } | undefined;
    expect(row?.enabled).toBe(1);

    // The caller's own settings, meanwhile, WERE written.
    expect(getUserSettings(currentUser.value.id)).toEqual({
      comingDueDays: 14,
      budgetThresholdPct: 80,
      staleImportWeeks: 3,
      dailyHour: 8,
      digestWeekday: 1,
      digestHour: 8,
    });
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

describe('Review fix (IMPORTANT): an unconfigured or disabled channel is never wiped by a prefs save', () => {
  it('(a) a knobs-only save with zero configured channels leaves notification_prefs empty and default-on events still effective', async () => {
    const result = await actions.savePreferencesAction(
      {},
      form({
        comingDueDays: '14',
        budgetThresholdPct: '80',
        staleImportWeeks: '3',
        dailyHour: '8',
        digestWeekday: '1',
        digestHour: '8',
      }),
    );
    expect(result.error).toBeUndefined();
    const { n } = t.sqlite.prepare('select count(*) as n from notification_prefs').get() as { n: number };
    expect(n).toBe(0);
    // MUST-3.7's read side: with no row at all, coming_due's registry default (ON) is what
    // an evaluator would still see.
    expect(effectivePref(currentUser.value.id, 'coming_due', 'email')).toBe(true);
  });

  it('(b) disabling a Telegram target, saving prefs, then re-enabling it leaves that channel’s prefs unchanged', async () => {
    saveTelegramTarget({ userId: currentUser.value.id, destination: '5551234', botToken: TOKEN, enabled: true });
    // A non-default choice on Telegram, made while the channel was configured and enabled.
    setPref(currentUser.value.id, 'coming_due', 'telegram', false);
    const telegramRows = () =>
      t.sqlite
        .prepare('select event_id, channel, enabled from notification_prefs where channel = ? order by event_id')
        .all('telegram');
    const before = telegramRows();

    saveTelegramTarget({ userId: currentUser.value.id, destination: '5551234', botToken: null, enabled: false });
    await actions.savePreferencesAction(
      {},
      form({
        comingDueDays: '14',
        budgetThresholdPct: '80',
        staleImportWeeks: '3',
        dailyHour: '8',
        digestWeekday: '1',
        digestHour: '8',
      }),
    );
    saveTelegramTarget({ userId: currentUser.value.id, destination: '5551234', botToken: null, enabled: true });

    expect(telegramRows()).toEqual(before);
  });

  it('(c) a configured, enabled channel still writes enabled=0 when its checkbox is left unchecked', async () => {
    saveEmailTarget({ userId: currentUser.value.id, destination: 'sam@example.com', enabled: true });
    await actions.savePreferencesAction(
      {},
      form({
        // coming_due defaults ON; leaving it unchecked for a CONFIGURED channel must still
        // write the row, exactly as before this fix (absence = unchecked).
        comingDueDays: '14',
        budgetThresholdPct: '80',
        staleImportWeeks: '3',
        dailyHour: '8',
        digestWeekday: '1',
        digestHour: '8',
      }),
    );
    const row = t.sqlite
      .prepare('select enabled from notification_prefs where user_id = ? and event_id = ? and channel = ?')
      .get(currentUser.value.id, 'coming_due', 'email') as { enabled: number } | undefined;
    expect(row?.enabled).toBe(0);
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

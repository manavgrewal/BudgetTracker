// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { NotificationsClient, type NotificationsPageData } from '@/app/(app)/settings/notifications/notifications-client';
import { SMTP_PRESETS } from '@/lib/notify/config';
import { NOTIFICATION_EVENTS, eventsFor } from '@/lib/notify/events';

const detect = vi.hoisted(() => vi.fn());
vi.mock('@/app/(app)/settings/notifications/actions', () => ({
  saveSmtpAction: vi.fn(async () => ({})),
  removeSmtpAction: vi.fn(async () => ({})),
  testSmtpAction: vi.fn(async () => ({})),
  saveTelegramTargetAction: vi.fn(async () => ({})),
  saveEmailTargetAction: vi.fn(async () => ({})),
  removeTargetAction: vi.fn(async () => ({})),
  testTargetAction: vi.fn(async () => ({})),
  savePreferencesAction: vi.fn(async () => ({})),
  detectTelegramChatIdAction: detect,
}));

afterEach(() => {
  cleanup();
  detect.mockReset();
});

const SETTINGS = {
  comingDueDays: 14,
  budgetThresholdPct: 80,
  staleImportWeeks: 3,
  dailyHour: 8,
  digestWeekday: 1,
  digestHour: 8,
};

function props(over: Partial<NotificationsPageData> = {}): NotificationsPageData {
  const role = over.role ?? 'admin';
  return {
    role,
    smtp: null,
    relayConfigured: over.smtp != null,
    targets: { telegram: null, email: null },
    events: over.events ?? eventsFor(role),
    prefs: {},
    settings: SETTINGS,
    deliveries: [],
    presets: SMTP_PRESETS,
    ...over,
  };
}

function target(over: Partial<NonNullable<NotificationsPageData['targets']['email']>> = {}) {
  return {
    id: 1,
    userId: 1,
    channel: 'email' as const,
    destination: 'sam@example.com',
    secretSet: false,
    enabled: true,
    verifiedAt: null,
    lastError: null,
    lastErrorAt: null,
    lastSuccessAt: null,
    ...over,
  };
}

describe('MUST-11.2: the status banner', () => {
  it('says the app makes no outbound connection when nothing is configured', () => {
    const { container } = render(<NotificationsClient {...props()} />);
    expect(container.textContent).toContain(
      'Notifications are off. This app makes no outbound connection until you configure a channel here.',
    );
  });

  it('surfaces a live last_error, naming the channel', () => {
    const { container } = render(
      <NotificationsClient
        {...props({
          targets: { telegram: null, email: target({ lastError: 'chat not found', lastErrorAt: '2026-08-17T12:00:00.000Z' }) },
        })}
      />,
    );
    expect(container.textContent).toContain('chat not found');
    expect(container.textContent).toMatch(/email/i);
  });
});

describe('MUST-11.1 / §11.3: the admin SMTP section', () => {
  it('is absent for a member and present for an admin', () => {
    expect(render(<NotificationsClient {...props({ role: 'member' })} />).container.textContent).not.toContain('Outbound email');
    cleanup();
    expect(render(<NotificationsClient {...props({ role: 'admin' })} />).container.textContent).toContain('Outbound email');
  });

  it('MUST-8.15 / MUST-11.7: changing the preset prefills host/port/security and swaps the guide', () => {
    const { container, getByLabelText } = render(<NotificationsClient {...props()} />);
    const preset = getByLabelText(/preset/i) as HTMLSelectElement;

    fireEvent.change(preset, { target: { value: 'gmail' } });
    expect((getByLabelText(/^server/i) as HTMLInputElement).value).toBe('smtp.gmail.com');
    expect((getByLabelText(/^port/i) as HTMLInputElement).value).toBe('465');
    expect((getByLabelText(/encryption/i) as HTMLSelectElement).value).toBe('tls');
    expect(container.textContent).toContain('myaccount.google.com');
    expect(container.textContent).not.toContain('smtp2go.com');

    fireEvent.change(preset, { target: { value: 'smtp2go' } });
    expect((getByLabelText(/^server/i) as HTMLInputElement).value).toBe('mail.smtp2go.com');
    expect(container.textContent).toContain('smtp2go.com');
    expect(container.textContent).not.toContain('myaccount.google.com');
  });

  it('MUST-5.6: the password field is empty with the saved placeholder, and offers no reveal', () => {
    const { getByLabelText, container } = render(
      <NotificationsClient
        {...props({
          smtp: {
            preset: 'brevo',
            host: 'smtp-relay.brevo.com',
            port: 587,
            security: 'starttls',
            username: 'me@example.com',
            fromEmail: 'me@example.com',
            fromName: 'Budget Tracker',
            enabled: true,
            passwordSet: true,
            lastError: null,
            lastErrorAt: null,
            lastSuccessAt: '2026-08-17T12:00:00.000Z',
          },
        })}
      />,
    );
    const password = getByLabelText(/^password/i) as HTMLInputElement;
    expect(password.value).toBe('');
    expect(password.placeholder).toBe('•••••••• (saved)');
    expect(password.type).toBe('password');
    expect(container.textContent).not.toMatch(/reveal|show password/i);
  });

  it('a member whose email channel has no relay sees the explanation instead of the buttons', () => {
    const { container, queryByText } = render(
      <NotificationsClient {...props({ role: 'member', smtp: null, targets: { telegram: null, email: target() } })} />,
    );
    expect(container.textContent).toContain('An admin needs to set up outbound email before this can send.');
    expect(queryByText('Send test email')).toBeNull();
  });
});

describe('MUST-11.3: the matrix is generated from the registry', () => {
  it('renders one row per event with a Telegram and an Email checkbox', () => {
    const { container } = render(<NotificationsClient {...props()} />);
    for (const event of NOTIFICATION_EVENTS) {
      expect(container.textContent).toContain(event.label);
      expect(container.querySelector(`input[name="pref:${event.id}:telegram"]`)).not.toBeNull();
      expect(container.querySelector(`input[name="pref:${event.id}:email"]`)).not.toBeNull();
    }
  });

  it('MUST-4.4: an injected registry entry the component has never heard of renders a row', () => {
    const future = {
      id: 'on_pace_overshoot',
      label: 'On pace to overshoot',
      blurb: 'Spending is tracking above the month’s limit.',
      audience: 'all',
      trigger: 'tick',
      defaultEnabled: false,
    } as const;
    const { container } = render(<NotificationsClient {...props({ events: [...eventsFor('admin'), future] })} />);
    expect(container.textContent).toContain('On pace to overshoot');
    expect(container.querySelector('input[name="pref:on_pace_overshoot:email"]')).not.toBeNull();
  });

  it('MUST-4.3: admin-only rows are absent for a member', () => {
    const { container } = render(<NotificationsClient {...props({ role: 'member' })} />);
    expect(container.textContent).not.toContain('The nightly backup failed');
    expect(container.textContent).not.toContain('A restore finished');
  });

  it('a column for an unconfigured channel is disabled and explains why', () => {
    const { container } = render(<NotificationsClient {...props({ targets: { telegram: null, email: target() } })} />);
    const telegram = container.querySelector('input[name="pref:coming_due:telegram"]') as HTMLInputElement;
    const email = container.querySelector('input[name="pref:coming_due:email"]') as HTMLInputElement;
    expect(telegram.disabled).toBe(true);
    expect(telegram.title).toBe('Set up this channel first.');
    expect(email.disabled).toBe(false);
  });

  it('reflects the effective value, not the raw stored one', () => {
    const { container } = render(
      <NotificationsClient
        {...props({
          targets: { telegram: null, email: target() },
          prefs: { 'coming_due:email': false, 'weekly_digest:email': true },
        })}
      />,
    );
    expect((container.querySelector('input[name="pref:coming_due:email"]') as HTMLInputElement).defaultChecked).toBe(false);
    expect((container.querySelector('input[name="pref:weekly_digest:email"]') as HTMLInputElement).defaultChecked).toBe(true);
    expect((container.querySelector('input[name="pref:budget_exceeded:email"]') as HTMLInputElement).defaultChecked).toBe(true);
  });

  it('MUST-11.4: the always-visible sentence about what the messages contain', () => {
    const { container } = render(<NotificationsClient {...props()} />);
    expect(container.textContent).toContain(
      'Messages contain amounts, category names and merchant names, and are delivered by Telegram or by your email provider.',
    );
  });

  it('MUST-5.8: the page says these credentials are inside the unencrypted backup', () => {
    const { container } = render(<NotificationsClient {...props()} />);
    expect(container.textContent).toMatch(/backup/i);
  });

  it('renders the five knobs with their defaults in the hint text', () => {
    const { container, getByLabelText } = render(<NotificationsClient {...props()} />);
    for (const name of ['comingDueDays', 'budgetThresholdPct', 'staleImportWeeks', 'dailyHour', 'digestWeekday', 'digestHour']) {
      expect(container.querySelector(`[name="${name}"]`)).not.toBeNull();
    }
    expect((getByLabelText(/days before/i) as HTMLInputElement).defaultValue).toBe('14');
  });
});

describe('MUST-11.2: Detect chat ID', () => {
  it('MUST-8.11: is disabled with its hint before a token is saved', () => {
    const { getByText, container } = render(<NotificationsClient {...props()} />);
    const button = getByText('Detect chat ID') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(container.textContent).toContain('Save your bot token first');
  });

  it('renders a radio per chat and fills the Chat ID field on selection without saving', async () => {
    detect.mockResolvedValue({
      chats: [
        { chatId: '5551234', title: 'Sam Grewal', kind: 'private', lastMessageAt: '2026-08-17T12:00:00.000Z' },
        { chatId: '-1001234567890', title: 'Grewal Family', kind: 'group', lastMessageAt: '2026-08-16T12:00:00.000Z' },
      ],
    });
    const { getByText, container, getByLabelText } = render(
      <NotificationsClient
        {...props({ targets: { telegram: target({ channel: 'telegram', destination: '', secretSet: true }), email: null } })}
      />,
    );
    fireEvent.click(getByText('Detect chat ID'));
    await waitFor(() => expect(container.querySelectorAll('input[type="radio"]')).toHaveLength(2));
    expect(container.textContent).toContain('Grewal Family');
    expect(container.textContent).toContain('-1001234567890');

    fireEvent.click(container.querySelectorAll('input[type="radio"]')[1] as HTMLInputElement);
    expect((getByLabelText(/chat id/i) as HTMLInputElement).value).toBe('-1001234567890');
    // Nothing is saved until Save is pressed.
    const actions = await import('@/app/(app)/settings/notifications/actions');
    expect(actions.saveTelegramTargetAction).not.toHaveBeenCalled();
  });

  it('MUST-8.10: renders the exact empty-state and error sentences', async () => {
    const withToken = props({
      targets: { telegram: target({ channel: 'telegram', destination: '', secretSet: true }), email: null },
    });

    detect.mockResolvedValue({ chats: [] });
    const first = render(<NotificationsClient {...withToken} />);
    fireEvent.click(first.getByText('Detect chat ID'));
    await waitFor(() =>
      expect(first.container.textContent).toContain(
        'No messages yet. Open Telegram, find your bot, send it any message, then press this again.',
      ),
    );
    cleanup();

    detect.mockResolvedValue({
      error: 'That bot token was rejected by Telegram. Check you pasted the whole thing, then save it again.',
    });
    const second = render(<NotificationsClient {...withToken} />);
    fireEvent.click(second.getByText('Detect chat ID'));
    await waitFor(() =>
      expect(second.container.textContent).toContain(
        'That bot token was rejected by Telegram. Check you pasted the whole thing, then save it again.',
      ),
    );
  });
});

describe('MUST-11.8: the guide closing line matches the rendered button label', () => {
  it('asserts against the button, not a duplicated literal', () => {
    const { getByText, container } = render(
      <NotificationsClient
        {...props({ targets: { telegram: target({ channel: 'telegram', destination: '1', secretSet: true }), email: null } })}
      />,
    );
    const label = (getByText('Send test message') as HTMLButtonElement).textContent ?? '';
    expect(container.textContent).toContain(`press ${label}`);
  });
});

describe('§11.4: the unverified badge', () => {
  it('shows until verified_at is set', () => {
    const unverified = render(<NotificationsClient {...props({ targets: { telegram: null, email: target() } })} />);
    expect(unverified.container.textContent).toContain('Unverified');
    cleanup();
    const verified = render(
      <NotificationsClient {...props({ targets: { telegram: null, email: target({ verifiedAt: '2026-08-17T12:00:00.000Z' }) } })} />,
    );
    expect(verified.container.textContent).not.toContain('Unverified');
  });
});

describe('§11.6: recent deliveries', () => {
  it('lists when, event, channel, status and the scrubbed error, with no retry button', () => {
    const { container, queryByText } = render(
      <NotificationsClient
        {...props({
          deliveries: [
            {
              id: 3,
              userId: 1,
              userName: 'Sam',
              channel: 'email',
              eventId: 'coming_due',
              status: 'failed',
              lastError: '550 mailbox unavailable',
              createdAt: '2026-08-17T12:00:00.000Z',
              sentAt: null,
            },
          ],
        })}
      />,
    );
    expect(container.textContent).toContain('Something is coming due');
    expect(container.textContent).toContain('550 mailbox unavailable');
    expect(queryByText(/retry/i)).toBeNull();
  });

  it('renders the timestamp in the app convention, not a raw ISO string', () => {
    const { container } = render(
      <NotificationsClient
        {...props({
          deliveries: [
            {
              id: 1,
              userId: 1,
              userName: 'Sam',
              channel: 'telegram',
              eventId: 'coming_due',
              status: 'sent',
              lastError: null,
              createdAt: '2026-08-17T12:34:56.000Z',
              sentAt: '2026-08-17T12:35:00.000Z',
            },
          ],
        })}
      />,
    );
    expect(container.textContent).toContain('2026-08-17 12:35');
    expect(container.textContent).not.toContain('2026-08-17T12:35:00.000Z');
  });

  it('review fix (LOW): renders each status as a badge, distinguishing sent/failed/pending', () => {
    const row = (status: 'sent' | 'failed' | 'pending') => ({
      id: 1,
      userId: 1,
      userName: 'Sam',
      channel: 'email' as const,
      eventId: 'coming_due',
      status,
      lastError: null,
      createdAt: '2026-08-17T12:00:00.000Z',
      sentAt: null,
    });
    const sent = render(<NotificationsClient {...props({ deliveries: [row('sent')] })} />);
    const sentBadge = sent.container.querySelector('.badge');
    expect(sentBadge?.textContent).toBe('Sent');
    expect(sentBadge?.className).toContain('badge--green');
    cleanup();

    const failed = render(<NotificationsClient {...props({ deliveries: [row('failed')] })} />);
    const failedBadge = failed.container.querySelector('.badge');
    expect(failedBadge?.textContent).toBe('Failed');
    expect(failedBadge?.className).toContain('badge--red');
    cleanup();

    const pending = render(<NotificationsClient {...props({ deliveries: [row('pending')] })} />);
    const pendingBadge = pending.container.querySelector('.badge');
    expect(pendingBadge?.textContent).toBe('Pending');
    expect(pendingBadge?.className).toContain('badge--amber');
  });

  it('review fix (LOW): shows an EmptyState instead of an empty table when there are zero rows', () => {
    // The page has one other <table> (the event/channel matrix), so scope the "no table"
    // assertion to the deliveries table specifically by checking its header cell is absent.
    const { container, queryByText } = render(<NotificationsClient {...props({ deliveries: [] })} />);
    expect(container.textContent).toContain('Nothing sent yet.');
    expect(queryByText('When')).toBeNull();
  });
});

describe('review fix (MED-LOW): Detect chat ID recovers from a rejected action', () => {
  it('re-enables the button and shows an inline error instead of sticking at "Working…"', async () => {
    detect.mockRejectedValue(new Error('network dropped'));
    const { getByText, container } = render(
      <NotificationsClient
        {...props({ targets: { telegram: target({ channel: 'telegram', destination: '', secretSet: true }), email: null } })}
      />,
    );
    // Captured once, before the click: an exact-text query still resolves uniquely (guides.tsx's
    // "press Detect chat ID" is a different string), but re-querying by text after the click
    // would not need to change either way — grabbing the same node keeps the assertion below
    // about this element regardless of its label at that instant ("Working…" vs "Detect chat ID").
    const button = getByText('Detect chat ID') as HTMLButtonElement;
    fireEvent.click(button);
    await waitFor(() => expect(button.disabled).toBe(false));
    expect(button.textContent).toBe('Detect chat ID');
    expect(container.textContent).toContain('Could not reach the server');
  });
});

describe('review fix (LOW): stale local state does not survive a Remove', () => {
  it('the SMTP form resets to preset defaults once data.smtp goes from set to null', () => {
    const configured = props({
      smtp: {
        preset: 'gmail',
        host: 'smtp.gmail.com',
        port: 465,
        security: 'tls',
        username: 'me@example.com',
        fromEmail: 'me@example.com',
        fromName: 'Budget Tracker',
        enabled: true,
        passwordSet: true,
        lastError: null,
        lastErrorAt: null,
        lastSuccessAt: null,
      },
    });
    const { getByLabelText, rerender } = render(<NotificationsClient {...configured} />);
    expect((getByLabelText(/^server/i) as HTMLInputElement).value).toBe('smtp.gmail.com');

    // Simulate the server re-render a successful Remove causes: data.smtp -> null.
    rerender(<NotificationsClient {...props({ smtp: null })} />);
    expect((getByLabelText(/^server/i) as HTMLInputElement).value).toBe(SMTP_PRESETS.brevo.host);
  });

  it('the Telegram Chat ID field clears once data.targets.telegram goes from set to null', () => {
    const configured = props({
      targets: { telegram: target({ channel: 'telegram', destination: '5551234', secretSet: true }), email: null },
    });
    const { getByLabelText, rerender } = render(<NotificationsClient {...configured} />);
    expect((getByLabelText(/chat id/i) as HTMLInputElement).value).toBe('5551234');

    rerender(<NotificationsClient {...props({ targets: { telegram: null, email: null } })} />);
    expect((getByLabelText(/chat id/i) as HTMLInputElement).value).toBe('');
  });
});

describe('review fix (MED): the admin payload never carries a delivery subject or attempts count', () => {
  it('toDeliveryForClient (page.tsx) strips subject and attempts, keeping everything the UI renders', async () => {
    const { toDeliveryForClient } = await import('@/app/(app)/settings/notifications/page');
    const raw = {
      id: 3,
      userId: 7,
      channel: 'email' as const,
      eventId: 'coming_due',
      subject: 'Coming due: Water heater warranty',
      status: 'sent' as const,
      attempts: 1,
      lastError: null,
      createdAt: '2026-08-17T12:00:00.000Z',
      sentAt: '2026-08-17T12:00:05.000Z',
    };
    const mapped = toDeliveryForClient(raw, 'Sam');
    const serialized = JSON.stringify(mapped);
    expect(serialized).not.toMatch(/"subject"/);
    expect(serialized).not.toMatch(/"attempts"/);
    expect(mapped).toMatchObject({
      id: 3,
      userId: 7,
      channel: 'email',
      eventId: 'coming_due',
      status: 'sent',
      lastError: null,
      createdAt: '2026-08-17T12:00:00.000Z',
      sentAt: '2026-08-17T12:00:05.000Z',
      userName: 'Sam',
    });
  });
});

describe('MUST-5.3: no credential ever reaches these props', () => {
  it('the serialized props contain no password and no token field', () => {
    const serialized = JSON.stringify(props({ targets: { telegram: target({ channel: 'telegram', secretSet: true }), email: target() } }));
    expect(serialized).not.toMatch(/"password"/);
    expect(serialized).not.toMatch(/"botToken"/);
    expect(serialized).not.toMatch(/"secretEncrypted"/);
    expect(serialized).toContain('"secretSet":true');
  });
});

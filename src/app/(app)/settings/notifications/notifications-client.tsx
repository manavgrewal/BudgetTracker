'use client';

import { useActionState, useState } from 'react';
import { BellIcon } from '@/components/icons';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Notice } from '@/components/ui/Notice';
import { TableWrap } from '@/components/ui/Table';
import { Field, hintClass, inputClass, selectClass } from '@/components/ui/form';
import { SubmitButton } from '@/components/SubmitButton';
import type { SmtpPreset, SmtpRecord, TargetRecord, UserSettings } from '@/lib/notify/config';
import type { SMTP_PRESETS } from '@/lib/notify/config';
import type { NotificationEventDef } from '@/lib/notify/events';
import type { DeliveryRow } from '@/lib/notify/outbox';
import { eventDef } from '@/lib/notify/events';
import {
  detectTelegramChatIdAction,
  removeSmtpAction,
  removeTargetAction,
  saveEmailTargetAction,
  savePreferencesAction,
  saveSmtpAction,
  saveTelegramTargetAction,
  testSmtpAction,
  testTargetAction,
  type DetectChatIdState,
  type NotificationsState,
} from './actions';
import { EmailGuide, GuidePanel, TelegramGuide } from './guides';

export interface NotificationsPageData {
  role: 'admin' | 'member';
  /** Admins only: a member never receives the relay record (§11.3). */
  smtp: SmtpRecord | null;
  /** Everyone: whether an enabled relay exists, so a member's email card explains itself. */
  relayConfigured: boolean;
  targets: { telegram: TargetRecord | null; email: TargetRecord | null };
  events: readonly NotificationEventDef[];
  /** Effective values, keyed `${eventId}:${channel}` (MUST-3.7, resolved on the server). */
  prefs: Record<string, boolean>;
  settings: UserSettings;
  /**
   * Review fix (MED): `subject` and `attempts` are stripped server-side (page.tsx's
   * `toDeliveryForClient`): neither is ever rendered here, and for an admin's household-wide
   * view `subject` would otherwise carry other members' warranty/category names into a payload
   * nothing displays.
   */
  deliveries: (Omit<DeliveryRow, 'subject' | 'attempts'> & { userName: string })[];
  presets: typeof SMTP_PRESETS;
}

const CHANNELS = ['telegram', 'email'] as const;
const PASSWORD_PLACEHOLDER = '•••••••• (saved)'; // MUST-5.6
const NO_CHANNEL_TOOLTIP = 'Set up this channel first.'; // MUST-11.3
/** §11.4: the three kind labels shown beside a detected chat. */
const KIND_LABEL = { private: 'Private chat', group: 'Group', supergroup: 'Group', channel: 'Channel' } as const;
const NO_RELAY = 'An admin needs to set up outbound email before this can send.'; // §11.3
const PRIVACY_SENTENCE =
  'Messages contain amounts, category names and merchant names, and are delivered by Telegram or by your email provider.'; // MUST-11.4
const BACKUP_SENTENCE =
  'The SMTP password and every bot token are stored encrypted in the database, which means they are inside the unencrypted backup archive along with everything else.'; // MUST-5.8
const DORMANT =
  'Notifications are off. This app makes no outbound connection until you configure a channel here.'; // §11.2
/** Could not reach the server at all (network drop, dev-server restart), distinct from the
 * server-returned `{ error }` shape DetectChatIdState already carries. */
const DETECT_UNREACHABLE = 'Could not reach the server. Check your connection and try again.';

/**
 * Review fix (LOW): the app's one timestamp convention (see settings/backups/backups-client.tsx),
 * applied everywhere this page shows a raw ISO string. §11.4's "relative time" wording is
 * amended to this fixed format: see the note beside MUST-11.2 in the design spec.
 */
function formatStamp(iso: string): string {
  return iso.slice(0, 16).replace('T', ' ');
}

const STATUS_BADGE: Record<DeliveryRow['status'], { label: string; className: string }> = {
  sent: { label: 'Sent', className: 'badge--green' },
  failed: { label: 'Failed', className: 'badge--red' },
  pending: { label: 'Pending', className: 'badge--amber' },
};

/** §11.6: "status badge": sent/failed/pending are visually distinct, not bare text. */
function DeliveryStatusBadge({ status }: { status: DeliveryRow['status'] }) {
  const { label, className } = STATUS_BADGE[status];
  return <span className={`badge ${className}`}>{label}</span>;
}

/**
 * Review fix (LOW): after a successful Remove, `data.smtp` flips to `null` on the next
 * server render, but this component's own `host`/`port`/`security`/`preset` state (seeded
 * once from the OLD `data.smtp` at mount) has no reason to re-run, so the form would keep
 * showing the deleted relay's values. The parent renders this with
 * `key={data.smtp ? 'set' : 'unset'}`, so a Remove (or a first Save) remounts it and every
 * `useState` initializer re-reads the current `data.smtp`.
 */
function SmtpFields({
  smtp,
  presets,
  smtpState,
  saveSmtp,
  runSmtpTest,
  runSmtpRemove,
  smtpTestState,
  smtpRemoveState,
}: {
  smtp: SmtpRecord | null;
  presets: typeof SMTP_PRESETS;
  smtpState: NotificationsState;
  saveSmtp: (formData: FormData) => void;
  runSmtpTest: (formData: FormData) => void;
  runSmtpRemove: (formData: FormData) => void;
  smtpTestState: NotificationsState;
  smtpRemoveState: NotificationsState;
}) {
  const [preset, setPreset] = useState<SmtpPreset>(smtp?.preset ?? 'brevo');
  const [host, setHost] = useState(smtp?.host ?? presets.brevo.host);
  const [port, setPort] = useState(String(smtp?.port ?? presets.brevo.port));
  const [security, setSecurity] = useState(smtp?.security ?? presets.brevo.security);

  // MUST-8.15: the picker prefills; every field stays editable afterwards.
  function choosePreset(next: SmtpPreset) {
    setPreset(next);
    setHost(presets[next].host);
    setPort(String(presets[next].port));
    setSecurity(presets[next].security);
  }

  return (
    <>
      {smtpState.error ? <Notice tone="error">{smtpState.error}</Notice> : null}
      {smtpState.message ? <Notice tone="success">{smtpState.message}</Notice> : null}
      <form action={saveSmtp} className="flex flex-col gap-4">
        <Field label="Preset" htmlFor="smtp-preset">
          <select
            id="smtp-preset"
            name="preset"
            className={selectClass}
            value={preset}
            onChange={(event) => choosePreset(event.target.value as SmtpPreset)}
          >
            <option value="brevo">Brevo</option>
            <option value="smtp2go">SMTP2GO</option>
            <option value="gmail">Gmail</option>
            <option value="custom">Custom SMTP</option>
          </select>
        </Field>
        <Field label="Server" htmlFor="smtp-host">
          <input id="smtp-host" name="host" className={inputClass} value={host} onChange={(e) => setHost(e.target.value)} />
        </Field>
        <Field label="Port" htmlFor="smtp-port">
          <input id="smtp-port" name="port" inputMode="numeric" className={inputClass} value={port} onChange={(e) => setPort(e.target.value)} />
        </Field>
        <Field label="Encryption" htmlFor="smtp-security">
          <select
            id="smtp-security"
            name="security"
            className={selectClass}
            value={security}
            onChange={(e) => setSecurity(e.target.value as typeof security)}
          >
            <option value="starttls">STARTTLS</option>
            <option value="tls">TLS</option>
            <option value="none">None</option>
          </select>
        </Field>
        {/* MUST-8.16 */}
        {security === 'none' ? (
          <Notice tone="warning">
            Credentials and message contents will cross the network unencrypted. Only use this for a relay on your own LAN.
          </Notice>
        ) : null}
        <Field label="Username" htmlFor="smtp-username">
          <input id="smtp-username" name="username" className={inputClass} defaultValue={smtp?.username ?? ''} />
        </Field>
        <Field
          label="Password"
          htmlFor="smtp-password"
          hint={smtp?.passwordSet ? 'Leave blank to keep the saved password.' : undefined}
        >
          <input
            id="smtp-password"
            name="password"
            type="password"
            autoComplete="new-password"
            className={inputClass}
            placeholder={smtp?.passwordSet ? PASSWORD_PLACEHOLDER : ''}
            defaultValue=""
          />
        </Field>
        <Field label="From address" htmlFor="smtp-from">
          <input id="smtp-from" name="fromEmail" className={inputClass} defaultValue={smtp?.fromEmail ?? ''} />
        </Field>
        <Field label="From name" htmlFor="smtp-from-name">
          <input id="smtp-from-name" name="fromName" className={inputClass} defaultValue={smtp?.fromName ?? 'Budget Tracker'} />
        </Field>
        <label className="flex items-center gap-2 text-sm text-ink">
          <input type="checkbox" name="enabled" defaultChecked={smtp?.enabled ?? true} />
          Enabled
        </label>
        <div className="flex flex-wrap gap-2">
          <SubmitButton>Save</SubmitButton>
        </div>
      </form>
      <div className="flex flex-wrap gap-2">
        <form action={runSmtpTest}>
          <SubmitButton variant="secondary">Send test email</SubmitButton>
        </form>
        {smtp ? (
          <form
            action={runSmtpRemove}
            onSubmit={(event) => {
              if (!window.confirm('Remove the outbound email settings? Email notifications will stop until it is set up again.')) {
                event.preventDefault();
              }
            }}
          >
            <SubmitButton variant="danger">Remove SMTP settings</SubmitButton>
          </form>
        ) : null}
      </div>
      {smtpTestState.error ? <Notice tone="error">{smtpTestState.error}</Notice> : null}
      {smtpTestState.message ? <Notice tone="success">{smtpTestState.message}</Notice> : null}
      {smtpRemoveState.message ? <Notice tone="success">{smtpRemoveState.message}</Notice> : null}
      {smtp?.lastSuccessAt ? <p className={hintClass}>Last successful send: {formatStamp(smtp.lastSuccessAt)}</p> : null}
      {/* MUST-11.7: only the selected preset's guide is ever rendered. */}
      <GuidePanel open={smtp === null}>
        <EmailGuide preset={preset} />
      </GuidePanel>
    </>
  );
}

/**
 * Review fix (LOW / MED-LOW): owns the Chat ID field, the detected-chat list and the Detect
 * button's own busy/error state, all reset together by the parent's `key={data.targets.telegram
 * ? 'set' : 'unset'}` the same way SmtpFields is. detect() now has a try/finally (MED-LOW): a
 * rejected action used to leave the button stuck disabled at "Working…" forever, since
 * `setDetecting(false)` never ran.
 */
function TelegramFields({
  telegram,
  telegramState,
  saveTelegram,
  runTelegramTest,
  runTelegramRemove,
  telegramTestState,
  telegramRemoveState,
}: {
  telegram: TargetRecord | null;
  telegramState: NotificationsState;
  saveTelegram: (formData: FormData) => void;
  runTelegramTest: (formData: FormData) => void;
  runTelegramRemove: (formData: FormData) => void;
  telegramTestState: NotificationsState;
  telegramRemoveState: NotificationsState;
}) {
  const [chatId, setChatId] = useState(telegram?.destination ?? '');
  const [detected, setDetected] = useState<DetectChatIdState | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [detectError, setDetectError] = useState<string | null>(null);

  async function detect() {
    setDetecting(true);
    setDetectError(null);
    try {
      setDetected(await detectTelegramChatIdAction());
    } catch {
      setDetectError(DETECT_UNREACHABLE);
    } finally {
      setDetecting(false);
    }
  }

  return (
    <>
      {telegramState.error ? <Notice tone="error">{telegramState.error}</Notice> : null}
      {telegramState.message ? <Notice tone="success">{telegramState.message}</Notice> : null}
      {telegram && telegram.verifiedAt === null ? (
        <p className={hintClass}>Unverified — press Send test message to prove it works.</p>
      ) : null}
      {telegram?.lastError ? (
        <Notice tone="error">
          {telegram.lastError} ({telegram.lastErrorAt ? formatStamp(telegram.lastErrorAt) : telegram.lastErrorAt})
        </Notice>
      ) : null}
      {telegram?.lastSuccessAt ? <p className={hintClass}>Last successful send: {formatStamp(telegram.lastSuccessAt)}</p> : null}

      <form action={saveTelegram} className="flex flex-col gap-4">
        <Field
          label="Bot token"
          htmlFor="telegram-token"
          hint={telegram?.secretSet ? 'Leave blank to keep the saved token.' : undefined}
        >
          <input
            id="telegram-token"
            name="botToken"
            type="password"
            autoComplete="off"
            className={inputClass}
            placeholder={telegram?.secretSet ? PASSWORD_PLACEHOLDER : ''}
            defaultValue=""
          />
        </Field>
        <Field
          label="Chat ID"
          htmlFor="telegram-chat"
          hint={!telegram?.destination ? 'Fill this in after saving the token above — use Detect chat ID, or type it in yourself.' : undefined}
        >
          <input
            id="telegram-chat"
            name="destination"
            inputMode="numeric"
            className={inputClass}
            value={chatId}
            onChange={(event) => setChatId(event.target.value)}
          />
        </Field>
        <label className="flex items-center gap-2 text-sm text-ink">
          <input type="checkbox" name="enabled" defaultChecked={telegram?.enabled ?? true} />
          Enabled
        </label>
        <div>
          <SubmitButton>Save</SubmitButton>
        </div>
      </form>

      {/* MUST-11.2: the Detect chat ID control, immediately beside the Chat ID field. */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="btn btn--secondary"
          disabled={!telegram?.secretSet || detecting}
          onClick={detect}
        >
          {detecting ? 'Working…' : 'Detect chat ID'}
        </button>
        {!telegram?.secretSet ? <span className={hintClass}>Save your bot token first</span> : null}
      </div>
      {detectError ? <Notice tone="error">{detectError}</Notice> : null}
      {detected?.error ? <Notice tone="error">{detected.error}</Notice> : null}
      {detected?.chats?.length === 0 ? (
        <Notice tone="info">
          No messages yet. Open Telegram, find your bot, send it any message, then press this again.
        </Notice>
      ) : null}
      {detected?.chats && detected.chats.length > 0 ? (
        <ul className="flex flex-col gap-1.5">
          {detected.chats.map((chat) => (
            <li key={chat.chatId}>
              <label className="flex flex-wrap items-center gap-2 text-sm text-ink">
                <input type="radio" name="detected-chat" value={chat.chatId} onChange={() => setChatId(chat.chatId)} />
                <span className="font-semibold">{chat.title}</span>
                <span className="text-muted">{KIND_LABEL[chat.kind]}</span>
                <span className="text-subtle">{chat.chatId}</span>
                {chat.lastMessageAt ? <span className="text-subtle">last message {formatStamp(chat.lastMessageAt)}</span> : null}
              </label>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <form action={runTelegramTest}>
          <input type="hidden" name="channel" value="telegram" />
          <SubmitButton variant="secondary" disabled={!telegram}>
            Send test message
          </SubmitButton>
        </form>
        {telegram ? (
          <form action={runTelegramRemove}>
            <input type="hidden" name="channel" value="telegram" />
            <SubmitButton variant="danger">Remove</SubmitButton>
          </form>
        ) : null}
      </div>
      {telegramTestState.error ? <Notice tone="error">{telegramTestState.error}</Notice> : null}
      {telegramTestState.message ? <Notice tone="success">{telegramTestState.message}</Notice> : null}
      {telegramRemoveState.message ? <Notice tone="success">{telegramRemoveState.message}</Notice> : null}

      {/* MUST-11.7: open by default until a token has been saved, collapsed afterwards. */}
      <GuidePanel open={!telegram?.secretSet}>
        <TelegramGuide />
      </GuidePanel>
    </>
  );
}

export function NotificationsClient(data: NotificationsPageData) {
  const [smtpState, saveSmtp] = useActionState<NotificationsState, FormData>(saveSmtpAction, {});
  const [telegramState, saveTelegram] = useActionState<NotificationsState, FormData>(saveTelegramTargetAction, {});
  const [emailState, saveEmail] = useActionState<NotificationsState, FormData>(saveEmailTargetAction, {});
  const [prefsState, savePrefs] = useActionState<NotificationsState, FormData>(savePreferencesAction, {});
  // The various runXAction() functions below only ever appear as a <form action={...}>, never
  // as an event handler, so `useActionState`'s dispatch (a plain (payload) => void) is what
  // gets bound, not the underlying async server action (which resolves to NotificationsState,
  // a shape `<form action>` cannot accept). This is the same wrapping every other form on this
  // page already needs for save/dispatch.
  const [smtpTestState, runSmtpTest] = useActionState<NotificationsState, FormData>(() => testSmtpAction(), {});
  const [smtpRemoveState, runSmtpRemove] = useActionState<NotificationsState, FormData>(() => removeSmtpAction(), {});
  const [telegramTestState, runTelegramTest] = useActionState<NotificationsState, FormData>(
    (_prev, formData) => testTargetAction(formData),
    {},
  );
  const [telegramRemoveState, runTelegramRemove] = useActionState<NotificationsState, FormData>(
    (_prev, formData) => removeTargetAction(formData),
    {},
  );
  const [emailTestState, runEmailTest] = useActionState<NotificationsState, FormData>(
    (_prev, formData) => testTargetAction(formData),
    {},
  );
  const [emailRemoveState, runEmailRemove] = useActionState<NotificationsState, FormData>(
    (_prev, formData) => removeTargetAction(formData),
    {},
  );

  const dormant =
    !(data.targets.telegram?.enabled ?? false) && !(data.targets.email?.enabled ?? false);
  const liveErrors = [
    data.targets.telegram?.lastError ? { channel: 'Telegram', error: data.targets.telegram.lastError } : null,
    data.targets.email?.lastError ? { channel: 'Email', error: data.targets.email.lastError } : null,
    data.smtp?.lastError ? { channel: 'Outbound email (SMTP)', error: data.smtp.lastError } : null,
  ].filter((entry): entry is { channel: string; error: string } => entry !== null);

  return (
    <div className="flex flex-col gap-6">
      {dormant ? <Notice tone="info">{DORMANT}</Notice> : null}
      {liveErrors.map((entry) => (
        <Notice key={entry.channel} tone="error" title={entry.channel}>
          {entry.error}
        </Notice>
      ))}

      {/* §11.3: admins only. A member never sees this card at all. */}
      {data.role === 'admin' ? (
        <Card>
          <CardHeader title="Outbound email (SMTP)" description="One relay for the whole household." />
          <CardBody className="flex flex-col gap-4">
            {/* Review fix (LOW): keyed so a Remove (data.smtp -> null) or a first Save
                (null -> a record) remounts this subtree instead of leaving stale local state
                (host/port/security/preset) showing the deleted relay's values. */}
            <SmtpFields
              key={data.smtp ? 'set' : 'unset'}
              smtp={data.smtp}
              presets={data.presets}
              smtpState={smtpState}
              saveSmtp={saveSmtp}
              runSmtpTest={runSmtpTest}
              runSmtpRemove={runSmtpRemove}
              smtpTestState={smtpTestState}
              smtpRemoveState={smtpRemoveState}
            />
          </CardBody>
        </Card>
      ) : null}

      {/* §11.4: everyone. Two sub-cards; each shows its own last_error, last_success_at,
          and an Unverified badge until verified_at is set. */}
      <Card>
        <CardHeader title="Telegram" description="Your own bot, messaging your own chat." />
        <CardBody className="flex flex-col gap-4">
          {/* Review fix (LOW): same remount-on-Remove/Save reasoning as SmtpFields above. */}
          <TelegramFields
            key={data.targets.telegram ? 'set' : 'unset'}
            telegram={data.targets.telegram}
            telegramState={telegramState}
            saveTelegram={saveTelegram}
            runTelegramTest={runTelegramTest}
            runTelegramRemove={runTelegramRemove}
            telegramTestState={telegramTestState}
            telegramRemoveState={telegramRemoveState}
          />
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Email" description="Where the household relay sends your messages." />
        <CardBody className="flex flex-col gap-4">
          {emailState.error ? <Notice tone="error">{emailState.error}</Notice> : null}
          {emailState.message ? <Notice tone="success">{emailState.message}</Notice> : null}
          {data.targets.email && data.targets.email.verifiedAt === null ? (
            <p className={hintClass}>Unverified — press Send test email to prove it works.</p>
          ) : null}
          {data.targets.email?.lastError ? (
            <Notice tone="error">
              {data.targets.email.lastError} ({data.targets.email.lastErrorAt ? formatStamp(data.targets.email.lastErrorAt) : data.targets.email.lastErrorAt})
            </Notice>
          ) : null}
          {data.targets.email?.lastSuccessAt ? (
            <p className={hintClass}>Last successful send: {formatStamp(data.targets.email.lastSuccessAt)}</p>
          ) : null}

          <form action={saveEmail} className="flex flex-col gap-4">
            <Field label="Email address" htmlFor="email-destination">
              <input
                id="email-destination"
                name="destination"
                type="email"
                className={inputClass}
                defaultValue={data.targets.email?.destination ?? ''}
              />
            </Field>
            <label className="flex items-center gap-2 text-sm text-ink">
              <input type="checkbox" name="enabled" defaultChecked={data.targets.email?.enabled ?? true} />
              Enabled
            </label>
            <div>
              <SubmitButton>Save</SubmitButton>
            </div>
          </form>

          {/* §11.3: where a member's email channel is unusable for want of a relay. */}
          {data.relayConfigured ? (
            <div className="flex flex-wrap gap-2">
              <form action={runEmailTest}>
                <input type="hidden" name="channel" value="email" />
                <SubmitButton variant="secondary" disabled={!data.targets.email}>
                  Send test email
                </SubmitButton>
              </form>
              {data.targets.email ? (
                <form action={runEmailRemove}>
                  <input type="hidden" name="channel" value="email" />
                  <SubmitButton variant="danger">Remove</SubmitButton>
                </form>
              ) : null}
            </div>
          ) : (
            <Notice tone="info">{NO_RELAY}</Notice>
          )}
          {emailTestState.error ? <Notice tone="error">{emailTestState.error}</Notice> : null}
          {emailTestState.message ? <Notice tone="success">{emailTestState.message}</Notice> : null}
          {emailRemoveState.message ? <Notice tone="success">{emailRemoveState.message}</Notice> : null}
        </CardBody>
      </Card>

      {/* §11.5: the matrix, generated from data.events. NO event is named in JSX. */}
      <Card>
        <CardHeader title="What you get told about" description="Per event, per channel." />
        <CardBody className="flex flex-col gap-4">
          {prefsState.error ? <Notice tone="error">{prefsState.error}</Notice> : null}
          {prefsState.message ? <Notice tone="success">{prefsState.message}</Notice> : null}
          <form action={savePrefs} className="flex flex-col gap-4">
            <TableWrap>
              <thead>
                <tr>
                  <th className="text-left">Event</th>
                  <th>Telegram</th>
                  <th>Email</th>
                </tr>
              </thead>
              <tbody>
                {data.events.map((event) => (
                  <tr key={event.id}>
                    <td className="text-left">
                      <span className="font-semibold text-ink">{event.label}</span>
                      <span className="block text-muted">{event.blurb}</span>
                    </td>
                    {CHANNELS.map((channel) => {
                      const configured = data.targets[channel]?.enabled ?? false;
                      return (
                        <td key={channel} className="text-center">
                          <input
                            type="checkbox"
                            name={`pref:${event.id}:${channel}`}
                            defaultChecked={data.prefs[`${event.id}:${channel}`] ?? event.defaultEnabled}
                            disabled={!configured}
                            title={configured ? undefined : NO_CHANNEL_TOOLTIP}
                            aria-label={`${event.label} on ${channel}`}
                          />
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </TableWrap>
            <p className="text-sm text-muted">{PRIVACY_SENTENCE}</p>
            <p className={hintClass}>{BACKUP_SENTENCE}</p>
            {/* The five knobs, each with its default in the hint text. */}
            <Field label="Days before a due date to warn" htmlFor="comingDueDays" hint="Default 14.">
              <input id="comingDueDays" name="comingDueDays" inputMode="numeric" className={inputClass} defaultValue={String(data.settings.comingDueDays)} />
            </Field>
            <Field label="Budget warning threshold (%)" htmlFor="budgetThresholdPct" hint="Default 80. 100 is the separate over-budget alert.">
              <input id="budgetThresholdPct" name="budgetThresholdPct" inputMode="numeric" className={inputClass} defaultValue={String(data.settings.budgetThresholdPct)} />
            </Field>
            <Field label="Weeks without an import before nagging" htmlFor="staleImportWeeks" hint="Default 3.">
              <input id="staleImportWeeks" name="staleImportWeeks" inputMode="numeric" className={inputClass} defaultValue={String(data.settings.staleImportWeeks)} />
            </Field>
            <Field label="Daily message hour" htmlFor="dailyHour" hint="Default 8 (24-hour clock).">
              <input id="dailyHour" name="dailyHour" inputMode="numeric" className={inputClass} defaultValue={String(data.settings.dailyHour)} />
            </Field>
            <Field label="Weekly summary day" htmlFor="digestWeekday" hint="Default Monday.">
              <select id="digestWeekday" name="digestWeekday" className={selectClass} defaultValue={String(data.settings.digestWeekday)}>
                {['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map((day, index) => (
                  <option key={day} value={String(index)}>
                    {day}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Weekly summary hour" htmlFor="digestHour" hint="Default 8 (24-hour clock).">
              <input id="digestHour" name="digestHour" inputMode="numeric" className={inputClass} defaultValue={String(data.settings.digestHour)} />
            </Field>
            <div>
              <SubmitButton>Save</SubmitButton>
            </div>
          </form>
        </CardBody>
      </Card>

      {/* §11.6: read-only. No retry button: the pump owns retries. */}
      <Card>
        <CardHeader title="Recent deliveries" description="The last twenty messages this app tried to send." />
        {data.deliveries.length === 0 ? (
          <EmptyState icon={BellIcon} title="Nothing sent yet.">
            Deliveries appear here once a channel is set up and an event fires.
          </EmptyState>
        ) : (
          <CardBody>
            <TableWrap>
              <thead>
                <tr>
                  <th className="text-left">When</th>
                  {data.role === 'admin' ? <th className="text-left">Who</th> : null}
                  <th className="text-left">Event</th>
                  <th className="text-left">Channel</th>
                  <th className="text-left">Status</th>
                </tr>
              </thead>
              <tbody>
                {data.deliveries.map((row) => (
                  <tr key={row.id}>
                    <td>{formatStamp(row.sentAt ?? row.createdAt)}</td>
                    {data.role === 'admin' ? <td>{row.userName}</td> : null}
                    <td>{eventDef(row.eventId)?.label ?? row.eventId}</td>
                    <td>{row.channel}</td>
                    <td>
                      <DeliveryStatusBadge status={row.status} />
                      {row.lastError ? <span className="block text-muted">{row.lastError}</span> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </TableWrap>
          </CardBody>
        )}
      </Card>
    </div>
  );
}

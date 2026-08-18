import type { SmtpSecurity } from '@/lib/notify/config';

export type NotifyErrorScope = 'target' | 'relay';

/**
 * MUST-7.7: `permanent` means the request will never succeed unchanged: HTTP 400/401/403/404
 * from Telegram (bad token, bad chat id, bot blocked or deleted) and an SMTP 5xx. HTTP 429
 * and 5xx, DNS failures, connect timeouts and SMTP 4xx are transient.
 *
 * MUST-7.10: `scope` decides which row records the failure: 'relay' for a connection or
 * authentication problem with the household's SMTP server (recorded on notification_smtp),
 * 'target' for anything specific to one recipient (recorded on notification_targets).
 * Telegram failures are always 'target': there is one bot per person.
 *
 * `retryAfterMs` carries Telegram's `parameters.retry_after` when present; it overrides the
 * computed backoff (MUST-7.7).
 *
 * Every message reaching here has ALREADY been through scrubSecrets (MUST-5.5).
 */
export class NotifyError extends Error {
  readonly permanent: boolean;
  readonly scope: NotifyErrorScope;
  readonly retryAfterMs: number | null;

  constructor(
    message: string,
    opts: { permanent: boolean; scope?: NotifyErrorScope; retryAfterMs?: number | null },
  ) {
    super(message);
    this.name = 'NotifyError';
    this.permanent = opts.permanent;
    this.scope = opts.scope ?? 'target';
    this.retryAfterMs = opts.retryAfterMs ?? null;
  }
}

export interface SmtpTransportConfig {
  host: string;
  port: number;
  security: SmtpSecurity;
  username: string;
  password: string;
  fromEmail: string;
  fromName: string;
}

export type DeliveryRequest =
  | { channel: 'telegram'; destination: string; botToken: string; subject: string; body: string }
  | { channel: 'email'; destination: string; smtp: SmtpTransportConfig; subject: string; body: string };

export type NotifySender = (request: DeliveryRequest) => Promise<void>;

/**
 * MUST-17.1: the seam. Mirrors the OCR engine seam (warranty MUST-7.17): every
 * evaluation, outbox and integration test installs a fake here, so nodemailer is never
 * constructed and `fetch` is never called outside the two transport unit tests.
 */
let override: NotifySender | null = null;

export function setNotifySenderForTests(fake: NotifySender): void {
  override = fake;
}

export function resetNotifySenderForTests(): void {
  override = null;
}

async function realSender(request: DeliveryRequest): Promise<void> {
  // Dynamic imports keep the transports (and nodemailer) out of the module graph until
  // a message is actually being delivered, which is what makes the dormancy rule
  // structural rather than conventional (MUST-1.1).
  if (request.channel === 'telegram') {
    const { sendTelegram } = await import('@/lib/notify/send/telegram');
    await sendTelegram({ botToken: request.botToken, chatId: request.destination, subject: request.subject, body: request.body });
    return;
  }
  const { sendEmail } = await import('@/lib/notify/send/email');
  await sendEmail({ smtp: request.smtp, to: request.destination, subject: request.subject, text: request.body });
}

export function deliver(request: DeliveryRequest): Promise<void> {
  return (override ?? realSender)(request);
}

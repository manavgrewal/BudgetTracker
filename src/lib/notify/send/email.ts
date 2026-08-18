import { createTransport, type Transporter } from 'nodemailer';
import { authPlainBase64, scrubSecrets } from '@/lib/notify/crypto';
import { NotifyError, type SmtpTransportConfig } from '@/lib/notify/send';

const CONNECTION_TIMEOUT_MS = 15_000;
const GREETING_TIMEOUT_MS = 15_000;
const SOCKET_TIMEOUT_MS = 20_000;

/** nodemailer error codes that mean "the relay itself is the problem" (MUST-7.10). */
const RELAY_CODES = new Set(['ECONNECTION', 'ETIMEDOUT', 'ESOCKET', 'EDNS', 'EAUTH', 'ETLS']);

function codeOf(error: unknown): string | null {
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

function responseCodeOf(error: unknown): number | null {
  const value = (error as { responseCode?: unknown }).responseCode;
  return typeof value === 'number' ? value : null;
}

/**
 * MUST-8.12: the exact option set the spec specifies, and nothing more. `secure` is
 * implicit TLS (port 465), `requireTLS` is a mandatory STARTTLS upgrade (port 587), and
 * 'none' is plain socket with neither.
 *
 * MUST-8.13: pool: false, and the transport is created per batch and closed after it. A
 * household sends a handful of messages a day; a pooled connection to a third-party relay
 * would spend its life idle-timing-out and reconnecting.
 *
 * MUST-8.17: the transport's built-in connection-check method is deliberately NEVER
 * called anywhere: a relay that accepts a connection but rejects the send is a false
 * green light. Only a real Send test counts.
 */
export async function sendEmail(input: {
  smtp: SmtpTransportConfig;
  to: string;
  subject: string;
  text: string;
}): Promise<void> {
  // Created INSIDE the try (Task 13's Send-test action calls sendEmail directly, outside
  // the pump's own re-scrub net): a rejected option (e.g. an invalid port) must become a
  // scrubbed, classified NotifyError here too, not a raw thrown error from nodemailer.
  let transporter: Transporter | undefined;
  try {
    transporter = createTransport({
      host: input.smtp.host,
      port: input.smtp.port,
      secure: input.smtp.security === 'tls',
      requireTLS: input.smtp.security === 'starttls',
      auth: { user: input.smtp.username, pass: input.smtp.password },
      pool: false,
      connectionTimeout: CONNECTION_TIMEOUT_MS,
      greetingTimeout: GREETING_TIMEOUT_MS,
      socketTimeout: SOCKET_TIMEOUT_MS,
      tls: { minVersion: 'TLSv1.2' },
    });

    // MUST-8.14: `text` only, no `html`. Same untrusted-input reasoning as MUST-8.2, and
    // it removes the entire HTML-email test surface.
    await transporter.sendMail({
      from: `"${input.smtp.fromName}" <${input.smtp.fromEmail}>`,
      to: input.to,
      subject: input.subject,
      text: input.text,
    });
  } catch (error) {
    const raw = error instanceof Error ? error.message : 'The relay refused the message.';
    // MUST-5.5: nodemailer's authentication errors routinely quote the failing command
    // line, which on some relays includes the base64 AUTH PLAIN payload.
    const message = scrubSecrets(raw, [
      input.smtp.password,
      authPlainBase64(input.smtp.username, input.smtp.password),
    ]);

    const code = codeOf(error);
    const responseCode = responseCodeOf(error);
    // MUST-7.7: SMTP 5xx is permanent (authentication failure, invalid recipient);
    // SMTP 4xx, connect timeouts and DNS failures are transient.
    const permanent = responseCode !== null && responseCode >= 500;
    // MUST-7.10: a connection or authentication problem belongs to the household relay
    // row; anything the relay said about this one recipient belongs to the target row.
    const scope = code !== null && RELAY_CODES.has(code) ? 'relay' : 'target';

    throw new NotifyError(message, { permanent, scope });
  } finally {
    transporter?.close();
  }
}

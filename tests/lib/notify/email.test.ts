import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NotifyError, type SmtpTransportConfig } from '@/lib/notify/send';

const sendMail = vi.fn();
const close = vi.fn();
// The explicit `options` parameter (unused at runtime) is what makes
// `createTransport.mock.calls[n]?.[0]` below a real, indexable argument type
// instead of an inferred zero-length tuple.
const createTransport = vi.fn((options?: Record<string, unknown>) => {
  void options;
  return { sendMail, close };
});

vi.mock('nodemailer', () => ({ default: { createTransport }, createTransport }));

const { sendEmail } = await import('@/lib/notify/send/email');

function config(over: Partial<SmtpTransportConfig> = {}): SmtpTransportConfig {
  return {
    host: 'smtp-relay.brevo.com',
    port: 587,
    security: 'starttls',
    username: 'me@example.com',
    password: 'xsmtpsib-secret',
    fromEmail: 'me@example.com',
    fromName: 'Budget Tracker',
    ...over,
  };
}

beforeEach(() => {
  sendMail.mockReset().mockResolvedValue({ messageId: '1' });
  close.mockReset();
  createTransport.mockClear();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('MUST-8.12 / MUST-8.13: the transport', () => {
  it('maps all three security values onto secure/requireTLS', async () => {
    await sendEmail({ smtp: config({ security: 'tls', port: 465 }), to: 'a@b.com', subject: 's', text: 't' });
    expect(createTransport.mock.calls[0]?.[0]).toMatchObject({ secure: true, requireTLS: false });

    await sendEmail({ smtp: config({ security: 'starttls' }), to: 'a@b.com', subject: 's', text: 't' });
    expect(createTransport.mock.calls[1]?.[0]).toMatchObject({ secure: false, requireTLS: true });

    await sendEmail({ smtp: config({ security: 'none' }), to: 'a@b.com', subject: 's', text: 't' });
    expect(createTransport.mock.calls[2]?.[0]).toMatchObject({ secure: false, requireTLS: false });
  });

  it('passes the documented timeouts, minimum TLS version and pool: false', async () => {
    await sendEmail({ smtp: config(), to: 'a@b.com', subject: 's', text: 't' });
    expect(createTransport.mock.calls[0]?.[0]).toMatchObject({
      host: 'smtp-relay.brevo.com',
      port: 587,
      pool: false,
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      socketTimeout: 20_000,
      auth: { user: 'me@example.com', pass: 'xsmtpsib-secret' },
      tls: { minVersion: 'TLSv1.2' },
    });
  });

  it('closes the transport after the batch, including on failure', async () => {
    await sendEmail({ smtp: config(), to: 'a@b.com', subject: 's', text: 't' });
    expect(close).toHaveBeenCalledTimes(1);
    sendMail.mockRejectedValueOnce(Object.assign(new Error('boom'), { responseCode: 421 }));
    await expect(sendEmail({ smtp: config(), to: 'a@b.com', subject: 's', text: 't' })).rejects.toThrow();
    expect(close).toHaveBeenCalledTimes(2);
  });
});

describe('MUST-8.14: text only, never html', () => {
  it('formats From and passes only a text part', async () => {
    await sendEmail({ smtp: config(), to: 'sam@example.com', subject: 'Subject', text: 'Body' });
    const mail = sendMail.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(mail).toEqual({
      from: '"Budget Tracker" <me@example.com>',
      to: 'sam@example.com',
      subject: 'Subject',
      text: 'Body',
    });
    expect('html' in mail).toBe(false);
  });
});

describe('MUST-7.7 / MUST-7.10: failure classification and scope', () => {
  it('a 5xx responseCode is permanent', async () => {
    sendMail.mockRejectedValueOnce(Object.assign(new Error('550 mailbox unavailable'), { responseCode: 550 }));
    await expect(sendEmail({ smtp: config(), to: 'a@b.com', subject: 's', text: 't' })).rejects.toMatchObject({
      permanent: true,
    });
  });

  it('a 4xx responseCode is transient', async () => {
    sendMail.mockRejectedValueOnce(Object.assign(new Error('421 too many connections'), { responseCode: 421 }));
    await expect(sendEmail({ smtp: config(), to: 'a@b.com', subject: 's', text: 't' })).rejects.toMatchObject({
      permanent: false,
    });
  });

  it('a connection or auth failure is relay-scoped; a rejected recipient is target-scoped', async () => {
    sendMail.mockRejectedValueOnce(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNECTION' }));
    await expect(sendEmail({ smtp: config(), to: 'a@b.com', subject: 's', text: 't' })).rejects.toMatchObject({
      scope: 'relay',
      permanent: false,
    });

    sendMail.mockRejectedValueOnce(Object.assign(new Error('535 auth failed'), { code: 'EAUTH', responseCode: 535 }));
    await expect(sendEmail({ smtp: config(), to: 'a@b.com', subject: 's', text: 't' })).rejects.toMatchObject({
      scope: 'relay',
      permanent: true,
    });

    sendMail.mockRejectedValueOnce(Object.assign(new Error('550 no such user'), { responseCode: 550 }));
    await expect(sendEmail({ smtp: config(), to: 'a@b.com', subject: 's', text: 't' })).rejects.toMatchObject({
      scope: 'target',
    });
  });

  it('MUST-5.5: the password and its AUTH PLAIN form never survive into the error', async () => {
    const authPlain = Buffer.from('\0me@example.com\0xsmtpsib-secret', 'utf8').toString('base64');
    sendMail.mockRejectedValueOnce(
      Object.assign(new Error(`535 auth failed: AUTH PLAIN ${authPlain} (pass xsmtpsib-secret)`), { code: 'EAUTH', responseCode: 535 }),
    );
    const error = await sendEmail({ smtp: config(), to: 'a@b.com', subject: 's', text: 't' }).catch((e) => e as NotifyError);
    expect((error as NotifyError).message).not.toContain('xsmtpsib-secret');
    expect((error as NotifyError).message).not.toContain(authPlain);
    expect((error as NotifyError).message).toContain('[redacted]');
  });
});

describe('MUST-8.17: saving the relay does not connect', () => {
  it('verify() is never used', async () => {
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../../../src/lib/notify/send/email.ts', import.meta.url), 'utf8'),
    );
    expect(source).not.toContain('.verify(');
  });
});

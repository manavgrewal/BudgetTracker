/**
 * MUST-15.3: @types/nodemailer 8.0.1 (the latest published) lags nodemailer 9.0.5's own
 * documented, runtime-accepted options shape. Two concrete gaps: `SMTPTransport.Options`
 * has no `pool` property at all (only `SMTPPool.Options` does, and there `pool` must be
 * the literal `true`), and its `auth` field is typed as the internal AuthenticationType
 * union (which needs a `type` discriminant nodemailer computes for you) rather than the
 * plain `{ user, pass }` shape nodemailer's docs and runtime accept. Rather than reshape
 * the call site to satisfy an internal type, or loosen `strict`/cast to `any`, this adds
 * one exact overload for the options object src/lib/notify/send/email.ts actually builds.
 */
declare module 'nodemailer' {
  interface MinimalSmtpTransportOptions {
    host: string;
    port: number;
    secure: boolean;
    requireTLS: boolean;
    auth: { user: string; pass: string };
    pool: false;
    connectionTimeout: number;
    greetingTimeout: number;
    socketTimeout: number;
    tls: { minVersion: string };
  }

  export function createTransport(options: MinimalSmtpTransportOptions): Transporter;
}

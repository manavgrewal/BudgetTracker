'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { isSameOrigin } from '@/lib/auth/csrf';
import { GENERIC_LOGIN_ERROR, attemptLogin } from '@/lib/auth/login';
import { clientIpFromHeaders } from '@/lib/auth/ratelimit';
import { setSessionCookie, shouldUseSecureCookie } from '@/lib/auth/session';

export interface LoginFormState {
  error?: string;
  needsTotp?: boolean;
  username?: string;
}

const CROSS_ORIGIN_ERROR = 'Cross-origin request rejected';

const loginSchema = z.object({
  username: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(1024),
  totpCode: z.string().trim().max(16).optional(),
  recoveryCode: z.string().trim().max(64).optional(),
});

export async function loginAction(prevState: LoginFormState, formData: FormData): Promise<LoginFormState> {
  const requestHeaders = await headers();

  // Binding ruling: every mutating Server Action must call the same-origin check
  // first thing, before any other logic — Next's own built-in Server Action origin
  // check is not a substitute for this app's TRUST_PROXY-aware isSameOrigin.
  if (!isSameOrigin(requestHeaders)) {
    return { error: CROSS_ORIGIN_ERROR, needsTotp: prevState?.needsTotp ?? false, username: prevState?.username };
  }

  const parsed = loginSchema.safeParse({
    username: formData.get('username') ?? '',
    password: formData.get('password') ?? '',
    totpCode: (formData.get('totpCode') as string | null) ?? undefined,
    recoveryCode: (formData.get('recoveryCode') as string | null) ?? undefined,
  });
  if (!parsed.success) {
    // Finding 5 (TOTP-step dead-end): a client-side validation miss at the TOTP
    // step (e.g. the user retyped the code but left the re-entered password
    // blank) must not silently drop the TOTP step's UI — otherwise the code /
    // recovery-code fields vanish and the form reads as an ordinary failed
    // login with no indication a second factor is still expected.
    return { error: GENERIC_LOGIN_ERROR, needsTotp: prevState?.needsTotp ?? false, username: prevState?.username };
  }

  const ip = clientIpFromHeaders(requestHeaders, requestHeaders.get('x-real-ip'));
  const result = await attemptLogin({
    username: parsed.data.username,
    password: parsed.data.password,
    totpCode: parsed.data.totpCode,
    recoveryCode: parsed.data.recoveryCode,
    ip,
    userAgent: requestHeaders.get('user-agent'),
  });

  if (result.status === 'locked') {
    // Ruling (b) asks for a Retry-After header on lockout responses; a Server
    // Action's return value is an RSC payload, not an HTTP Response, so there is
    // no header to set. The same information (rounded the same way: whole
    // minutes from Math.ceil(retryAfterMs / 60000)) is surfaced in the form's
    // error message instead — see task-7-report.md for the full note.
    const minutes = Math.ceil(result.retryAfterMs / 60000);
    return {
      error: `Too many attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
      needsTotp: prevState?.needsTotp ?? false,
      username: parsed.data.username,
    };
  }
  if (result.status === 'totp_required') {
    return { needsTotp: true, username: parsed.data.username };
  }
  if (result.status === 'invalid') {
    // Same dead-end fix as the parse-failure branch above: a wrong TOTP code is
    // also reported via 'invalid' and must not drop the TOTP step's UI either.
    return { error: GENERIC_LOGIN_ERROR, needsTotp: prevState?.needsTotp ?? false, username: parsed.data.username };
  }

  // Controller ruling: pass 'http:' unconditionally. shouldUseSecureCookie's
  // TRUST_PROXY + X-Forwarded-Proto branch (already inside the function) is the
  // sole HTTPS signal here — a Server Action has no raw Request to read a real
  // "direct connection" protocol from, and deriving one from a client-controlled
  // header (as this file previously did via the Origin header) is exactly the
  // kind of client-controlled input shouldUseSecureCookie's own docblock forbids.
  // Net effect: a direct-HTTPS-without-a-reverse-proxy deployment of this app
  // will not get a Secure cookie — the documented path for HTTPS is TRUST_PROXY
  // behind a reverse proxy (see Task 19 / README), not Next terminating TLS itself.
  await setSessionCookie(result.token, result.expiresAt, shouldUseSecureCookie('http:', requestHeaders));
  redirect('/dashboard');
}

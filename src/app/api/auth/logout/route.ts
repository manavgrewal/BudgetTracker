import { CsrfError, assertSameOrigin } from '@/lib/auth/csrf';
import { buildClearedSessionCookieHeader } from '@/lib/auth/cookie-header';
import { SESSION_COOKIE_NAME, destroyAllSessionsForUser, destroySession, validateSession } from '@/lib/auth/session';

function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return null;
}

export async function POST(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);
  } catch (error) {
    if (error instanceof CsrfError) {
      return new Response('Forbidden', { status: 403 });
    }
    throw error;
  }

  const form = await request.formData().catch(() => null);
  const scope = form?.get('scope');
  const token = readCookie(request.headers.get('cookie'), SESSION_COOKIE_NAME);

  if (token) {
    if (scope === 'all') {
      const user = validateSession(token);
      if (user) destroyAllSessionsForUser(user.id);
      else destroySession(token);
    } else {
      destroySession(token);
    }
  }

  return new Response(null, {
    status: 303,
    headers: {
      location: '/login',
      'set-cookie': buildClearedSessionCookieHeader(),
    },
  });
}

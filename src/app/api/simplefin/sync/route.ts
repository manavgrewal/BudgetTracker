import { CsrfError, assertSameOrigin } from '@/lib/auth/csrf';
import { userFromRequest } from '@/lib/auth/session';
import { MAX_SIMPLEFIN_BODY_BYTES, SimplefinError } from '@/lib/simplefin/client';
import { remainingRequestsToday } from '@/lib/simplefin/connection';
import { runSync } from '@/lib/simplefin/sync';

export const dynamic = 'force-dynamic';

/** Manual only: there is no scheduler and nothing calls this on a timer. */
export async function POST(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);
  } catch (error) {
    if (error instanceof CsrfError) return Response.json({ error: 'Forbidden' }, { status: 403 });
    throw error;
  }
  const user = userFromRequest(request);
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  if (user.role !== 'admin') return Response.json({ error: 'Forbidden' }, { status: 403 });

  // This route takes no body today, but reject on the declared size anyway —
  // the same authenticated-memory-DoS defence as its sibling mutating routes,
  // so it stays safe if a body is ever added here.
  const contentLength = Number(request.headers.get('content-length') ?? '');
  if (Number.isFinite(contentLength) && contentLength > MAX_SIMPLEFIN_BODY_BYTES) {
    return Response.json({ error: `Request body is larger than ${MAX_SIMPLEFIN_BODY_BYTES} bytes` }, { status: 413 });
  }

  try {
    const result = await runSync({ userId: user.id });
    return Response.json({ ...result, remainingRequests: remainingRequestsToday() });
  } catch (error) {
    if (error instanceof SimplefinError) return Response.json({ error: error.message, code: error.code }, { status: error.status });
    throw error;
  }
}

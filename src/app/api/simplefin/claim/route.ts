import { z } from 'zod';
import { CsrfError, assertSameOrigin } from '@/lib/auth/csrf';
import { userFromRequest } from '@/lib/auth/session';
import { MAX_SIMPLEFIN_BODY_BYTES, SimplefinError, claimSetupToken } from '@/lib/simplefin/client';
import { saveClaimedConnection } from '@/lib/simplefin/connection';

export const dynamic = 'force-dynamic';

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

  // Reject on the declared size BEFORE json() buffers the whole body — same
  // authenticated-memory-DoS defence as the CSV/pack upload routes.
  const contentLength = Number(request.headers.get('content-length') ?? '');
  if (Number.isFinite(contentLength) && contentLength > MAX_SIMPLEFIN_BODY_BYTES) {
    return Response.json({ error: `Request body is larger than ${MAX_SIMPLEFIN_BODY_BYTES} bytes` }, { status: 413 });
  }

  const parsed = z.object({ setupToken: z.string().min(1).max(4000) }).safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: 'Paste the setup token from your SimpleFIN bridge.' }, { status: 400 });

  try {
    const accessUrl = await claimSetupToken(parsed.data.setupToken);
    const connection = saveClaimedConnection(accessUrl);
    // The access URL is a read-only bank credential — it never leaves the server.
    return Response.json({ claimedAt: connection.claimedAt, enabled: connection.enabled });
  } catch (error) {
    if (error instanceof SimplefinError) return Response.json({ error: error.message, code: error.code }, { status: error.status });
    throw error;
  }
}

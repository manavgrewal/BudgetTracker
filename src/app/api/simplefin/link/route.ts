import { z } from 'zod';
import { CsrfError, assertSameOrigin } from '@/lib/auth/csrf';
import { userFromRequest } from '@/lib/auth/session';
import { getAccount } from '@/lib/accounts';
import { MAX_SIMPLEFIN_BODY_BYTES, SimplefinError } from '@/lib/simplefin/client';
import { linkAccount, listLinks, unlinkAccount } from '@/lib/simplefin/connection';

export const dynamic = 'force-dynamic';

const bodySchema = z.union([
  z.object({ action: z.literal('link'), simplefinAccountId: z.string().min(1).max(200), accountId: z.number().int().positive(), currency: z.string().min(1).max(8) }),
  z.object({ action: z.literal('unlink'), simplefinAccountId: z.string().min(1).max(200) }),
]);

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

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: 'Invalid request.' }, { status: 400 });

  if (parsed.data.action === 'unlink') {
    unlinkAccount(parsed.data.simplefinAccountId);
    return Response.json({ links: listLinks(), csvRestored: true });
  }

  const account = getAccount(parsed.data.accountId);
  if (!account) return Response.json({ error: 'Unknown account.' }, { status: 404 });

  try {
    linkAccount(parsed.data);
  } catch (error) {
    if (error instanceof SimplefinError) return Response.json({ error: error.message }, { status: error.status });
    throw error;
  }

  const currency = parsed.data.currency.toUpperCase();
  return Response.json({
    links: listLinks(),
    csvDisabled: true,
    warning: `"${account.name}" is now synced from SimpleFIN, so CSV import is disabled for it. Unlink it here to switch back.`,
    currencyWarning: currency === 'CAD' ? null : `This account reports ${currency}; this app stores CAD cents with no conversion.`,
  });
}

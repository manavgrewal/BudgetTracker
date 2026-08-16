import fs from 'node:fs';
import { isSameOriginOrHeaderless } from '@/lib/auth/csrf';
import { userFromRequest } from '@/lib/auth/session';
import { createOnDemandBackup } from '@/lib/backup';
import { todayIso } from '@/lib/dates';

export const dynamic = 'force-dynamic';

/**
 * Admin only, and the origin is checked even though this is a GET (the generic
 * assertSameOrigin() only guards non-safe methods, so it would be a no-op
 * here): a forged cross-origin navigation must not trigger an authenticated
 * download of the whole database.
 *
 * The check is isSameOriginOrHeaderless(), not isSameOrigin() — controller
 * ruling, superseding the original "ruling (a)" strictness on this route. A
 * present-but-mismatched Origin/Sec-Fetch-Site is still refused; a request
 * carrying NEITHER header is allowed, because that is exactly what this page's
 * own download link produces on the documented default deployment (plain HTTP
 * on the LAN, where browsers send no Origin on a navigation and omit
 * Sec-Fetch-* on non-trustworthy origins). See the helper's docblock.
 */
export async function GET(request: Request): Promise<Response> {
  if (!isSameOriginOrHeaderless(request.headers)) return new Response('Forbidden', { status: 403 });

  const user = userFromRequest(request);
  if (!user) return new Response('Unauthorized', { status: 401 });
  if (user.role !== 'admin') return new Response('Forbidden', { status: 403 });

  const { path: file } = createOnDemandBackup();
  try {
    // Read then unlink: /data/tmp must not accumulate copies of the database.
    const body = fs.readFileSync(file);
    return new Response(new Uint8Array(body), {
      status: 200,
      headers: {
        'content-type': 'application/octet-stream',
        'content-length': String(body.length),
        'content-disposition': `attachment; filename="budget-${todayIso()}.db"`,
        'cache-control': 'no-store',
      },
    });
  } catch {
    return new Response('Backup failed', { status: 500 });
  } finally {
    fs.rmSync(file, { force: true });
  }
}

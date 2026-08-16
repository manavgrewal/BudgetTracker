import fs from 'node:fs';
import { isSameOrigin } from '@/lib/auth/csrf';
import { userFromRequest } from '@/lib/auth/session';
import { createOnDemandBackup } from '@/lib/backup';
import { todayIso } from '@/lib/dates';

export const dynamic = 'force-dynamic';

/**
 * Controller ruling (a): same-origin + admin only. This is a GET, so the
 * generic assertSameOrigin() (which only guards non-safe methods) would be a
 * no-op here — a forged same-site-looking <img>/navigation from another origin
 * must not be able to trigger an authenticated database download, so the
 * origin/fetch-metadata check is enforced explicitly for this route.
 */
export async function GET(request: Request): Promise<Response> {
  if (!isSameOrigin(request.headers)) return new Response('Forbidden', { status: 403 });

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

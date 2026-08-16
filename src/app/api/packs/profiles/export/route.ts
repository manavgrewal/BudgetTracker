import { isSameOrigin } from '@/lib/auth/csrf';
import { userFromRequest } from '@/lib/auth/session';
import { PROFILES_PACK_FORMAT, exportProfilesPack, packFilename } from '@/lib/packs';

export const dynamic = 'force-dynamic';

/** Controller ruling (b): same-origin + admin — see rules/export/route.ts for why a GET needs this explicitly. */
export async function GET(request: Request): Promise<Response> {
  if (!isSameOrigin(request.headers)) return new Response('Forbidden', { status: 403 });

  const user = userFromRequest(request);
  if (!user) return new Response('Unauthorized', { status: 401 });
  if (user.role !== 'admin') return new Response('Forbidden', { status: 403 });

  const raw = new URL(request.url).searchParams.get('ids');
  const profileIds = (raw ?? '')
    .split(',')
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isInteger(value) && value > 0);

  const pack = exportProfilesPack(profileIds.length > 0 ? { profileIds } : {});
  return new Response(JSON.stringify(pack, null, 2), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="${packFilename(PROFILES_PACK_FORMAT)}"`,
      'cache-control': 'no-store',
    },
  });
}

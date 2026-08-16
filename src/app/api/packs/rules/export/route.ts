import { isSameOriginOrHeaderless } from '@/lib/auth/csrf';
import { userFromRequest } from '@/lib/auth/session';
import { exportRulesPack, packFilename, RULES_PACK_FORMAT } from '@/lib/packs';

export const dynamic = 'force-dynamic';

/**
 * Controller ruling (b): origin-checked + admin on every pack route. This is a
 * GET, so the generic assertSameOrigin() (which only guards non-safe methods)
 * would be a no-op — matching the backup/download precedent, the check is
 * enforced explicitly so a forged cross-origin navigation/link can't trigger an
 * authenticated household-data download.
 *
 * The check is the download-GET variant, isSameOriginOrHeaderless(): a
 * mismatched Origin/Sec-Fetch-Site is refused, a request carrying neither is
 * allowed (a plain-HTTP LAN install's own export link sends neither). See the
 * helper's docblock. The pack IMPORT routes are POSTs and stay strict.
 */
export async function GET(request: Request): Promise<Response> {
  if (!isSameOriginOrHeaderless(request.headers)) return new Response('Forbidden', { status: 403 });

  const user = userFromRequest(request);
  if (!user) return new Response('Unauthorized', { status: 401 });
  if (user.role !== 'admin') return new Response('Forbidden', { status: 403 });

  const params = new URL(request.url).searchParams;
  const includeTransferRules = params.get('includeTransfers') === '1';
  const excludeRuleIds = (params.get('exclude') ?? '')
    .split(',')
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isInteger(value) && value > 0);

  const pack = exportRulesPack({ includeTransferRules, excludeRuleIds });
  return new Response(JSON.stringify(pack, null, 2), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="${packFilename(RULES_PACK_FORMAT)}"`,
      'cache-control': 'no-store',
    },
  });
}

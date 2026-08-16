import { isSameOriginOrHeaderless } from '@/lib/auth/csrf';
import { userFromRequest } from '@/lib/auth/session';
import { SimplefinError, fetchAccounts } from '@/lib/simplefin/client';
import { assertRequestBudget, consumeRequest, getAccessUrl, getConnection, listLinks, remainingRequestsToday } from '@/lib/simplefin/connection';
import { syncWindow } from '@/lib/simplefin/sync';

export const dynamic = 'force-dynamic';

/**
 * Lists the remote accounts so the admin can map them. Costs one request against the budget.
 *
 * This is a GET, so the generic assertSameOrigin() (which only guards non-safe
 * methods) would be a no-op here — a forged cross-origin request must not be
 * able to spend part of the daily SimpleFIN budget, so the origin check is
 * enforced explicitly, same as api/backup/download/route.ts.
 *
 * Also the same variant, isSameOriginOrHeaderless(): a present-but-mismatched
 * Origin/Sec-Fetch-Site is refused; a header-less request is allowed, because
 * that is what the Connections page's own fetch produces on a plain-HTTP LAN
 * install (browsers send no Origin on a same-origin GET and omit Sec-Fetch-* on
 * non-trustworthy origins). Admin-only auth is unchanged, and every mutating
 * SimpleFIN route (claim, link, sync) keeps the strict assertSameOrigin().
 */
export async function GET(request: Request): Promise<Response> {
  if (!isSameOriginOrHeaderless(request.headers)) return Response.json({ error: 'Forbidden' }, { status: 403 });

  const user = userFromRequest(request);
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  if (user.role !== 'admin') return Response.json({ error: 'Forbidden' }, { status: 403 });

  const connection = getConnection();
  const accessUrl = getAccessUrl();
  if (!connection || accessUrl === null) return Response.json({ error: 'No SimpleFIN connection is configured yet.' }, { status: 409 });

  try {
    assertRequestBudget();
    const window = syncWindow({ lastSyncAt: connection.lastSyncAt });
    consumeRequest();
    const set = await fetchAccounts({ accessUrl, startDate: window.startDate, endDate: window.endDate });
    return Response.json({
      accounts: set.accounts.map((account) => ({ id: account.id, name: account.name, currency: account.currency, balance: account.balance })),
      errlist: set.errlist,
      links: listLinks(),
      remainingRequests: remainingRequestsToday(),
    });
  } catch (error) {
    if (error instanceof SimplefinError) return Response.json({ error: error.message, code: error.code }, { status: error.status });
    throw error;
  }
}

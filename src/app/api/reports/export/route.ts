import { isSameOriginOrHeaderless } from '@/lib/auth/csrf';
import { userFromRequest } from '@/lib/auth/session';
import { transactionsCsv } from '@/lib/reports';
import { todayIso } from '@/lib/dates';
import { resolveRange } from '@/lib/date-range';
import { readEnv } from '@/lib/env';
import type { TransactionFilter } from '@/lib/transactions';

/**
 * Session required, and the origin is checked even though a GET is normally
 * CSRF-exempt: this one streams every transaction the household has, so a
 * request whose headers positively identify another origin is refused.
 *
 * isSameOriginOrHeaderless(), same as /api/backup/download — a header-less
 * request is allowed because the Export CSV link produces exactly that on a
 * plain-HTTP LAN install. See the helper's docblock for the ruling.
 */
export async function GET(request: Request): Promise<Response> {
  if (!isSameOriginOrHeaderless(request.headers)) return new Response('Forbidden', { status: 403 });

  const user = userFromRequest(request);
  if (!user) return new Response('Unauthorized', { status: 401 });

  const params = new URL(request.url).searchParams;
  const num = (key: string) => {
    const value = params.get(key);
    return value && /^\d+$/.test(value) ? Number(value) : null;
  };
  const person = params.get('person');
  const category = params.get('category');

  // MUST-13.9: the SAME helper and the SAME fallback the Transactions page uses, so a link
  // carrying range=last_3_months exports the same three months the page is showing.
  // MUST-13.10: fallback null rather than Reports' last_6_months, because this route serves
  // both pages' links and rangeParams() guarantees the caller's parameters are explicit.
  const range = resolveRange({
    preset: params.get('range'),
    from: params.get('from'),
    to: params.get('to'),
    today: todayIso(new Date(), readEnv().tz),
    fallback: null,
  });

  const filter: TransactionFilter = {
    accountId: num('account'),
    categoryId: category === 'uncategorized' ? 'uncategorized' : category && /^\d+$/.test(category) ? Number(category) : null,
    attributedUserId: person === 'unattributed' ? 'unattributed' : person && /^\d+$/.test(person) ? Number(person) : null,
    from: range?.from ?? null,
    to: range?.to ?? null,
    search: params.get('q'),
    uncategorizedOnly: params.get('uncat') === '1',
    includeTransfers: params.get('transfers') !== '0',
  };

  const csv = transactionsCsv(filter);
  return new Response(csv, {
    status: 200,
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="budget-transactions-${todayIso()}.csv"`,
      'cache-control': 'no-store',
    },
  });
}

import { userFromRequest } from '@/lib/auth/session';
import { transactionsCsv } from '@/lib/reports';
import { todayIso } from '@/lib/dates';
import type { TransactionFilter } from '@/lib/transactions';

export async function GET(request: Request): Promise<Response> {
  // GET is a safe method, so no Origin check — but it still requires a session.
  const user = userFromRequest(request);
  if (!user) return new Response('Unauthorized', { status: 401 });

  const params = new URL(request.url).searchParams;
  const num = (key: string) => {
    const value = params.get(key);
    return value && /^\d+$/.test(value) ? Number(value) : null;
  };
  const person = params.get('person');
  const category = params.get('category');

  const filter: TransactionFilter = {
    accountId: num('account'),
    categoryId: category === 'uncategorized' ? 'uncategorized' : category && /^\d+$/.test(category) ? Number(category) : null,
    attributedUserId: person === 'unattributed' ? 'unattributed' : person && /^\d+$/.test(person) ? Number(person) : null,
    from: params.get('from'),
    to: params.get('to'),
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

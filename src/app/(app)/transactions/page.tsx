import { requireUser } from '@/lib/auth/session';
import { listAccounts } from '@/lib/accounts';
import { listCategories } from '@/lib/categories';
import { listUsers } from '@/lib/auth/users';
import { listTransactions, type TransactionFilter } from '@/lib/transactions';
import { todayIso } from '@/lib/dates';
import { TransactionsClient } from './transactions-client';

export const dynamic = 'force-dynamic';

function readFilter(params: Record<string, string | string[] | undefined>): TransactionFilter {
  const one = (key: string) => {
    const value = params[key];
    return Array.isArray(value) ? value[0] : value;
  };
  const num = (key: string) => {
    const value = one(key);
    return value && /^\d+$/.test(value) ? Number(value) : undefined;
  };
  const person = one('person');
  const category = one('category');
  return {
    accountId: num('account') ?? null,
    categoryId: category === 'uncategorized' ? 'uncategorized' : category && /^\d+$/.test(category) ? Number(category) : null,
    attributedUserId: person === 'unattributed' ? 'unattributed' : person && /^\d+$/.test(person) ? Number(person) : null,
    from: one('from') ?? null,
    to: one('to') ?? null,
    search: one('q') ?? null,
    uncategorizedOnly: one('uncat') === '1',
    includeTransfers: one('transfers') !== '0',
    page: num('page') ?? 1,
    pageSize: 50,
  };
}

export default async function TransactionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireUser();
  const params = await searchParams;
  const filter = readFilter(params);
  return (
    <TransactionsClient
      page={listTransactions(filter)}
      accounts={listAccounts().map((a) => ({ id: a.id, name: a.name }))}
      // Archived categories are included here (not just listCategories()) so a row whose
      // category was later archived can still render its real name on the per-row select
      // and keep it as the initial selection instead of silently falling back to
      // "Uncategorized" — see TransactionsClient's activeCategories split.
      categories={listCategories({ includeArchived: true }).map((c) => ({ id: c.id, name: c.name, parentId: c.parentId, isArchived: c.isArchived }))}
      people={listUsers().map((u) => ({ id: u.id, name: u.name }))}
      today={todayIso()}
    />
  );
}

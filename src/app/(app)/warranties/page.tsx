import { requireUser } from '@/lib/auth/session';
import { listUsers } from '@/lib/auth/users';
import { todayIso } from '@/lib/dates';
import { isWarrantyStatus } from '@/lib/warranty/expiry';
import { isWarrantySort, searchWarrantyItems } from '@/lib/warranty/search';
import { listItemTypes } from '@/lib/warranty/types';
import { WarrantiesClient } from './warranties-client';

export const dynamic = 'force-dynamic';

export default async function WarrantiesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireUser();
  const params = await searchParams;
  const one = (key: string) => {
    const value = params[key];
    return (Array.isArray(value) ? value[0] : value) ?? '';
  };

  const query = one('q');
  const status = one('status');
  const owner = one('owner');
  const typeId = one('typeId');
  const sortRaw = one('sort');
  const sort = isWarrantySort(sortRaw) ? sortRaw : 'expiry';
  const page = /^\d+$/.test(one('page')) ? Number(one('page')) : 1;
  const today = todayIso();

  const result = searchWarrantyItems({
    q: query,
    status: isWarrantyStatus(status) ? status : null,
    ownerUserId: /^\d+$/.test(owner) ? Number(owner) : null,
    // Delta T9: composes with q/status/owner/sort like every other filter.
    typeId: /^\d+$/.test(typeId) ? Number(typeId) : null,
    sort,
    page,
    today,
  });

  return (
    <WarrantiesClient
      result={result}
      people={listUsers().filter((u) => u.isActive).map((u) => ({ id: u.id, name: u.name }))}
      types={listItemTypes().map((t) => ({ id: t.id, name: t.name, kind: t.kind }))}
      today={today}
      query={query}
      status={status}
      owner={owner}
      typeId={typeId}
      sort={sort}
    />
  );
}

import { requireAdmin } from '@/lib/auth/session';
import { listItemTypesWithUsage } from '@/lib/warranty/types';
import { ItemTypesManager } from './item-types-manager';

export const dynamic = 'force-dynamic';

export default async function ItemTypesPage() {
  await requireAdmin();
  return <ItemTypesManager types={listItemTypesWithUsage()} />;
}

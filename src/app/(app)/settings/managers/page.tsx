import { requireAdmin } from '@/lib/auth/session';
import { listCategories } from '@/lib/categories';
import { listRules } from '@/lib/categorize/rules';
import { listProfiles } from '@/lib/import/presets';
import { ManagersClient } from './managers-client';

export const dynamic = 'force-dynamic';

export default async function ManagersPage() {
  await requireAdmin();
  return (
    <ManagersClient
      categories={listCategories({ includeArchived: true })}
      rules={listRules()}
      profiles={listProfiles()}
    />
  );
}

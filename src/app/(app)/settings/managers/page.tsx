import { requireAdmin } from '@/lib/auth/session';
import { listCategories } from '@/lib/categories';
import { listRules } from '@/lib/categorize/rules';
import { getProfileUsage, listProfiles, type ProfileUsage } from '@/lib/import/presets';
import { previewProfilesPackExport, previewRulesPackExport } from '@/lib/packs';
import { ManagersClient } from './managers-client';

export const dynamic = 'force-dynamic';

export default async function ManagersPage() {
  await requireAdmin();
  const profiles = listProfiles();
  // Read path for the delete confirm step: the confirm text
  // must say what a delete will do BEFORE the admin commits to it, so these counts come from
  // getProfileUsage() here, not from whatever deleteProfile() last returned.
  const profileUsage: Record<number, ProfileUsage> = {};
  for (const profile of profiles) {
    if (!profile.isBuiltin) profileUsage[profile.id] = getProfileUsage(profile.id);
  }
  return (
    <ManagersClient
      categories={listCategories({ includeArchived: true })}
      rules={listRules()}
      profiles={profiles}
      profileUsage={profileUsage}
      rulesPackRows={previewRulesPackExport({ includeTransferRules: true })}
      profilePackRows={previewProfilesPackExport()}
    />
  );
}

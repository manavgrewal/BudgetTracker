import { requireUser } from '@/lib/auth/session';
import { listAccounts } from '@/lib/accounts';
import { listProfiles } from '@/lib/import/presets';
import { listImportHistory } from '@/lib/import/commit';
import { isSimplefinManaged } from '@/lib/simplefin/connection';
import { ImportClient } from './import-client';

export const dynamic = 'force-dynamic';

export default async function ImportPage() {
  await requireUser();
  const allAccounts = listAccounts();
  const csvAccounts = allAccounts.filter((a) => !isSimplefinManaged(a.id));
  const managed = allAccounts.filter((a) => isSimplefinManaged(a.id));
  return (
    <ImportClient
      accounts={csvAccounts.map((a) => ({ id: a.id, name: a.name, importProfileId: a.importProfileId }))}
      profiles={listProfiles().map((p) => ({ id: p.id, name: p.name, isBuiltin: p.isBuiltin, mapping: p.mapping }))}
      history={listImportHistory(25)}
      simplefinManaged={managed.map((a) => a.name)}
    />
  );
}

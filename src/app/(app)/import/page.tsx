import { requireUser } from '@/lib/auth/session';
import { listAccounts } from '@/lib/accounts';
import { listProfiles } from '@/lib/import/presets';
import { listImportHistory } from '@/lib/import/commit';
import { ImportClient } from './import-client';

export const dynamic = 'force-dynamic';

export default async function ImportPage() {
  await requireUser();
  return (
    <ImportClient
      accounts={listAccounts().map((a) => ({ id: a.id, name: a.name, importProfileId: a.importProfileId }))}
      profiles={listProfiles().map((p) => ({ id: p.id, name: p.name, isBuiltin: p.isBuiltin, mapping: p.mapping }))}
      history={listImportHistory(25)}
    />
  );
}

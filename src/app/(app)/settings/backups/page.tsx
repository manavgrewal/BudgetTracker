import { requireAdmin } from '@/lib/auth/session';
import { getBackupRetention, listBackups } from '@/lib/backup';
import { BackupsClient } from './backups-client';

export const dynamic = 'force-dynamic';

export default async function BackupsPage() {
  await requireAdmin();
  return <BackupsClient backups={listBackups()} retention={getBackupRetention()} />;
}

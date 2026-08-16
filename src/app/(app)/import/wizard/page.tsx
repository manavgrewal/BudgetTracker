import { requireUser } from '@/lib/auth/session';
import { getBuiltinPreset } from '@/lib/import/presets';
import { WizardClient } from './wizard-client';

export const dynamic = 'force-dynamic';

export default async function ImportWizardPage() {
  await requireUser();
  return <WizardClient starterMapping={getBuiltinPreset('Scotiabank Chequing/Debit')} />;
}

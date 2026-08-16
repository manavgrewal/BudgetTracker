import { redirect } from 'next/navigation';
import { isSetupRequired } from '@/lib/auth/login';
import { SetupForm } from './setup-form';

export default function SetupPage() {
  if (!isSetupRequired()) redirect('/login');
  return <SetupForm />;
}

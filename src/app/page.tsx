import { redirect } from 'next/navigation';
import { isSetupRequired } from '@/lib/auth/login';

export const dynamic = 'force-dynamic';

export default function Home() {
  redirect(isSetupRequired() ? '/setup' : '/dashboard');
}

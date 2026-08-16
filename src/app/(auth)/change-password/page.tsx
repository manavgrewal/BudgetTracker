import { redirect } from 'next/navigation';
import { MIN_PASSWORD_LENGTH } from '@/lib/auth/password';
import { requireUser } from '@/lib/auth/session';
import { mustChangePassword } from '@/lib/auth/users';
import { ChangePasswordForm } from './change-password-form';

export const dynamic = 'force-dynamic';

/**
 * The forced-change interstitial (spec v1.5). It lives in the (auth) group, not (app):
 * the app layout is the thing that redirects here, so rendering under that layout would
 * be an infinite bounce. A full session is still required — the middleware's no-cookie
 * redirect covers the anonymous case, and requireUser() covers an expired one.
 */
export default async function ChangePasswordPage() {
  const user = await requireUser();
  // Nothing to force: send them where they were going. This also makes the page
  // harmless as a bookmark — Settings → Profile is the route for a voluntary change.
  if (!mustChangePassword(user.id)) redirect('/dashboard');
  return <ChangePasswordForm name={user.name} minLength={MIN_PASSWORD_LENGTH} />;
}

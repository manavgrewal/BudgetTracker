import { redirect } from 'next/navigation';
import { requireUser } from '@/lib/auth/session';
import { mustChangePassword } from '@/lib/auth/users';
import { reviewQueueCount } from '@/lib/categorize/engine';
import { APP_VERSION } from '@/lib/version';
import { AppShell } from '@/components/app-shell/AppShell';

export const dynamic = 'force-dynamic';

/**
 * Forced password change (spec v1.5) is gated HERE — at the page layer only, on purpose.
 *
 * /api/* routes keep working normally under the same session. The flag's threat model is
 * "an admin knows this password", not "this session is compromised": it is a UX nudge to
 * replace an admin-issued secret, not a session invalidation. An admin who wanted the
 * session dead already has Deactivate and Reset password (both of which really do destroy
 * every session). Gating the APIs too would buy nothing against that threat while breaking
 * the logout POST and every in-flight fetch for no security gain.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  if (mustChangePassword(user.id)) redirect('/change-password');
  const reviewCount = reviewQueueCount();
  return (
    <AppShell user={{ name: user.name, role: user.role }} reviewCount={reviewCount} version={APP_VERSION}>
      {children}
    </AppShell>
  );
}

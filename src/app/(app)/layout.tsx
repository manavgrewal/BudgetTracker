import Link from 'next/link';
import { redirect } from 'next/navigation';
import { requireUser } from '@/lib/auth/session';
import { mustChangePassword } from '@/lib/auth/users';
import { reviewQueueCount } from '@/lib/categorize/engine';
import { APP_VERSION } from '@/lib/version';

export const dynamic = 'force-dynamic';

const NAV = [
  { href: '/dashboard', label: 'Dashboard' },
  { href: '/transactions', label: 'Transactions' },
  { href: '/review', label: 'Review' },
  { href: '/import', label: 'Import' },
  { href: '/budgets', label: 'Budgets' },
  { href: '/goals', label: 'Goals' },
  { href: '/reports', label: 'Reports' },
  { href: '/settings', label: 'Settings' },
];

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
    <div className="min-h-screen">
      <header className="border-b border-slate-200 dark:border-slate-800">
        <nav className="mx-auto flex max-w-6xl flex-wrap items-center gap-4 px-4 py-3 text-sm">
          <span className="font-semibold">Budget Tracker</span>
          {NAV.map((item) => (
            <Link key={item.href} href={item.href} className="text-slate-600 hover:underline dark:text-slate-300">
              {item.label}
              {item.href === '/review' && reviewCount > 0 ? (
                <span className="ml-1 rounded-full bg-amber-500 px-1.5 text-xs text-white">{reviewCount}</span>
              ) : null}
            </Link>
          ))}
          <form action="/api/auth/logout" method="post" className="ml-auto flex items-center gap-3">
            <span className="text-slate-500">{user.name}</span>
            <button type="submit" className="text-slate-600 hover:underline dark:text-slate-300">
              Sign out
            </button>
          </form>
        </nav>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
      {/* Which build am I looking at? — the first question of any support conversation.
          Settings → About has the same number plus the full revision log. */}
      <footer className="mx-auto max-w-6xl px-4 pb-6 text-xs text-slate-500 dark:text-slate-400">
        Budget Tracker v{APP_VERSION} · <Link className="underline" href="/settings">what&rsquo;s new</Link>
      </footer>
    </div>
  );
}

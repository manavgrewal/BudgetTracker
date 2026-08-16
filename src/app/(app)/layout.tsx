import Link from 'next/link';
import { requireUser } from '@/lib/auth/session';
import { reviewQueueCount } from '@/lib/categorize/engine';

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

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
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
    </div>
  );
}

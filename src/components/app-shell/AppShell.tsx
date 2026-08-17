'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { ChevronDownIcon, CloseIcon, LogoMark, MenuIcon, SettingsIcon, SignOutIcon } from '@/components/icons';
import { ThemeToggle } from '@/components/theme/theme-toggle';
import { activeNavItem, NAV, type NavItem } from './nav';

export interface ShellUser {
  name: string;
  role: 'admin' | 'member';
}

/**
 * The application chrome: a fixed navigation rail on desktop, a top bar with a
 * disclosure menu on phones, and a sticky header carrying page context, the
 * theme control and the account menu.
 *
 * It is a client component because the active section, the mobile menu and the
 * account menu all depend on the current path and on interaction; the server
 * layout above it keeps doing the auth work and hands `children` down as a
 * slot, so pages stay server-rendered.
 */
export function AppShell({
  user,
  reviewCount,
  version,
  children,
}: {
  user: ShellUser;
  reviewCount: number;
  version: string;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);
  const current = activeNavItem(pathname);

  // Navigating is the implicit "close the menu" gesture on a phone.
  useEffect(() => {
    setMenuOpen(false);
  }, [pathname]);

  return (
    <div className="min-h-screen">
      {/* Keyboard users should not have to tab the whole rail on every page. */}
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-surface focus:px-3 focus:py-2 focus:text-sm focus:shadow-pop"
      >
        Skip to content
      </a>

      <aside className="fixed inset-y-0 left-0 z-40 hidden w-64 flex-col border-r border-line bg-surface lg:flex">
        <Link
          href="/dashboard"
          className="flex h-16 shrink-0 items-center gap-2.5 px-5 text-ink"
          aria-label="Budget Tracker home"
        >
          <LogoMark className="h-8 w-8" />
          <span className="text-[0.9375rem] font-semibold tracking-tight">Budget Tracker</span>
        </Link>
        <nav aria-label="Sections" className="flex-1 overflow-y-auto px-3 pb-4">
          <NavList items={NAV} pathname={pathname} reviewCount={reviewCount} rail />
        </nav>
      </aside>

      <div className="flex min-h-screen flex-col lg:pl-64">
        <header className="sticky top-0 z-30 flex h-16 shrink-0 items-center gap-2 border-b border-line bg-canvas/85 px-4 backdrop-blur-md sm:px-6 lg:px-8">
          <button
            type="button"
            onClick={() => setMenuOpen((open) => !open)}
            aria-expanded={menuOpen}
            aria-controls="mobile-nav"
            aria-label={menuOpen ? 'Close menu' : 'Open menu'}
            className="btn btn--ghost -ml-1.5 p-2 lg:hidden"
          >
            {menuOpen ? <CloseIcon className="h-5 w-5" /> : <MenuIcon className="h-5 w-5" />}
          </button>

          <Link href="/dashboard" className="flex items-center gap-2 lg:hidden" aria-label="Budget Tracker home">
            <LogoMark className="h-7 w-7" />
          </Link>

          <div className="flex min-w-0 flex-1 items-center gap-2">
            <span className="truncate text-[0.9375rem] font-semibold text-ink">{current?.label ?? 'Budget Tracker'}</span>
          </div>

          <ThemeToggle />
          <UserMenu user={user} />
        </header>

        {menuOpen ? (
          <div id="mobile-nav" className="border-b border-line bg-surface px-3 py-3 shadow-card lg:hidden">
            <nav aria-label="Sections">
              <NavList items={NAV} pathname={pathname} reviewCount={reviewCount} />
            </nav>
          </div>
        ) : null}

        <main id="main" className="mx-auto w-full max-w-6xl flex-1 px-4 py-7 sm:px-6 sm:py-9 lg:px-8">
          {children}
        </main>

        {/* Which build am I looking at? — the first question of any support conversation.
            Settings → About has the same number plus the full revision log. */}
        <footer className="mx-auto w-full max-w-6xl px-4 pb-8 text-xs text-subtle sm:px-6 lg:px-8">
          Budget Tracker v{version} ·{' '}
          <Link className="text-accent-text underline underline-offset-2" href="/settings">
            what&rsquo;s new
          </Link>
        </footer>
      </div>
    </div>
  );
}

function NavList({
  items,
  pathname,
  reviewCount,
  rail = false,
}: {
  items: NavItem[];
  pathname: string;
  reviewCount: number;
  /** The desktop rail draws an accent bar on the sheet edge; the phone menu does not. */
  rail?: boolean;
}) {
  const active = activeNavItem(pathname);
  return (
    <ul className="flex flex-col gap-0.5">
      {items.map((item) => {
        const isActive = active?.href === item.href;
        const badge = item.href === '/review' && reviewCount > 0 ? reviewCount : null;
        return (
          <li key={item.href}>
            <Link
              href={item.href}
              aria-current={isActive ? 'page' : undefined}
              className={`relative flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors ${
                isActive
                  ? 'bg-accent-soft font-semibold text-accent-soft-fg'
                  : 'font-medium text-muted hover:bg-surface-2 hover:text-ink'
              }`}
            >
              {isActive && rail ? (
                <span
                  aria-hidden="true"
                  className="absolute -left-3 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r-full bg-accent"
                />
              ) : null}
              <item.Icon className={`h-[1.15rem] w-[1.15rem] shrink-0 ${isActive ? 'text-accent-text' : 'text-subtle'}`} />
              <span className="flex-1 truncate">{item.label}</span>
              {badge !== null ? (
                <span className="badge badge--amber tabnum" aria-label={`${badge} to review`}>
                  {badge}
                </span>
              ) : null}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

function UserMenu({ user }: { user: ShellUser }) {
  const [open, setOpen] = useState(false);
  const wrapper = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent | TouchEvent) {
      if (wrapper.current && !wrapper.current.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const initial = user.name.trim().charAt(0).toUpperCase() || '?';

  return (
    <div className="relative" ref={wrapper}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="btn btn--ghost gap-2 rounded-full py-1 pl-1 pr-2"
      >
        <span
          aria-hidden="true"
          className="flex h-7 w-7 items-center justify-center rounded-full bg-accent-soft text-xs font-semibold text-accent-soft-fg"
        >
          {initial}
        </span>
        <span className="hidden max-w-[9rem] truncate text-sm sm:inline">{user.name}</span>
        <ChevronDownIcon className="h-4 w-4 text-subtle" />
      </button>

      {open ? (
        <div
          role="menu"
          aria-label="Account"
          className="absolute right-0 z-50 mt-2 w-56 rounded-lg border border-line bg-surface p-1.5 shadow-pop"
        >
          <div className="px-2.5 py-2">
            <p className="truncate text-sm font-semibold text-ink">{user.name}</p>
            <p className="text-xs text-subtle">{user.role === 'admin' ? 'Administrator' : 'Member'}</p>
          </div>
          <div className="my-1 h-px bg-line" />
          <Link
            href="/settings"
            role="menuitem"
            className="flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm text-muted hover:bg-surface-2 hover:text-ink"
          >
            <SettingsIcon className="h-4 w-4" />
            Settings
          </Link>
          <form action="/api/auth/logout" method="post">
            <button
              type="submit"
              role="menuitem"
              className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm text-muted hover:bg-surface-2 hover:text-ink"
            >
              <SignOutIcon className="h-4 w-4" />
              Sign out
            </button>
          </form>
        </div>
      ) : null}
    </div>
  );
}

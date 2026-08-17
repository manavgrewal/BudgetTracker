// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { AppShell } from '@/components/app-shell/AppShell';

vi.mock('next/navigation', () => ({
  usePathname: () => '/dashboard',
}));

afterEach(() => {
  cleanup();
  document.body.style.overflow = '';
});

const user = { name: 'Ada Lovelace', role: 'member' as const };

describe('AppShell mobile menu (regression: opened off-screen at the document top when scrolled)', () => {
  it('anchors the panel to the viewport, not the document, so it stays visible however far the page has scrolled', () => {
    render(
      <AppShell user={user} reviewCount={0} version="1.2.3">
        <p>content</p>
      </AppShell>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));

    const panel = document.getElementById('mobile-nav');
    expect(panel).toBeTruthy();
    // `fixed` (not `absolute`/static) is what keeps the panel pinned to the
    // viewport instead of at its position in the scrolled document.
    expect(panel!.className).toContain('fixed');
    expect(panel!.className).not.toContain('absolute');
  });

  it('locks body scroll while open and restores it on close', () => {
    render(
      <AppShell user={user} reviewCount={0} version="1.2.3">
        <p>content</p>
      </AppShell>,
    );

    expect(document.body.style.overflow).toBe('');

    const button = screen.getByRole('button', { name: 'Open menu' });
    fireEvent.click(button);
    expect(document.body.style.overflow).toBe('hidden');

    fireEvent.click(screen.getByRole('button', { name: 'Close menu' }));
    expect(document.body.style.overflow).toBe('');
  });

  it('closes on Escape and returns focus to the toggle button', () => {
    render(
      <AppShell user={user} reviewCount={0} version="1.2.3">
        <p>content</p>
      </AppShell>,
    );

    const button = screen.getByRole('button', { name: 'Open menu' });
    fireEvent.click(button);
    expect(document.getElementById('mobile-nav')).toBeTruthy();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(document.getElementById('mobile-nav')).toBeFalsy();
    expect(document.activeElement).toBe(button);
  });

  it('closes on an outside tap', () => {
    render(
      <AppShell user={user} reviewCount={0} version="1.2.3">
        <p>content</p>
      </AppShell>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));
    expect(document.getElementById('mobile-nav')).toBeTruthy();

    fireEvent.mouseDown(document.body);
    expect(document.getElementById('mobile-nav')).toBeFalsy();
  });

  it('closes when a nav link inside the panel is clicked', () => {
    render(
      <AppShell user={user} reviewCount={0} version="1.2.3">
        <p>content</p>
      </AppShell>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));
    const panel = document.getElementById('mobile-nav') as HTMLElement;
    const link = panel.querySelector('a[href="/budgets"]') as HTMLAnchorElement;
    fireEvent.click(link);

    expect(document.getElementById('mobile-nav')).toBeFalsy();
  });

  it('keeps aria-expanded and aria-controls wired to the toggle button', () => {
    render(
      <AppShell user={user} reviewCount={0} version="1.2.3">
        <p>content</p>
      </AppShell>,
    );

    const button = screen.getByRole('button', { name: 'Open menu' });
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(button.getAttribute('aria-controls')).toBe('mobile-nav');

    fireEvent.click(button);
    expect(screen.getByRole('button', { name: 'Close menu' }).getAttribute('aria-expanded')).toBe('true');
  });
});

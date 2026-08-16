// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { render, cleanup } from '@testing-library/react';
import { AboutPanel } from '@/app/(app)/settings/about-panel';
import { APP_VERSION } from '@/lib/version';

afterEach(() => {
  cleanup();
  delete process.env.BUDGET_CHANGELOG_PATH;
});

describe('Settings → About', () => {
  it('shows the running version', () => {
    const { getByTestId } = render(<AboutPanel />);
    expect(getByTestId('app-version').textContent).toBe(`v${APP_VERSION}`);
  });

  it('renders the real changelog: release headings, group titles and bullets', () => {
    const { container, getByText } = render(<AboutPanel />);
    expect(getByText('Unreleased')).toBeTruthy();
    expect(container.textContent).toContain(APP_VERSION);
    // Sections render as headings + lists, not as raw markdown. (The date in a heading
    // like "[1.0.0] - 2026-08-16" is why this checks the bullets, not the whole text.)
    expect(container.textContent).not.toContain('### ');
    const items = Array.from(container.querySelectorAll('li'));
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) expect(item.textContent?.startsWith('- ')).toBe(false);
    expect(Array.from(container.querySelectorAll('h4')).map((h) => h.textContent)).toContain('Added');
  });

  it('never leaks the maintenance comment at the top of the file', () => {
    const { container } = render(<AboutPanel />);
    expect(container.textContent).not.toContain('HOW TO KEEP THIS FILE');
  });

  it('says so plainly when the changelog is missing, instead of rendering an empty box', () => {
    process.env.BUDGET_CHANGELOG_PATH = path.join(os.tmpdir(), `budget-absent-${Date.now()}.md`);
    const { container, getByTestId } = render(<AboutPanel />);
    expect(container.textContent).toContain('No changelog is available');
    // The version still shows — it does not depend on the file.
    expect(getByTestId('app-version').textContent).toBe(`v${APP_VERSION}`);
  });

  it('renders whatever the file says, so a fixed typo needs no rebuild', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'budget-about-')), 'CHANGELOG.md');
    fs.writeFileSync(file, '## 9.9.9 - 2030-01-01\n\n### Added\n\n- a bullet written at runtime\n');
    process.env.BUDGET_CHANGELOG_PATH = file;
    const { getByText } = render(<AboutPanel />);
    expect(getByText('9.9.9 - 2030-01-01')).toBeTruthy();
    expect(getByText('a bullet written at runtime')).toBeTruthy();
  });
});

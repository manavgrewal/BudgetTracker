import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const settingsPage = fs.readFileSync(path.join(root, 'src/app/(app)/settings/page.tsx'), 'utf8');

describe('MUST-11.1: the Settings entry point', () => {
  it('links to /settings/notifications with the specified blurb', () => {
    expect(settingsPage).toContain('/settings/notifications');
    // Review fix (LOW): case-insensitive — the copy reads better capitalized ("Where...") as a
    // sentence-style CardHeader description; the wording itself is what's pinned here, not casing.
    expect(settingsPage).toMatch(/where the app messages you, and about what/i);
  });

  it('is a PERSONAL card, not an ADMIN_LINKS entry — every member configures their own', () => {
    const adminBlock = settingsPage.slice(settingsPage.indexOf('ADMIN_LINKS'), settingsPage.indexOf('export default'));
    expect(adminBlock).not.toContain('/settings/notifications');
  });

  it('uses the new BellIcon', () => {
    expect(settingsPage).toContain('BellIcon');
    expect(fs.readFileSync(path.join(root, 'src/components/icons.tsx'), 'utf8')).toContain('export function BellIcon');
  });

  it('MUST-9.4 precursor: the notifications directory contains no fetch call', () => {
    const dir = path.join(root, 'src/app/(app)/settings/notifications');
    for (const entry of fs.readdirSync(dir)) {
      if (!/\.tsx?$/.test(entry)) continue;
      expect(fs.readFileSync(path.join(dir, entry), 'utf8')).not.toMatch(/\bfetch\s*\(/);
    }
  });
});

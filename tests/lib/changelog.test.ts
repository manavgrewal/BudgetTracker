import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { changelogPath, loadChangelog, parseChangelog, readChangelogFile } from '@/lib/changelog';
import { APP_VERSION } from '@/lib/version';

const repoRoot = process.cwd();

afterEach(() => {
  delete process.env.BUDGET_CHANGELOG_PATH;
});

describe('APP_VERSION', () => {
  it('is package.json’s version field, the single source of truth', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as { version: string };
    expect(APP_VERSION).toBe(pkg.version);
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('is inlined at build time, not read from disk at runtime', async () => {
    // If this ever became an fs read it would break in the standalone container, where
    // the working directory is not the project root. Renaming package.json out from under
    // an already-imported module must therefore change nothing.
    const source = fs.readFileSync(path.join(repoRoot, 'src/lib/version.ts'), 'utf8');
    // Comments may discuss fs; the module must not actually import or call it.
    const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    expect(code).not.toMatch(/from 'node:fs'|require\('node:fs'\)|readFileSync\(/);
    expect(code).toContain("from '../../package.json'");
  });
});

describe('the repository’s own CHANGELOG.md', () => {
  it('exists at the path the About panel looks for', () => {
    expect(changelogPath()).toBe(path.join(repoRoot, 'CHANGELOG.md'));
    expect(readChangelogFile()).not.toBeNull();
  });

  it('documents the current package.json version', () => {
    const headings = loadChangelog().map((release) => release.heading);
    expect(headings.some((heading) => heading.includes(APP_VERSION))).toBe(true);
  });

  it('keeps an Unreleased section for the next update session to write into', () => {
    expect(loadChangelog()[0]?.heading).toBe('Unreleased');
  });

  it('hides the maintenance comment at the top of the file from readers', () => {
    const rendered = JSON.stringify(loadChangelog());
    expect(rendered).not.toContain('HOW TO KEEP THIS FILE');
    expect(rendered).not.toContain('keepachangelog.com');
  });

  it('uses only the standard Keep-a-Changelog group headings', () => {
    const allowed = new Set(['Added', 'Changed', 'Deprecated', 'Removed', 'Fixed', 'Security']);
    for (const release of loadChangelog()) {
      for (const group of release.groups) {
        expect(allowed.has(group.title), `unexpected group "${group.title}"`).toBe(true);
      }
    }
  });
});

describe('parseChangelog', () => {
  it('splits releases, groups and bullets', () => {
    const releases = parseChangelog(
      ['# Changelog', '', '## Unreleased', '', '### Added', '', '- a thing', '- another thing', '', '## [1.0.0] - 2026-08-16', '', 'Initial release.', '', '### Fixed', '', '- a bug'].join('\n'),
    );
    expect(releases.map((r) => r.heading)).toEqual(['Unreleased', '[1.0.0] - 2026-08-16']);
    expect(releases[0].groups).toEqual([{ title: 'Added', items: ['a thing', 'another thing'] }]);
    expect(releases[1].notes).toEqual(['Initial release.']);
    expect(releases[1].groups[0].items).toEqual(['a bug']);
  });

  it('joins a bullet that wraps across lines back into one item', () => {
    const releases = parseChangelog(['## Unreleased', '### Added', '- a bullet that runs on', '  across two lines'].join('\n'));
    expect(releases[0].groups[0].items).toEqual(['a bullet that runs on across two lines']);
  });

  it('keeps a stray paragraph as a note rather than dropping it', () => {
    const releases = parseChangelog(['## Unreleased', '', 'A note with no group.', ''].join('\n'));
    expect(releases[0].notes).toEqual(['A note with no group.']);
  });

  it('skips single-line and multi-line HTML comments', () => {
    const releases = parseChangelog(
      ['<!-- one liner -->', '<!--', 'spanning', 'several lines', '-->', '## Unreleased', '### Added', '- kept'].join('\n'),
    );
    expect(releases).toHaveLength(1);
    expect(releases[0].groups[0].items).toEqual(['kept']);
  });

  it('returns nothing for an empty or heading-only document instead of throwing', () => {
    expect(parseChangelog('')).toEqual([]);
    expect(parseChangelog('# Changelog\n\nSome preamble.\n')).toEqual([]);
  });
});

describe('a missing changelog', () => {
  it('degrades to an empty list, never an exception', () => {
    process.env.BUDGET_CHANGELOG_PATH = path.join(os.tmpdir(), `budget-no-changelog-${Date.now()}.md`);
    expect(readChangelogFile()).toBeNull();
    expect(loadChangelog()).toEqual([]);
  });

  it('reads the override path when one is set', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'budget-changelog-')), 'CHANGELOG.md');
    fs.writeFileSync(file, '## 9.9.9\n\n### Added\n\n- from the override\n');
    process.env.BUDGET_CHANGELOG_PATH = file;
    expect(changelogPath()).toBe(file);
    expect(loadChangelog()[0]?.groups[0]?.items).toEqual(['from the override']);
  });
});

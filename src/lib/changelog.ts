import fs from 'node:fs';
import path from 'node:path';

/** One `## ...` section of CHANGELOG.md. */
export interface ChangelogRelease {
  /** The heading text, e.g. "Unreleased" or "[1.0.0] - 2026-08-16". */
  heading: string;
  /** Prose paragraphs that sit directly under the heading, before any `###` group. */
  notes: string[];
  /** `### Added` / `### Fixed` / ... groups, in file order. */
  groups: { title: string; items: string[] }[];
}

/**
 * Unlike the version constant, the changelog is read at RUNTIME. It is prose that people
 * will want to reread without rebuilding, and inlining a multi-kilobyte string into the
 * server bundle to avoid one file read would be the wrong trade.
 *
 * In dev and in tests this resolves to the repo root. In the container it resolves to the
 * standalone app directory, which is why the Dockerfile copies CHANGELOG.md there next to
 * drizzle/ — see the matching assertion in tests/ops/docker.test.ts.
 *
 * BUDGET_CHANGELOG_PATH is a test-only override, in the same spirit as BUDGET_DB_PATH.
 */
export function changelogPath(): string {
  const override = process.env.BUDGET_CHANGELOG_PATH;
  if (override && override.length > 0) return override;
  return path.join(process.cwd(), 'CHANGELOG.md');
}

/** null (never a throw) when the file is missing: an unreadable changelog is not an outage. */
export function readChangelogFile(): string | null {
  try {
    return fs.readFileSync(changelogPath(), 'utf8');
  } catch {
    return null;
  }
}

/**
 * A deliberately tiny Keep-a-Changelog reader — no markdown dependency for what is a
 * three-shape document: `## release`, `### group`, `- item`, plus the odd paragraph.
 * Anything it does not recognise is kept as a note rather than dropped, so a hand-written
 * line can never silently vanish from the About panel.
 */
export function parseChangelog(markdown: string): ChangelogRelease[] {
  const releases: ChangelogRelease[] = [];
  let release: ChangelogRelease | null = null;
  let group: { title: string; items: string[] } | null = null;
  let inHtmlComment = false;
  let pendingItem: string[] | null = null;

  const flushItem = () => {
    if (pendingItem === null) return;
    const text = pendingItem.join(' ').replace(/\s+/g, ' ').trim();
    if (text.length > 0) {
      if (group) group.items.push(text);
      else if (release) release.notes.push(text);
    }
    pendingItem = null;
  };

  for (const rawLine of markdown.split(/\r?\n/)) {
    const line = rawLine.trimEnd();

    // The maintenance note at the top of the file is for whoever edits it, not for readers.
    if (!inHtmlComment && line.trimStart().startsWith('<!--')) {
      inHtmlComment = !line.includes('-->');
      continue;
    }
    if (inHtmlComment) {
      if (line.includes('-->')) inHtmlComment = false;
      continue;
    }

    if (line.trim().length === 0) {
      flushItem();
      continue;
    }

    if (line.startsWith('## ')) {
      flushItem();
      release = { heading: line.slice(3).trim(), notes: [], groups: [] };
      group = null;
      releases.push(release);
      continue;
    }

    if (line.startsWith('### ')) {
      flushItem();
      if (!release) continue;
      group = { title: line.slice(4).trim(), items: [] };
      release.groups.push(group);
      continue;
    }

    // The `# Changelog` title and anything before the first `## ` are preamble.
    if (line.startsWith('# ') || !release) continue;

    if (/^[-*]\s+/.test(line.trimStart())) {
      flushItem();
      pendingItem = [line.trimStart().replace(/^[-*]\s+/, '')];
      continue;
    }

    // A continuation of the bullet above (this file wraps long bullets), or a paragraph.
    if (pendingItem !== null) pendingItem.push(line.trim());
    else release.notes.push(line.trim());
  }

  flushItem();
  return releases;
}

export function loadChangelog(): ChangelogRelease[] {
  const raw = readChangelogFile();
  return raw === null ? [] : parseChangelog(raw);
}

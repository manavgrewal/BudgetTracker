import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * v1.3.1 / Task 14: this file was notify's egress invariant test (MUST-9.4). It is now the
 * WHOLE APP's egress invariant test: every tree that is allowed to leave the machine —
 * src/lib/notify/ and, as of the update feature, src/lib/update/ — is scanned here, by the
 * same table-driven, comment-stripped, line-scoped checks. A third opt-in tree added later
 * extends the tables below; it does not get its own copy of this file.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function filesUnder(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) filesUnder(full, acc);
    else if (/\.tsx?$/.test(entry.name)) acc.push(full);
  }
  return acc;
}

const notifyDir = path.join(root, 'src/lib/notify');
const updateDir = path.join(root, 'src/lib/update');
const pageDir = path.join(root, 'src/app/(app)/settings/notifications');
const rel = (file: string) => path.relative(root, file).replace(/\\/g, '/');

/**
 * Quoted string literals containing `://`, found line by line and ignoring comment lines.
 *
 * Line-scoped on purpose: a whole-file regex pairs a quote from one statement with a `://`
 * inside a docblock hundreds of lines later and reports a URL that does not exist. Comment
 * lines are skipped because prose legitimately writes the endpoint out (`POST
 * https://api.telegram.org/bot<token>/sendMessage`) — what matters is whether the CODE
 * carries a second destination.
 */
function urlLiterals(file: string): string[] {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      return !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*');
    })
    .flatMap((line) => line.match(/(['"`])[^'"`]*:\/\/[^'"`]*\1/g) ?? []);
}

/**
 * The repo's established stripComments pattern (see tests/ops/install.test.ts). Without it,
 * github.ts's own docblock -- which spells out `fetch(` in prose while explaining MUST-8.5 --
 * would inflate its own call-site count from 2 to 4. Comments proving a scanner right must not
 * be able to make the scanner wrong.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * MUST-8.8 item 2: table-driven over BOTH egress trees. `expected` counts literal `fetch(`
 * CALL SITES, not endpoints.
 *
 * Pre-flight ruling F1: github.ts deliberately keeps TWO inlined fetch call sites — one per
 * endpoint (fetchLatestRelease, fetchRemoteChangelog) — each with `assertGithubUrl()` on the
 * line immediately above it (MUST-8.5), rather than folding both into a shared private
 * request helper. That adjacency is the property a refactor loses first, and the source-level
 * scanner below (MUST-8.5) checks for it directly, so the count here is 2, not 1.
 */
const FETCH_SITES: { dir: string; file: string; expected: number }[] = [
  { dir: notifyDir, file: 'src/lib/notify/send/telegram.ts', expected: 2 }, // sendMessage, getUpdates
  { dir: updateDir, file: 'src/lib/update/github.ts', expected: 2 }, // fetchLatestRelease, fetchRemoteChangelog
  { dir: updateDir, file: 'src/lib/update/watchtower.ts', expected: 1 }, // /v1/update
];

it('every fetch( under src/lib/notify/ and src/lib/update/ is on the allowlist, with the expected count', () => {
  const counts = new Map<string, number>();
  const offenders: string[] = [];
  for (const dir of [notifyDir, updateDir]) {
    for (const file of filesUnder(dir)) {
      const calls = stripComments(fs.readFileSync(file, 'utf8')).match(/(?<![.\w])fetch\s*\(/g)?.length ?? 0;
      if (calls === 0) continue;
      const name = rel(file);
      if (FETCH_SITES.some((site) => site.file === name)) counts.set(name, calls);
      else offenders.push(name);
    }
  }
  expect(offenders).toEqual([]);
  for (const site of FETCH_SITES) expect({ file: site.file, calls: counts.get(site.file) }).toEqual({ file: site.file, calls: site.expected });
});

describe('MUST-9.4 / AC3: the only outbound call sites', () => {
  it('the only URL literal containing :// is TELEGRAM_API_ORIGIN in egress.ts', () => {
    const offenders: { file: string; literal: string }[] = [];
    for (const file of filesUnder(notifyDir)) {
      if (rel(file) === 'src/lib/notify/egress.ts') continue;
      for (const literal of urlLiterals(file)) offenders.push({ file: rel(file), literal });
    }
    expect(offenders).toEqual([]);
    expect(urlLiterals(path.join(notifyDir, 'egress.ts'))).toEqual(["'https://api.telegram.org'"]);
  });

  it('MUST-9.1a: the settings page directory contains no fetch call at all', () => {
    for (const file of filesUnder(pageDir)) {
      expect(fs.readFileSync(file, 'utf8')).not.toMatch(/(?<![.\w])fetch\s*\(/);
    }
  });

  it('MUST-11.6: the guides render no <a href>, so no address on the page is clickable', () => {
    const guides = fs.readFileSync(path.join(pageDir, 'guides.tsx'), 'utf8');
    expect(guides).not.toMatch(/<a\s/);
    expect(guides).not.toMatch(/href=/);
  });

  it('MUST-9.1a: the page directory holds no :// STRING LITERAL — only JSX prose', () => {
    for (const file of filesUnder(pageDir)) {
      // guides.tsx writes `<code>https://</code>` as JSX text (the Custom-SMTP guide telling
      // the reader NOT to type a scheme into the Server field). That is prose a person
      // reads, not an address the server can use, and it is not a string literal.
      expect({ file: rel(file), literals: urlLiterals(file) }).toEqual({ file: rel(file), literals: [] });
    }
    const guides = fs.readFileSync(path.join(pageDir, 'guides.tsx'), 'utf8');
    expect(guides).toContain('<code>https://</code>');
  });
});

describe('MUST-2.3: the only :// literal under src/lib/update/ is GITHUB_API_ORIGIN in egress.ts', () => {
  it('no other file in the tree carries one, and watchtower.ts carries none at all', () => {
    const offenders: { file: string; literal: string }[] = [];
    for (const file of filesUnder(updateDir)) {
      if (rel(file) === 'src/lib/update/egress.ts') continue;
      for (const literal of urlLiterals(file)) offenders.push({ file: rel(file), literal });
    }
    expect(offenders).toEqual([]);
    expect(urlLiterals(path.join(updateDir, 'egress.ts'))).toEqual(["'https://api.github.com'"]);
    // watchtower.ts MUST contain no :// literal at all -- the URL comes from the environment.
    expect(urlLiterals(path.join(updateDir, 'watchtower.ts'))).toEqual([]);
  });
});

describe('no file under src/lib/notify/ or src/lib/update/ imports an HTTP client library', () => {
  it('neither tree pulls in a second way to make an outbound request', () => {
    const banned = /from\s+['"](axios|node-fetch|got|undici|superagent|ky|request)['"]/;
    for (const dir of [notifyDir, updateDir]) {
      for (const file of filesUnder(dir)) {
        expect(fs.readFileSync(file, 'utf8')).not.toMatch(banned);
      }
    }
  });
});

/**
 * MUST-8.5: the assert is on the line immediately preceding each fetch(, in the style of
 * restore-seams.test.ts -- "immediately above" is the part a refactor loses first, and a
 * whole-file "the guard function is called somewhere in this file" check would not catch a
 * refactor that moved the fetch() above the guard, or behind an early return.
 */
describe('MUST-8.5: the assert is on the line immediately preceding each fetch(', () => {
  it('holds for every fetch( call site in github.ts and watchtower.ts', () => {
    const cases = [
      { file: 'src/lib/update/github.ts', guard: 'assertGithubUrl(' },
      { file: 'src/lib/update/watchtower.ts', guard: 'assertWatchtowerUrl(' },
    ];
    for (const { file, guard } of cases) {
      const lines = fs.readFileSync(path.join(root, file), 'utf8').split('\n');
      const fetchLines = lines
        .map((line, index) => ({ line, index }))
        // A docblock line can legitimately spell out `fetch(` in prose (github.ts's own
        // MUST-8.5 comment does exactly that) without being a real call site.
        .filter((entry) => {
          const trimmed = entry.line.trim();
          return !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*') && /(?<![.\w])fetch\s*\(/.test(entry.line);
        });
      expect(fetchLines.length).toBeGreaterThan(0);
      for (const { index } of fetchLines) {
        const previous = (lines[index - 1] ?? '').trim();
        expect({ file, previous }).toEqual({ file, previous: expect.stringContaining(guard) as unknown as string });
      }
    }
  });
});

describe('MUST-2.1: the pure modules stay pure', () => {
  const pureModules: { dir: string; name: string }[] = [
    { dir: notifyDir, name: 'events.ts' },
    { dir: notifyDir, name: 'render.ts' },
    { dir: notifyDir, name: 'egress.ts' },
    { dir: notifyDir, name: 'evaluate/slots.ts' },
    { dir: updateDir, name: 'semver.ts' },
    { dir: updateDir, name: 'egress.ts' },
  ];
  for (const { dir, name } of pureModules) {
    it(`${rel(path.join(dir, name))} imports no @/db, no @/lib/env and no node builtin`, () => {
      const source = fs.readFileSync(path.join(dir, name), 'utf8');
      expect(source).not.toMatch(/from\s+['"]@\/db/);
      expect(source).not.toMatch(/from\s+['"]@\/lib\/env['"]/);
      expect(source).not.toMatch(/from\s+['"]node:/);
    });
  }
});

describe('MUST-2.2: server-only modules never reach a client component', () => {
  it('no *-client.tsx has a VALUE import of a notify or update server-only module', () => {
    const clients = filesUnder(path.join(root, 'src/app')).filter((file) => file.endsWith('-client.tsx'));
    const banned = /from\s+['"]@\/lib\/(notify\/(crypto|config|outbox|raise|send|evaluate)|update\/(github|watchtower|state|check))/;
    for (const file of clients) {
      // `import type { ... }` is erased before bundling and is how the client legitimately
      // names SmtpRecord / TargetRecord / DeliveryRow / UpdateSeverity. Only value imports
      // are the hazard.
      const offending = fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => banned.test(line) && !/^import\s+type\b/.test(line));
      expect({ file: rel(file), offending }).toEqual({ file: rel(file), offending: [] });
    }
  });
});

describe('AC7: no console call in src/lib/notify/ can leak a subject, a body or a secret', () => {
  it('never interpolates subject, body, token, password or a decrypted secret', () => {
    const banned = /console\.[a-z]+\([^)]*\b(subject|body|botToken|password|secret|plaintext)\b/i;
    for (const file of filesUnder(notifyDir)) {
      const source = fs.readFileSync(file, 'utf8');
      const offending = source
        .split('\n')
        .map((line, index) => ({ line: line.trim(), number: index + 1 }))
        .filter((entry) => banned.test(entry.line));
      expect({ file: rel(file), offending }).toEqual({ file: rel(file), offending: [] });
    }
  });
});

describe('AC7: src/lib/update/ holds one Authorization literal and logs no credential', () => {
  it('the one Authorization header is in watchtower.ts, and no console call can leak it', () => {
    const authLines: string[] = [];
    const consoleOffenders: string[] = [];
    for (const file of filesUnder(updateDir)) {
      const source = fs.readFileSync(file, 'utf8');
      for (const line of source.split('\n')) {
        const trimmed = line.trim();
        // github.ts's own MUST-4.3 comment ("No Authorization.") is a single-line /** ... */
        // block, which a bare '//'/'*' prefix check does not catch -- the '/*' check below
        // does (same three-way skip urlLiterals() above already uses).
        if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;
        if (/Authorization/.test(trimmed)) authLines.push(`${rel(file)}: ${trimmed}`);
        if (/console\.[a-z]+\([^)]*\b(token|Authorization|bearer)\b/i.test(trimmed)) consoleOffenders.push(`${rel(file)}: ${trimmed}`);
      }
    }
    expect(authLines).toHaveLength(1);
    expect(authLines[0]).toContain('src/lib/update/watchtower.ts');
    expect(authLines[0]).toContain('Bearer ');
    expect(consoleOffenders).toEqual([]);
  });
});

describe('MUST-9.5: the scheduler never reaches a transport directly', () => {
  it('src/lib/scheduler.ts imports the tick pieces, not the senders', () => {
    const source = fs.readFileSync(path.join(root, 'src/lib/scheduler.ts'), 'utf8');
    expect(source).not.toMatch(/notify\/send/);
    expect(source).toContain('hasAnyEnabledTarget');
    expect(source).toContain('countPendingOutbox');
  });
});

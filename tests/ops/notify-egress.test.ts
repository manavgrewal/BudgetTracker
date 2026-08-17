import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

describe('MUST-9.4 / AC3: the only outbound call sites', () => {
  it('every fetch( in src/lib/notify/ is in send/telegram.ts, and there are exactly two', () => {
    const offenders: string[] = [];
    let telegramCalls = 0;
    for (const file of filesUnder(notifyDir)) {
      const source = fs.readFileSync(file, 'utf8');
      const calls = source.match(/(?<![.\w])fetch\s*\(/g)?.length ?? 0;
      if (calls === 0) continue;
      if (rel(file) === 'src/lib/notify/send/telegram.ts') telegramCalls = calls;
      else offenders.push(rel(file));
    }
    expect(offenders).toEqual([]);
    expect(telegramCalls).toBe(2); // sendMessage and getUpdates, and nothing else
  });

  it('the only URL literal containing :// is TELEGRAM_API_ORIGIN in egress.ts', () => {
    const offenders: { file: string; literal: string }[] = [];
    for (const file of filesUnder(notifyDir)) {
      if (rel(file) === 'src/lib/notify/egress.ts') continue;
      for (const literal of urlLiterals(file)) offenders.push({ file: rel(file), literal });
    }
    expect(offenders).toEqual([]);
    expect(urlLiterals(path.join(notifyDir, 'egress.ts'))).toEqual(["'https://api.telegram.org'"]);
  });

  it('no file under src/lib/notify/ imports an HTTP client library', () => {
    const banned = /from\s+['"](axios|node-fetch|got|undici|superagent|ky|request)['"]/;
    for (const file of filesUnder(notifyDir)) {
      expect(fs.readFileSync(file, 'utf8')).not.toMatch(banned);
    }
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

describe('MUST-2.1: the pure modules stay pure', () => {
  const pure = ['events.ts', 'render.ts', 'egress.ts', 'evaluate/slots.ts'];
  for (const name of pure) {
    it(`${name} imports no @/db, no @/lib/env and no node builtin`, () => {
      const source = fs.readFileSync(path.join(notifyDir, name), 'utf8');
      expect(source).not.toMatch(/from\s+['"]@\/db/);
      expect(source).not.toMatch(/from\s+['"]@\/lib\/env['"]/);
      expect(source).not.toMatch(/from\s+['"]node:/);
    });
  }
});

describe('MUST-2.2: server-only modules never reach a client component', () => {
  it('no *-client.tsx has a VALUE import of notify crypto, config, outbox, raise, evaluate or a transport', () => {
    const clients = filesUnder(path.join(root, 'src/app')).filter((file) => file.endsWith('-client.tsx'));
    const banned = /from\s+['"]@\/lib\/notify\/(crypto|config|outbox|raise|send|evaluate)/;
    for (const file of clients) {
      // `import type { ... }` is erased before bundling and is how the client legitimately
      // names SmtpRecord / TargetRecord / DeliveryRow. Only value imports are the hazard.
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

describe('MUST-9.5: the scheduler never reaches a transport directly', () => {
  it('src/lib/scheduler.ts imports the tick pieces, not the senders', () => {
    const source = fs.readFileSync(path.join(root, 'src/lib/scheduler.ts'), 'utf8');
    expect(source).not.toMatch(/notify\/send/);
    expect(source).toContain('hasAnyEnabledTarget');
    expect(source).toContain('countPendingOutbox');
  });
});

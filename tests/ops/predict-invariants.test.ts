import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const predictDir = path.join(root, 'src/lib/predict');

function filesUnder(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) filesUnder(full, acc);
    else if (/\.tsx?$/.test(entry.name)) acc.push(full);
  }
  return acc;
}

describe('MUST-2.1 and AC10: only history.ts touches the database', () => {
  it('no other file under src/lib/predict/ imports @/db, @/lib/env or a node builtin', () => {
    for (const file of filesUnder(predictDir)) {
      if (path.basename(file) === 'history.ts') continue;
      const source = fs.readFileSync(file, 'utf8');
      const name = path.relative(root, file).replace(/\\/g, '/');
      expect({ name, db: /from\s+['"]@\/db/.test(source) }).toEqual({ name, db: false });
      expect({ name, env: /from\s+['"]@\/lib\/env['"]/.test(source) }).toEqual({ name, env: false });
      expect({ name, node: /from\s+['"]node:/.test(source) }).toEqual({ name, node: false });
    }
  });

  it('MUST-2.1: no pure module constructs a Date', () => {
    for (const file of filesUnder(predictDir)) {
      if (path.basename(file) === 'history.ts') continue;
      const source = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
      expect({ file: path.basename(file), date: /new Date\b/.test(source) }).toEqual({ file: path.basename(file), date: false });
    }
  });

  it('MUST-3.3: divRound is the only division primitive in the tree', () => {
    for (const file of filesUnder(predictDir)) {
      if (path.basename(file) === 'stats.ts') continue;
      const source = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
      expect({ file: path.basename(file), round: /Math\.round\s*\(/.test(source) }).toEqual({
        file: path.basename(file),
        round: false,
      });
    }
  });
});

describe('MUST-1.4 and AC4: no migration, no schema change', () => {
  it('the newest migration is still 0007 and the journal has no eighth entry', () => {
    const files = fs.readdirSync(path.join(root, 'drizzle')).filter((name) => name.endsWith('.sql')).sort();
    expect(files[files.length - 1]).toBe('0007_loans.sql');
    const journal = fs.readFileSync(path.join(root, 'drizzle/meta/_journal.json'), 'utf8');
    expect(journal).toContain('"idx": 7');
    expect(journal).not.toContain('"idx": 8');
  });

  it('src/db/schema.ts names no predictive object', () => {
    const schema = fs.readFileSync(path.join(root, 'src/db/schema.ts'), 'utf8');
    for (const banned of ['predict', 'suggestion', 'projection', 'baseline']) {
      expect({ banned, present: new RegExp(banned, 'i').test(schema) }).toEqual({ banned, present: false });
    }
  });
});

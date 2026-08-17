import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');

/** Every .ts/.tsx file under src/, recursively. */
function srcFiles(dir = path.join(root, 'src'), acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) srcFiles(full, acc);
    else if (/\.tsx?$/.test(entry.name)) acc.push(full);
  }
  return acc;
}

describe('MUST-20.4: the CLI half never imports src/', () => {
  for (const file of ['scripts/restore-core.ts', 'scripts/restore-backup.ts']) {
    it(`${file} contains no '@/' import`, () => {
      const source = read(file);
      expect(source).not.toMatch(/from\s+['"]@\//);
      expect(source).not.toMatch(/import\(\s*['"]@\//);
    });

    it(`${file} uses only syntax --experimental-strip-types can erase`, () => {
      const source = read(file);
      // Node's type stripping ERASES types; it does not compile them. enum / namespace /
      // parameter properties emit runtime code and are rejected outright.
      expect(source).not.toMatch(/^\s*(export\s+)?(const\s+)?enum\s/m);
      expect(source).not.toMatch(/^\s*(export\s+)?namespace\s/m);
      expect(source).not.toMatch(/constructor\s*\([^)]*\b(private|public|readonly)\s/);
    });
  }
});

describe('MUST-20.5: exactly one bridge from src/ into scripts/', () => {
  it('is src/lib/backup/restore.ts and nothing else', () => {
    const importers = srcFiles()
      .filter((file) => /from\s+['"][^'"]*scripts\//.test(fs.readFileSync(file, 'utf8')))
      .map((file) => path.relative(root, file).replace(/\\/g, '/'));
    expect(importers).toEqual(['src/lib/backup/restore.ts']);
  });
});

describe('MUST-20.26: the restore runs before any database connection', () => {
  it('instrumentation-node calls applyStagedRestoreOnBoot() before getDb()', () => {
    const source = read('src/instrumentation-node.ts');
    const restore = source.indexOf('applyStagedRestoreOnBoot()');
    const openDb = source.indexOf('getDb()');
    expect(restore).toBeGreaterThan(-1);
    expect(openDb).toBeGreaterThan(-1);
    expect(restore).toBeLessThan(openDb);
  });

  it('importing @/db/client opens no database', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-lazy-'));
    const dbPath = path.join(dir, 'never-created.db');
    const previous = process.env.BUDGET_DB_PATH;
    process.env.BUDGET_DB_PATH = dbPath;
    try {
      const mod = await import('@/db/client');
      expect(mod.databasePath()).toBe(dbPath);
      expect(fs.existsSync(dbPath)).toBe(false); // merely importing must not create it
    } finally {
      if (previous === undefined) delete process.env.BUDGET_DB_PATH;
      else process.env.BUDGET_DB_PATH = previous;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

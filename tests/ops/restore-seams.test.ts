import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');

/**
 * Strips block comments then line comments (same pattern as tests/ops/install.test.ts's
 * stripComments), so a prose mention of a call site inside a comment — e.g. "...BEFORE the
 * scheduler starts below" naming a function nearby — can never satisfy an indexOf/lastIndexOf
 * ordering assertion by coincidence. This is what makes the "avoid this literal in a comment"
 * discipline unnecessary: the assertions below only ever see the real call sites.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** The code of a file with every comment removed — for ordering assertions only. */
const readCode = (rel: string) => stripComments(read(rel));

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
    // T1 review minor: a dynamic import('.../scripts/...') is just as much a bridge as a
    // static `from '.../scripts/...'` — the original regex only caught the latter.
    const importers = srcFiles()
      .filter((file) => {
        const source = fs.readFileSync(file, 'utf8');
        return /from\s+['"][^'"]*scripts\//.test(source) || /import\(\s*['"][^'"]*scripts\//.test(source);
      })
      .map((file) => path.relative(root, file).replace(/\\/g, '/'));
    expect(importers).toEqual(['src/lib/backup/restore.ts']);
  });
});

describe("MUST-20.4: type-only restore-core exports are always imported with 'type'", () => {
  it("scripts/restore-backup.ts never bare-imports a type-only restore-core export", () => {
    // Node's --experimental-strip-types erases `type`-marked specifiers; a BARE import of a
    // binding that is only ever a type (no runtime export of that name exists) would instead
    // survive stripping and fail at module-instantiation time with "does not provide an
    // export named ...". This is a regex proxy for that class of bug, not a type-checker: it
    // extracts every `export type X` / `export interface X` from restore-core.ts and asserts
    // that if the bridge file mentions that name at all, it does so with the `type` modifier.
    const core = read('scripts/restore-core.ts');
    const bridge = read('scripts/restore-backup.ts');
    const typeOnlyNames = [
      ...[...core.matchAll(/^export type (\w+)/gm)].map((m) => m[1]),
      ...[...core.matchAll(/^export interface (\w+)/gm)].map((m) => m[1]),
    ];
    expect(typeOnlyNames.length).toBeGreaterThan(0); // the assertion below is vacuous otherwise
    for (const name of typeOnlyNames) {
      const bareReference = new RegExp(`[{,]\\s*${name}\\s*[,}]`);
      const typedReference = new RegExp(`type\\s+${name}\\b`);
      if (bareReference.test(bridge)) {
        expect(typedReference.test(bridge), `${name} must be imported/exported with 'type' in scripts/restore-backup.ts`).toBe(true);
      }
    }
  });
});

describe('MUST-20.26: the restore runs before any database connection', () => {
  it('instrumentation-node calls applyStagedRestoreOnBoot() before getDb()', () => {
    const source = readCode('src/instrumentation-node.ts');
    const restore = source.indexOf('applyStagedRestoreOnBoot()');
    const openDb = source.lastIndexOf('getDb();');
    expect(restore).toBeGreaterThan(-1);
    expect(openDb).toBeGreaterThan(-1);
    expect(restore).toBeLessThan(openDb);
  });

  it("a 'restart' outcome exits before getDb() (MUST-20.23)", () => {
    // CRITICAL (T1 review): applyStagedRestoreOnBoot()'s 'restart' signal only protects the
    // boot if the caller actually acts on it. This pins the wiring at the source level: the
    // exit call must be reachable, must use RESTART_EXIT_CODE, and must appear strictly
    // between the restore call and getDb().
    const source = readCode('src/instrumentation-node.ts');
    const restoreCall = source.indexOf('applyStagedRestoreOnBoot()');
    const restartCheck = source.indexOf(`restoreOutcome === 'restart'`);
    const exitCall = source.indexOf('process.exit(RESTART_EXIT_CODE)');
    const openDb = source.lastIndexOf('getDb();');
    expect(restoreCall).toBeGreaterThan(-1);
    expect(restartCheck).toBeGreaterThan(restoreCall);
    expect(exitCall).toBeGreaterThan(restartCheck);
    expect(exitCall).toBeLessThan(openDb);
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

describe('MUST-14.2 / MUST-14.3: the notification raise sits between getDb and startScheduler', () => {
  const source = readCode('src/instrumentation-node.ts');

  it('calls raiseRestoreOutcome() after getDb() and before startScheduler()', () => {
    const getDbAt = source.indexOf('getDb();');
    const raiseAt = source.indexOf('raiseRestoreOutcome()');
    const schedulerAt = source.indexOf('startScheduler()');
    expect(getDbAt).toBeGreaterThan(-1);
    expect(raiseAt).toBeGreaterThan(getDbAt);
    expect(schedulerAt).toBeGreaterThan(raiseAt);
  });

  it('wraps it so a notify failure cannot stop the boot', () => {
    expect(source).toMatch(/try\s*\{\s*raiseRestoreOutcome\(\);\s*\}\s*catch/);
  });

  it('leaves applyStagedRestoreOnBoot() as the first statement', () => {
    const firstStatement = source.indexOf('applyStagedRestoreOnBoot()');
    expect(firstStatement).toBeGreaterThan(-1);
    expect(firstStatement).toBeLessThan(source.indexOf('getDb();'));
  });
});

describe('MUST-7.6 / MUST-7.7: the update reconciler sits between getDb and startScheduler', () => {
  const source = readCode('src/instrumentation-node.ts');

  it('calls reconcileApplyOnBoot() after raiseRestoreOutcome() and before startScheduler()', () => {
    const raiseAt = source.indexOf('raiseRestoreOutcome()');
    const reconcileAt = source.indexOf('reconcileApplyOnBoot()');
    const schedulerAt = source.indexOf('startScheduler()');
    expect(reconcileAt).toBeGreaterThan(raiseAt);
    expect(schedulerAt).toBeGreaterThan(reconcileAt);
    expect(source.lastIndexOf('getDb();')).toBeLessThan(reconcileAt);
  });

  it('wraps it so a reconciliation failure cannot stop the boot', () => {
    expect(source).toMatch(/try\s*\{\s*reconcileApplyOnBoot\(\);\s*\}\s*catch/);
  });

  it('leaves applyStagedRestoreOnBoot() as the first statement (warranty §20 untouched)', () => {
    expect(source.indexOf('applyStagedRestoreOnBoot()')).toBeLessThan(source.indexOf('getDb();'));
  });
});

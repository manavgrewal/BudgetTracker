import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const ROOT = process.cwd();

function walk(dir: string): string[] {
  const full = path.join(ROOT, dir);
  return fs.readdirSync(full, { withFileTypes: true }).flatMap((entry) => {
    const relative = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) return walk(relative);
    return /\.(ts|tsx)$/.test(entry.name) ? [relative] : [];
  });
}

/**
 * Skips blank lines and comments to find the first real statement. Next only honours the
 * 'use server' directive when it is the first statement in the file, but a leading blank line
 * or a license-header comment above it is common enough elsewhere in this codebase that the
 * check should not be fooled by one.
 */
function firstMeaningfulLine(source: string): string | null {
  let rest = source;
  while (rest.length > 0) {
    rest = rest.replace(/^[ \t\r\n]+/, '');
    if (rest.startsWith('//')) {
      const newline = rest.indexOf('\n');
      rest = newline === -1 ? '' : rest.slice(newline + 1);
      continue;
    }
    if (rest.startsWith('/*')) {
      const end = rest.indexOf('*/');
      rest = end === -1 ? '' : rest.slice(end + 2);
      continue;
    }
    break;
  }
  const newline = rest.indexOf('\n');
  const line = newline === -1 ? rest : rest.slice(0, newline);
  const trimmed = line.trim();
  return trimmed === '' ? null : trimmed;
}

function isUseServerFile(source: string): boolean {
  const line = firstMeaningfulLine(source);
  return line === "'use server';" || line === '"use server";' || line === "'use server'" || line === '"use server"';
}

function hasModifierKind(node: ts.Node, kind: ts.SyntaxKind): boolean {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return modifiers?.some((m) => m.kind === kind) ?? false;
}

function isExported(node: ts.Node): boolean {
  return hasModifierKind(node, ts.SyntaxKind.ExportKeyword);
}

function isAsync(node: ts.Node): boolean {
  return hasModifierKind(node, ts.SyntaxKind.AsyncKeyword);
}

type Classification = 'async-function' | 'other';

/** Is `expr` itself (an arrow function, function expression, or reference to one of those
 * declared elsewhere at the top of this file) shaped like an async function? */
function classifyExpression(expr: ts.Expression, locals: Map<string, Classification>): Classification {
  if (ts.isArrowFunction(expr) || ts.isFunctionExpression(expr)) {
    return isAsync(expr) ? 'async-function' : 'other';
  }
  if (ts.isIdentifier(expr)) {
    return locals.get(expr.text) ?? 'other';
  }
  return 'other';
}

/**
 * A 'use server' module may export ONLY async functions (Next 15). Type-only exports
 * (`export type`, `export interface`) are erased at compile time and are exempt. Everything
 * else that is exported — a const/let/var, a class, an enum, a non-async function, a
 * non-async `export default`, or a bare `export { x }` re-export of a non-async value — throws
 * at require() time in production the moment the file is actually loaded as a server-actions
 * module, which vitest never does (it imports the file as a plain module) and `next build`
 * never notices either (see src/app/(app)/settings/managers/actions.ts's history — this is the
 * second time that gap has bitten this project).
 */
function findViolations(label: string, source: string, scriptKind: ts.ScriptKind): string[] {
  const sourceFile = ts.createSourceFile(label, source, ts.ScriptTarget.Latest, true, scriptKind);
  const violations: string[] = [];

  // First pass: classify every top-level name this file declares, so a bare `export { x }` or
  // `export default x` referring to one of them can be resolved without a full type-checker.
  const locals = new Map<string, Classification>();
  for (const stmt of sourceFile.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name) {
      locals.set(stmt.name.text, isAsync(stmt) ? 'async-function' : 'other');
    } else if (ts.isClassDeclaration(stmt) && stmt.name) {
      locals.set(stmt.name.text, 'other');
    } else if (ts.isEnumDeclaration(stmt)) {
      locals.set(stmt.name.text, 'other');
    } else if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) {
          locals.set(decl.name.text, decl.initializer ? classifyExpression(decl.initializer, locals) : 'other');
        }
      }
    }
  }

  for (const stmt of sourceFile.statements) {
    if (ts.isTypeAliasDeclaration(stmt) || ts.isInterfaceDeclaration(stmt)) {
      continue; // erased at compile time — always fine.
    }

    if (ts.isFunctionDeclaration(stmt) && isExported(stmt)) {
      const name = stmt.name?.text ?? 'default';
      if (!isAsync(stmt)) violations.push(`${label}: exported function '${name}' is not async`);
      continue;
    }

    if (ts.isClassDeclaration(stmt) && isExported(stmt)) {
      const name = stmt.name?.text ?? 'default';
      violations.push(`${label}: exported class '${name}' is not (and cannot be) async`);
      continue;
    }

    if (ts.isEnumDeclaration(stmt) && isExported(stmt)) {
      violations.push(`${label}: exported enum '${stmt.name.text}' is not an async function`);
      continue;
    }

    if (ts.isVariableStatement(stmt) && isExported(stmt)) {
      const kind =
        stmt.declarationList.flags & ts.NodeFlags.Const
          ? 'const'
          : stmt.declarationList.flags & ts.NodeFlags.Let
            ? 'let'
            : 'var';
      for (const decl of stmt.declarationList.declarations) {
        const name = decl.name.getText(sourceFile);
        const classification = decl.initializer ? classifyExpression(decl.initializer, locals) : 'other';
        if (classification !== 'async-function') {
          violations.push(`${label}: exported ${kind} '${name}' is not an async function`);
        }
      }
      continue;
    }

    if (ts.isExportAssignment(stmt) && !stmt.isExportEquals) {
      if (classifyExpression(stmt.expression, locals) !== 'async-function') {
        violations.push(`${label}: default export is not an async function`);
      }
      continue;
    }

    if (ts.isExportDeclaration(stmt)) {
      if (stmt.isTypeOnly) continue; // `export type { X }` — erased.
      if (stmt.moduleSpecifier) {
        // `export { x } from './y'` / `export * from './y'` re-exports something this file
        // never declares, so it cannot be verified as async-only without resolving './y'. A
        // 'use server' file has no business re-exporting from elsewhere, so this fails closed.
        violations.push(`${label}: re-exports from another module, which cannot be verified as async-only`);
        continue;
      }
      if (stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
        for (const element of stmt.exportClause.elements) {
          if (element.isTypeOnly) continue;
          const localName = (element.propertyName ?? element.name).text;
          const classification = locals.get(localName) ?? 'other';
          if (classification !== 'async-function') {
            violations.push(`${label}: export { ${element.name.text} } re-exports a non-async value`);
          }
        }
      }
      continue;
    }
  }

  return violations;
}

describe("'use server' modules export nothing but async functions", () => {
  const useServerFiles = walk('src').filter((file) => isUseServerFile(fs.readFileSync(path.join(ROOT, file), 'utf8')));

  it('finds at least the known server-actions modules (a scan that matches nothing proves nothing)', () => {
    expect(useServerFiles.length).toBeGreaterThanOrEqual(15);
    expect(useServerFiles).toContain('src/app/(app)/settings/managers/actions.ts');
    // The doc comment in revalidation-routes.ts talks about 'use server' but is not one —
    // proof the scan reads the directive position, not a text search for the phrase.
    expect(useServerFiles).not.toContain('src/app/(app)/settings/managers/revalidation-routes.ts');
  });

  it('every export in every one of them is an async function', () => {
    const offenders = useServerFiles.flatMap((file) => {
      const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
      const scriptKind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
      return findViolations(file, source, scriptKind);
    });
    expect(offenders).toEqual([]);
  });

  // The real bug (v1.5.0): actions.ts exported CATEGORY_RENDERING_ROUTES, a plain array, from a
  // 'use server' file. `next build` and the whole vitest suite both passed anyway — neither
  // applies 'use server' semantics — so the crash only ever showed up when the real Next
  // server required the compiled module in production. These fixtures are that exact class of
  // bug, and every other shape the brief calls out, exercised directly against the scanner
  // (not against a file on disk) so this guard's own logic is proven before it is trusted.
  describe('scanner correctness (synthetic fixtures, one per exportable shape)', () => {
    const bad: Record<string, string> = {
      'a plain array const (the actual v1.5.0 bug)': `'use server';\nexport const ROUTES = ['/a', '/b'];\n`,
      'let': `'use server';\nexport let counter = 0;\n`,
      'var': `'use server';\nexport var counter = 0;\n`,
      'a non-async arrow function': `'use server';\nexport const helper = () => 1;\n`,
      'a non-async function declaration': `'use server';\nexport function helper() { return 1; }\n`,
      class: `'use server';\nexport class Helper {}\n`,
      enum: `'use server';\nexport enum Kind { A, B }\n`,
      'a non-async default export function': `'use server';\nexport default function helper() { return 1; }\n`,
      'a non-async default export expression': `'use server';\nconst helper = () => 1;\nexport default helper;\n`,
      'a bare re-export of a non-async local': `'use server';\nconst helper = () => 1;\nexport { helper };\n`,
      'a re-export from another module': `'use server';\nexport { helper } from './other';\n`,
    };

    for (const [description, source] of Object.entries(bad)) {
      it(`flags ${description}`, () => {
        const violations = findViolations('fixture.ts', source, ts.ScriptKind.TS);
        expect(violations.length).toBeGreaterThan(0);
      });
    }

    const good: Record<string, string> = {
      'an exported async function': `'use server';\nexport async function action() { return 1; }\n`,
      'an exported const bound to an async arrow function': `'use server';\nexport const action = async () => 1;\n`,
      'an exported const bound to an async function expression': `'use server';\nexport const action = async function () { return 1; };\n`,
      'a non-exported helper of any shape (arrays, classes, sync functions)': `'use server';\nconst ROUTES = ['/a'];\nclass Helper {}\nfunction sync() { return 1; }\nexport async function action() { return ROUTES.length + sync() + (new Helper() ? 1 : 0); }\n`,
      'export type': `'use server';\nexport type Foo = { id: number };\nexport async function action() { return 1; }\n`,
      'export interface': `'use server';\nexport interface Foo { id: number }\nexport async function action() { return 1; }\n`,
      'export default async function': `'use server';\nexport default async function action() { return 1; }\n`,
      'a bare re-export of an async local': `'use server';\nasync function action() { return 1; }\nexport { action };\n`,
      'export default referring to an async local': `'use server';\nasync function action() { return 1; }\nexport default action;\n`,
    };

    for (const [description, source] of Object.entries(good)) {
      it(`does not flag ${description}`, () => {
        expect(findViolations('fixture.ts', source, ts.ScriptKind.TS)).toEqual([]);
      });
    }
  });
});

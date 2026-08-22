import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const read = (relative: string) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

describe('MUST-8.4 / MUST-8.7: the vendoring script', () => {
  const source = read('scripts/vendor-scanner-assets.mjs');

  it('performs no network access', () => {
    expect(source).not.toMatch(/(?<![.\w])fetch\s*\(/);
    expect(source).not.toMatch(/https?:\/\//);
  });

  it('accepts exactly the two documented dist shapes and prints the listing on anything else', () => {
    expect(source).toContain('INLINED_GLUE_MIN_BYTES');
    expect(source).toContain("entry.endsWith('.wasm')");
    expect(source).toContain('Two shapes are accepted');
    expect(source).toMatch(/wasmFiles\.length > 1/);
  });

  it('is wired to an npm script and to nothing that runs on install', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    expect(pkg.scripts['vendor-scanner-assets']).toBe('node scripts/vendor-scanner-assets.mjs');
    for (const hook of ['postinstall', 'prepare']) {
      expect(pkg.scripts[hook] ?? '').not.toContain('vendor-scanner-assets');
    }
  });
});

describe('MUST-8.7: public/scanner is generated, not committed', () => {
  it('is listed in .gitignore', () => {
    expect(read('.gitignore').split(/\r?\n/).map((line) => line.trim())).toContain('/public/scanner/');
  });
});

describe('MUST-11.5: the scanner loads nothing off-origin', () => {
  it('src/lib/scanner names no CDN host', () => {
    for (const entry of fs.readdirSync(path.join(ROOT, 'src/lib/scanner'))) {
      const source = read(path.posix.join('src/lib/scanner', entry));
      for (const host of ['docs.opencv.org', 'cdn.jsdelivr.net', 'unpkg.com']) {
        expect(source).not.toContain(host);
      }
    }
  });

  it('every script the loader injects is a same-origin /scanner/ path', () => {
    const source = read('src/lib/scanner/load.ts');
    expect(source).toContain("'/scanner/opencv.js'");
    expect(source).toContain("'/scanner/jscanify.min.js'");
    expect(source).not.toMatch(/src\s*=\s*['"`]https?:/);
  });
});

/**
 * Plan resolution 14. Everything under src/lib/scanner/ is reachable from a 'use client'
 * component, so a single value-import of a server module drags node:fs and @/lib/env into
 * the browser bundle. Nothing before `npm run build` in the release task catches that, and
 * the release task is the wrong place to find out. The directory is walked rather than
 * listed by name so scan.ts is covered the moment Task 11 creates it.
 */
describe('src/lib/scanner is client-safe', () => {
  const entries = fs
    .readdirSync(path.join(ROOT, 'src/lib/scanner'))
    .filter((entry) => entry.endsWith('.ts') || entry.endsWith('.tsx'));

  it('has files to check, so a move cannot make this suite vacuous', () => {
    expect(entries.length).toBeGreaterThan(0);
  });

  it.each(entries)('%s imports no node builtin and no server-only module', (entry) => {
    const source = read(path.posix.join('src/lib/scanner', entry));
    expect(source).not.toMatch(/from\s+['"]node:/);
    expect(source).not.toMatch(/from\s+['"]@\/lib\/env['"]/);
    expect(source).not.toMatch(/from\s+['"]@\/db/);
    expect(source).not.toMatch(/from\s+['"]@\/lib\/settings['"]/);
    // receipts.ts is the specific trap: MAX_RECEIPT_BYTES looks harmless and the module it
    // lives in pulls node:fs, node:path, node:crypto and @/lib/env. Use
    // SCANNER_MAX_OUTPUT_BYTES from the constants block instead; constants.test.ts pins the
    // two equal.
    expect(source).not.toMatch(/from\s+['"]@\/lib\/warranty\/receipts['"]/);
  });

  it('reaches outside its own directory only for the client-safe constants file', () => {
    // An allowlist rather than a denylist: the next server module someone reaches for will
    // not be one anybody thought to ban.
    for (const entry of entries) {
      const source = read(path.posix.join('src/lib/scanner', entry));
      const appImports = [...source.matchAll(/from\s+['"](@\/[^'"]+)['"]/g)].map((match) => match[1]);
      for (const specifier of appImports) {
        const allowed =
          specifier === '@/lib/warranty/ocr/onnx/constants' || specifier.startsWith('@/lib/scanner/');
        expect(allowed, `${entry} imports ${specifier}`).toBe(true);
      }
    }
  });
});

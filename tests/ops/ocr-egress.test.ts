import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const TREES = ['src/lib/warranty/ocr', 'src/lib/scanner'];

function walk(dir: string): string[] {
  const full = path.join(ROOT, dir);
  if (!fs.existsSync(full)) return [];
  return fs.readdirSync(full, { withFileTypes: true }).flatMap((entry) => {
    const relative = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) return walk(relative);
    return entry.name.endsWith('.ts') || entry.name.endsWith('.tsx') ? [relative] : [];
  });
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const files = TREES.flatMap(walk);
const sources = new Map(files.map((file) => [file, stripComments(fs.readFileSync(path.join(ROOT, file), 'utf8'))]));

describe('MUST-11.6 / AC3: the OCR and scanner trees make no outbound call', () => {
  it('has at least one file to scan, so a rename cannot make this suite vacuous', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it('contains no fetch( call site at all', () => {
    const offenders = [...sources].filter(([, source]) => /(?<![.\w])fetch\s*\(/.test(source)).map(([file]) => file);
    expect(offenders).toEqual([]);
  });

  it('contains no :// literal at all', () => {
    const offenders = [...sources]
      .filter(([, source]) => /(['"`])[^'"`]*:\/\/[^'"`]*\1/.test(source))
      .map(([file]) => file);
    expect(offenders).toEqual([]);
  });

  it('imports no HTTP client library', () => {
    const banned = /from\s+['"](axios|node-fetch|got|undici|superagent|ky|request)['"]/;
    const offenders = [...sources].filter(([, source]) => banned.test(source)).map(([file]) => file);
    expect(offenders).toEqual([]);
  });

  it('names no model host, CDN host or ModelScope', () => {
    const banned = /modelscope|ModelScope|docs\.opencv\.org|cdn\.jsdelivr\.net|unpkg\.com|raw\.githubusercontent/i;
    const offenders = [...sources].filter(([, source]) => banned.test(source)).map(([file]) => file);
    expect(offenders).toEqual([]);
  });
});

describe('MUST-2.3: onnxruntime-node is imported in exactly two places', () => {
  it('is session.ts and scripts/ocr-probe.mjs, and nowhere else', () => {
    const hits: string[] = [];
    const scan = (relative: string) => {
      const source = stripComments(fs.readFileSync(path.join(ROOT, relative), 'utf8'));
      if (source.includes("'onnxruntime-node'")) hits.push(relative);
    };
    const srcFiles = walk('src');
    for (const file of srcFiles) scan(file);
    for (const file of fs.readdirSync(path.join(ROOT, 'scripts'))) {
      if (file.endsWith('.mjs') || file.endsWith('.ts')) scan(path.posix.join('scripts', file));
    }
    expect(hits.sort()).toEqual(['scripts/ocr-probe.mjs', 'src/lib/warranty/ocr/onnx/session.ts']);
  });

  it('both imports are dynamic, so a broken native binding does not kill module evaluation', () => {
    for (const file of ['src/lib/warranty/ocr/onnx/session.ts', 'scripts/ocr-probe.mjs']) {
      const source = stripComments(fs.readFileSync(path.join(ROOT, file), 'utf8'));
      expect(source).toMatch(/await import\(['"]onnxruntime-node['"]\)|import\(['"]onnxruntime-node['"]\)/);
      expect(source).not.toMatch(/^\s*import .* from ['"]onnxruntime-node['"]/m);
    }
  });
});

describe('MUST-2.2: nothing under onnx/ reaches a client component except constants.ts', () => {
  it('no *-client.tsx or "use client" file value-imports a non-constants onnx module', () => {
    const banned = /from\s+['"]@\/lib\/warranty\/ocr\/onnx\/(?!constants)/;
    const offenders: string[] = [];
    for (const file of walk('src/app').concat(walk('src/components'))) {
      const raw = fs.readFileSync(path.join(ROOT, file), 'utf8');
      if (!raw.includes("'use client'")) continue;
      for (const line of stripComments(raw).split('\n')) {
        if (!banned.test(line)) continue;
        if (/^\s*import\s+type\s/.test(line)) continue;
        offenders.push(`${file}: ${line.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('MUST-12.1 / AC9: no migration', () => {
  it('drizzle/ holds no OCR object', () => {
    const dir = path.join(ROOT, 'drizzle');
    for (const entry of fs.readdirSync(dir)) {
      if (!entry.endsWith('.sql')) continue;
      expect(fs.readFileSync(path.join(dir, entry), 'utf8')).not.toMatch(/ocr[._]engine/i);
    }
  });

  it('src/db/schema.ts gains no OCR column', () => {
    const source = fs.readFileSync(path.join(ROOT, 'src/db/schema.ts'), 'utf8');
    expect(source).not.toMatch(/ocr_engine|ocrEngine/);
  });
});

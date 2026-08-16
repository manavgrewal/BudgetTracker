import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * MUST-7.5, second assertion: the construction call passes all four path options.
 * Asserted against the SOURCE TEXT rather than by running the engine, because MUST-7.17
 * forbids any test loading real WASM or reading eng.traineddata.
 */
describe('tesseract worker construction', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'src/lib/warranty/ocr/engine.ts'), 'utf8');
  const call = source.slice(source.indexOf('createWorker('), source.indexOf('as unknown as TesseractWorkerLike'));

  it.each(['workerPath', 'corePath', 'langPath', 'cachePath'])('passes %s', (option) => {
    expect(call).toContain(`${option}: assets.${option}`);
  });

  it('sets gzip true (the vendored asset is a .gz) and cacheMethod none (read-only rootfs)', () => {
    expect(call).toContain('gzip: true');
    expect(call).toContain("cacheMethod: 'none'");
  });

  it('passes an errorHandler (CRITICAL 1): without one, createWorker.js throws inside a worker message listener and crashes the process', () => {
    expect(call).toContain('errorHandler:');
  });

  it('never mentions a URL or a CDN host', () => {
    expect(source).not.toMatch(/https?:\/\//);
    expect(source).not.toContain('unpkg');
    expect(source).not.toContain('jsdelivr');
  });
});

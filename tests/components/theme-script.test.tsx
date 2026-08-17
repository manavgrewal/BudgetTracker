import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ThemeScript } from '@/components/theme/theme-script';
import { THEME_STORAGE_KEY } from '@/components/theme/theme';

const ROOT = path.resolve(__dirname, '..', '..');

describe('ThemeScript', () => {
  it('carries the per-request nonce — without it the CSP blocks the script and every visit flashes light', () => {
    const html = renderToStaticMarkup(<ThemeScript nonce="nonce-under-test" />);
    expect(html).toContain('nonce="nonce-under-test"');
  });

  it('emits no nonce attribute at all when there is none, rather than an empty one', () => {
    const html = renderToStaticMarkup(<ThemeScript />);
    expect(html).toContain('<script');
    expect(html).not.toContain('nonce=');
  });

  it('resolves the stored preference against the device preference before paint', () => {
    const html = renderToStaticMarkup(<ThemeScript nonce="n" />);
    expect(html).toContain(THEME_STORAGE_KEY);
    expect(html).toContain('prefers-color-scheme: dark');
    expect(html).toContain("classList.toggle('dark'");
  });
});

describe('root layout nonce wiring', () => {
  // The unit test above proves the component honours a nonce; this proves the
  // layout actually hands it one. Reading the source is deliberate: rendering
  // the layout would drag the Tailwind entrypoint through PostCSS for no gain.
  const source = readFileSync(path.join(ROOT, 'src', 'app', 'layout.tsx'), 'utf8');

  it('reads the middleware nonce off the request headers', () => {
    expect(source).toContain("headers()).get('x-nonce')");
  });

  it('passes that nonce to ThemeScript', () => {
    expect(source).toContain('<ThemeScript nonce={nonce} />');
  });
});

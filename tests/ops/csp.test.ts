import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { securityHeaders } from '@/lib/auth/security-headers';

const csp = (nonce?: string) => securityHeaders(nonce)['Content-Security-Policy'];

describe("MUST-8.9 / AC11: script-src gains 'wasm-unsafe-eval' and nothing else", () => {
  it("contains 'wasm-unsafe-eval' with and without a nonce", () => {
    expect(csp()).toContain("'wasm-unsafe-eval'");
    expect(csp('abc123')).toContain("'wasm-unsafe-eval'");
  });

  it("never contains the far broader 'unsafe-eval'", () => {
    for (const policy of [csp(), csp('abc123')]) {
      expect(policy).not.toMatch(/(?<!wasm-)'unsafe-eval'/);
    }
  });

  it('adds the token to script-src, not to some other directive', () => {
    const scriptSrc = csp('abc123')
      .split('; ')
      .find((directive) => directive.startsWith('script-src '));
    expect(scriptSrc).toContain("'wasm-unsafe-eval'");
  });

  it('the nonce branch still works', () => {
    expect(csp('abc123')).toContain("'nonce-abc123'");
    expect(csp()).not.toContain('nonce-');
  });

  it('every other directive is untouched', () => {
    const policy = csp('abc123');
    for (const directive of [
      "default-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "font-src 'self'",
      "connect-src 'self'",
      "form-action 'self'",
      "base-uri 'self'",
      "object-src 'none'",
      "frame-ancestors 'none'",
    ]) {
      expect(policy).toContain(directive);
    }
  });

  it('the reason the token is there is written down beside it', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'src/lib/auth/security-headers.ts'), 'utf8');
    expect(source).toMatch(/WebAssembly/);
    expect(source).toMatch(/does not re-enable/);
  });
});

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { securityHeaders } from '@/lib/auth/security-headers';

const ROOT = process.cwd();

function walk(dir: string): string[] {
  const full = path.join(ROOT, dir);
  return fs.readdirSync(full, { withFileTypes: true }).flatMap((entry) => {
    const relative = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) return walk(relative);
    return /\.(ts|tsx)$/.test(entry.name) ? [relative] : [];
  });
}

describe('MUST-8.1 / MUST-8.3 / AC11 / risk R14: there is no viewfinder', () => {
  // Re-enabled by Task 11: the doc comment in src/components/warranty/ReceiptUploader.tsx
  // that used to read "No native app, no getUserMedia, no canvas." was reworded once that
  // task wired in jscanify's canvas crop (making "no canvas" untrue) and no longer contains
  // either banned substring, so the scan below now passes for real rather than vacuously.
  it('getUserMedia and mediaDevices appear nowhere under src/', () => {
    const offenders = walk('src').filter((file) => {
      const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
      return source.includes('getUserMedia') || source.includes('mediaDevices');
    });
    expect(offenders).toEqual([]);
  });

  it('Permissions-Policy still denies the camera', () => {
    expect(securityHeaders()['Permissions-Policy']).toContain('camera=()');
  });

  it('the file input still hands off to the phone camera app', () => {
    const source = fs.readFileSync(path.join(ROOT, 'src/components/warranty/ReceiptUploader.tsx'), 'utf8');
    expect(source).toContain('capture="environment"');
    expect(source).toContain('accept="image/*,application/pdf"');
  });
});

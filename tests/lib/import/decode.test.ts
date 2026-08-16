import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import iconv from 'iconv-lite';
import { decodeBuffer, isStrictUtf8 } from '@/lib/import/decode';

const fixture = (name: string) => fs.readFileSync(path.join(process.cwd(), 'fixtures', name));

describe('isStrictUtf8', () => {
  it('accepts plain ASCII and valid UTF-8', () => {
    expect(isStrictUtf8(Buffer.from('hello,world', 'utf8'))).toBe(true);
    expect(isStrictUtf8(Buffer.from('CAFÉ MÉTRO', 'utf8'))).toBe(true);
  });

  it('rejects a windows-1252 accented byte sequence', () => {
    expect(isStrictUtf8(iconv.encode('CAFÉ MÉTRO', 'win1252'))).toBe(false);
  });
});

describe('decodeBuffer with encoding "auto"', () => {
  it('decodes UTF-8 accents correctly', () => {
    const result = decodeBuffer(Buffer.from('MÉTRO PLUS,12.34', 'utf8'), 'auto');
    expect(result.encoding).toBe('utf-8');
    expect(result.text).toBe('MÉTRO PLUS,12.34');
  });

  it('falls back to windows-1252 when strict UTF-8 fails', () => {
    const result = decodeBuffer(fixture('td-chequing-win1252.csv'), 'auto');
    expect(result.encoding).toBe('windows-1252');
    expect(result.text).toContain('CAFÉ RÉPUBLIQUE');
    expect(result.text).toContain('MÉTRO PLUS');
    expect(result.text).toContain('HYDRO-QUÉBEC');
    // the mojibake a wrong guess would produce
    expect(result.text).not.toContain('Ã‰');
  });

  it('strips a UTF-8 BOM', () => {
    const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('Date,Amount', 'utf8')]);
    expect(decodeBuffer(withBom, 'auto').text).toBe('Date,Amount');
  });

  it('handles an empty buffer', () => {
    expect(decodeBuffer(Buffer.alloc(0), 'auto')).toEqual({ text: '', encoding: 'utf-8' });
  });
});

describe('decodeBuffer with a forced encoding', () => {
  it('honours an explicit windows-1252 override even on valid UTF-8 bytes', () => {
    const utf8 = Buffer.from('CAFÉ', 'utf8');
    const result = decodeBuffer(utf8, 'windows-1252');
    expect(result.encoding).toBe('windows-1252');
    expect(result.text).toBe('CAFÃ‰');
  });

  it('honours an explicit utf-8 override and replaces undecodable bytes rather than throwing', () => {
    const latin = iconv.encode('CAFÉ', 'win1252');
    const result = decodeBuffer(latin, 'utf-8');
    expect(result.encoding).toBe('utf-8');
    expect(result.text).toContain('�');
  });
});

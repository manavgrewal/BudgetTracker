import { describe, it, expect } from 'vitest';
import {
  RECEIPT_MIMES,
  extForMime,
  looksLikeHeic,
  mimeForExt,
  sniffReceiptType,
  UNSUPPORTED_TYPE_MESSAGE,
} from '@/lib/warranty/sniff';

const jpeg = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32)]);
const png = () => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
const webp = () => {
  const buf = Buffer.alloc(40);
  buf.write('RIFF', 0, 'ascii');
  buf.write('WEBP', 8, 'ascii');
  return buf;
};
const pdf = () => Buffer.concat([Buffer.from('%PDF-1.7\n', 'ascii'), Buffer.alloc(32)]);

describe('sniffReceiptType', () => {
  it('detects all four accepted types by leading bytes', () => {
    expect(sniffReceiptType(jpeg())).toBe('image/jpeg');
    expect(sniffReceiptType(png())).toBe('image/png');
    expect(sniffReceiptType(webp())).toBe('image/webp');
    expect(sniffReceiptType(pdf())).toBe('application/pdf');
    expect(RECEIPT_MIMES).toHaveLength(4);
  });

  it('rejects a .pdf-named ZIP', () => {
    const zip = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(32)]);
    expect(sniffReceiptType(zip)).toBeNull();
  });

  it('rejects a RIFF container that is not WEBP', () => {
    const wav = Buffer.alloc(40);
    wav.write('RIFF', 0, 'ascii');
    wav.write('WAVE', 8, 'ascii');
    expect(sniffReceiptType(wav)).toBeNull();
  });

  // Spec §15.1 (Controller ruling P11): buffers too short to reliably identify are
  // rejected outright, even when their first few bytes happen to match a signature
  // prefix (FF D8 FF *is* the complete JPEG signature, but 3 bytes alone is not
  // enough of a file to trust — a real JPEG always carries more than its marker).
  it('rejects an empty buffer and a 3-byte buffer, even one matching a signature prefix', () => {
    expect(sniffReceiptType(Buffer.alloc(0))).toBeNull();
    expect(sniffReceiptType(Buffer.from([0xff, 0xd8, 0xff]))).toBeNull();
    expect(sniffReceiptType(Buffer.from([0x89, 0x50, 0x4e]))).toBeNull();
  });

  it('rejects a text file whatever the client declared its Content-Type to be', () => {
    expect(sniffReceiptType(Buffer.from('date,description,amount\n', 'utf8'))).toBeNull();
  });

  it('recognises HEIC so the UI can give the Preview-export advice', () => {
    const heic = Buffer.alloc(24);
    heic.write('ftypheic', 4, 'ascii');
    expect(looksLikeHeic(heic)).toBe(true);
    expect(sniffReceiptType(heic)).toBeNull();
    expect(looksLikeHeic(jpeg())).toBe(false);
  });

  it('maps mime to extension and back', () => {
    expect(extForMime('image/jpeg')).toBe('jpg');
    expect(extForMime('image/png')).toBe('png');
    expect(extForMime('image/webp')).toBe('webp');
    expect(extForMime('application/pdf')).toBe('pdf');
    expect(mimeForExt('jpg')).toBe('image/jpeg');
    expect(mimeForExt('exe')).toBeNull();
  });

  it('has a message naming the four accepted types', () => {
    expect(UNSUPPORTED_TYPE_MESSAGE).toBe("That file type isn't supported. Upload a JPEG, PNG, WebP or PDF.");
  });
});

/**
 * MUST-4.5: the accepted set is exactly four types, decided by LEADING BYTES —
 * never by the file extension and never by the browser-declared Content-Type.
 */
export type ReceiptMime = 'image/jpeg' | 'image/png' | 'image/webp' | 'application/pdf';
export type ReceiptExt = 'jpg' | 'png' | 'webp' | 'pdf';

export const RECEIPT_MIMES: readonly ReceiptMime[] = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
export const RECEIPT_EXTS: readonly ReceiptExt[] = ['jpg', 'png', 'webp', 'pdf'];

export const UNSUPPORTED_TYPE_MESSAGE = "That file type isn't supported. Upload a JPEG, PNG, WebP or PDF.";

/** §16 item 7: HEIC is a known limitation with a documented workaround, not a mystery failure. */
export const HEIC_MESSAGE =
  "HEIC isn't supported. On a Mac, open the image in Preview and export it as JPEG, or upload it from your phone instead.";

const MIME_TO_EXT: Record<ReceiptMime, ReceiptExt> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
};

const EXT_TO_MIME: Record<string, ReceiptMime> = {
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  pdf: 'application/pdf',
};

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PDF_SIG = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d]); // "%PDF-"
const RIFF_SIG = Buffer.from([0x52, 0x49, 0x46, 0x46]); // "RIFF"
const WEBP_SIG = Buffer.from([0x57, 0x45, 0x42, 0x50]); // "WEBP"
const FTYP_SIG = Buffer.from([0x66, 0x74, 0x79, 0x70]); // "ftyp"

/**
 * Controller ruling P11 (spec §15.1 is binding here): a buffer too short to
 * reliably be a real file is rejected outright, even if its first few bytes
 * happen to match a signature prefix. 12 is the largest offset any signature
 * check below reads from (the WEBP check inspects bytes 8-11), so anything
 * shorter can never be a genuine instance of any of the four accepted types —
 * e.g. `FF D8 FF` alone is the complete JPEG marker, but a 3-byte "file" is
 * never a real JPEG and must not sniff as one.
 */
export const MIN_SNIFF_BYTES = 12;

export function sniffReceiptType(buf: Buffer): ReceiptMime | null {
  if (buf.length < MIN_SNIFF_BYTES) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.subarray(0, 8).equals(PNG_SIG)) return 'image/png';
  // Exact byte compare, not toString('ascii') — ascii decoding masks off the
  // high bit of every byte, so a binary buffer with high-bit-set bytes that
  // are otherwise unrelated to RIFF/WEBP can decode to those four-letter
  // strings and be misidentified as image/webp. .equals() compares raw bytes
  // with no encoding round-trip, so it cannot be fooled that way.
  if (buf.subarray(0, 4).equals(RIFF_SIG) && buf.subarray(8, 12).equals(WEBP_SIG)) {
    return 'image/webp';
  }
  if (buf.subarray(0, 5).equals(PDF_SIG)) return 'application/pdf';
  return null;
}

/** ISO-BMFF brand check, used only to pick a better error message. Never accepts the file. */
export function looksLikeHeic(buf: Buffer): boolean {
  if (buf.length < 12) return false;
  // Same exact-byte-compare rationale as the RIFF/WEBP check above.
  if (!buf.subarray(4, 8).equals(FTYP_SIG)) return false;
  const brand = buf.subarray(8, 12).toString('ascii').toLowerCase();
  return brand.startsWith('hei') || brand.startsWith('mif1') || brand.startsWith('heix') || brand.startsWith('hevc');
}

export function extForMime(mime: ReceiptMime): ReceiptExt {
  return MIME_TO_EXT[mime];
}

export function mimeForExt(ext: string): ReceiptMime | null {
  return EXT_TO_MIME[ext.toLowerCase()] ?? null;
}

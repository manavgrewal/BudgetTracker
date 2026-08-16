import iconv from 'iconv-lite';
import type { EncodingChoice } from './mapping';

export type DetectedEncoding = 'utf-8' | 'windows-1252';

export function isStrictUtf8(buf: Buffer): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return true;
  } catch {
    return false;
  }
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Spec section 5 step 2: strict UTF-8 first, windows-1252 fallback via iconv-lite.
 * A wrong guess is exactly what turns MÉTRO into MÃ‰TRO, so "auto" never uses a
 * lossy UTF-8 decode — it only accepts UTF-8 when the bytes are strictly valid.
 */
export function decodeBuffer(buf: Buffer, requested: EncodingChoice): { text: string; encoding: DetectedEncoding } {
  if (requested === 'windows-1252') {
    return { text: stripBom(iconv.decode(buf, 'win1252')), encoding: 'windows-1252' };
  }
  if (requested === 'utf-8') {
    return { text: stripBom(new TextDecoder('utf-8').decode(buf)), encoding: 'utf-8' };
  }
  if (isStrictUtf8(buf)) {
    return { text: stripBom(new TextDecoder('utf-8').decode(buf)), encoding: 'utf-8' };
  }
  return { text: stripBom(iconv.decode(buf, 'win1252')), encoding: 'windows-1252' };
}

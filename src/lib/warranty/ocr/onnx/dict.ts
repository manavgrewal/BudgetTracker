import { REC_BLANK_INDEX, REC_USE_SPACE_CHAR } from '@/lib/warranty/ocr/onnx/constants';
import { DICT_FILENAME, resolveOnnxOcrAssets } from '@/lib/warranty/ocr/onnx/models';
import fs from 'node:fs';

export interface RecDictionary {
  /** Index REC_BLANK_INDEX is the CTC blank. Length is the expected class count. */
  entries: readonly string[];
  classCount: number;
}

/**
 * MUST-3.15's procedure, in this order and no other. Do NOT trim whitespace and do NOT drop
 * an interior empty line: a space character on its own line is a legitimate entry in some
 * PaddleOCR dictionaries and dropping it silently shifts every index after it, which
 * decodes every receipt into plausible-looking nonsense.
 */
export function buildRecDictionary(fileText: string): RecDictionary {
  const parts = fileText.split('\n');
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  if (REC_USE_SPACE_CHAR) parts.push(' ');
  const entries: string[] = [];
  entries[REC_BLANK_INDEX] = '';
  entries.push(...parts);
  return { entries, classCount: entries.length };
}

let cached: RecDictionary | null = null;

export function loadRecDictionary(): RecDictionary {
  if (cached !== null) return cached;
  cached = buildRecDictionary(fs.readFileSync(resolveOnnxOcrAssets().dictPath, 'utf8'));
  return cached;
}

export function resetRecDictionaryForTests(): void {
  cached = null;
}

/**
 * MUST-3.16, and it is load-bearing. A wrong dictionary does not fail on its own; it
 * decodes into confident nonsense, which is indistinguishable from the bug this release
 * exists to fix. Recognition never runs on a mismatch.
 */
export function assertRecClassCount(dictionary: RecDictionary, modelClassCount: number): void {
  if (dictionary.classCount === modelClassCount) return;
  throw new Error(
    `${DICT_FILENAME} yields ${dictionary.classCount} classes but the recognition model declares ${modelClassCount}. ` +
      'Recognition will not run: a mismatched dictionary decodes every receipt into nonsense that looks correct.',
  );
}

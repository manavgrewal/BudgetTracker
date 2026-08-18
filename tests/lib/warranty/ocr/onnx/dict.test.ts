import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import { REC_BASE_WIDTH, REC_BLANK_INDEX, REC_INPUT_HEIGHT } from '@/lib/warranty/ocr/onnx/constants';
import { resolveOnnxOcrAssets } from '@/lib/warranty/ocr/onnx/models';
import {
  assertRecClassCount,
  buildRecDictionary,
  loadRecDictionary,
  resetRecDictionaryForTests,
} from '@/lib/warranty/ocr/onnx/dict';

afterEach(() => resetRecDictionaryForTests());

describe('buildRecDictionary (MUST-3.15)', () => {
  it('puts the CTC blank at index 0', () => {
    const dictionary = buildRecDictionary('a\nb\nc\n');
    expect(REC_BLANK_INDEX).toBe(0);
    expect(dictionary.entries[0]).toBe('');
    expect(dictionary.entries[1]).toBe('a');
  });

  it('drops exactly one trailing empty element and no other', () => {
    const withNewline = buildRecDictionary('a\nb\n');
    const withoutNewline = buildRecDictionary('a\nb');
    expect(withNewline.entries).toEqual(withoutNewline.entries);
  });

  it('keeps a lone space entry rather than trimming it, which would shift every later index', () => {
    const dictionary = buildRecDictionary('a\n \nb\n');
    // blank, 'a', ' ', 'b', and the appended use-space entry.
    expect(dictionary.entries[2]).toBe(' ');
    expect(dictionary.entries[3]).toBe('b');
  });

  it('appends exactly one space entry when REC_USE_SPACE_CHAR is on', () => {
    const dictionary = buildRecDictionary('a\nb\n');
    expect(dictionary.entries.filter((entry) => entry === ' ')).toHaveLength(1);
    expect(dictionary.entries.at(-1)).toBe(' ');
    expect(dictionary.classCount).toBe(dictionary.entries.length);
    expect(dictionary.classCount).toBe(4);
  });
});

describe('assertRecClassCount (MUST-3.16)', () => {
  it('passes when the counts agree', () => {
    const dictionary = buildRecDictionary('a\nb\n');
    expect(() => assertRecClassCount(dictionary, 4)).not.toThrow();
  });

  it('throws naming both numbers when they disagree', () => {
    const dictionary = buildRecDictionary('a\nb\n');
    expect(() => assertRecClassCount(dictionary, 97)).toThrow(/\b4\b[\s\S]*\b97\b|\b97\b[\s\S]*\b4\b/);
  });

  it('names the dictionary file in the message so the fix is obvious', () => {
    const dictionary = buildRecDictionary('a\n');
    expect(() => assertRecClassCount(dictionary, 5)).toThrow(/en_dict\.txt/);
  });
});

describe('AC10: the real dictionary matches the real recognition model', () => {
  it('loads the committed dictionary without throwing', () => {
    const dictionary = loadRecDictionary();
    expect(dictionary.classCount).toBeGreaterThan(90);
    expect(dictionary.entries[0]).toBe('');
  });

  it('is memoised across calls', () => {
    expect(loadRecDictionary()).toBe(loadRecDictionary());
  });

  // The single most important assertion in this release. If it fails, nothing else
  // matters: every receipt would decode into plausible-looking nonsense.
  it("equals the recognition model's declared output width", async () => {
    const ort = await import('onnxruntime-node');
    const session = await ort.InferenceSession.create(resolveOnnxOcrAssets().recPath);
    try {
      const input = new ort.Tensor(
        'float32',
        new Float32Array(3 * REC_INPUT_HEIGHT * REC_BASE_WIDTH),
        [1, 3, REC_INPUT_HEIGHT, REC_BASE_WIDTH],
      );
      const output = await session.run({ [session.inputNames[0]]: input });
      const dims = output[session.outputNames[0]].dims;
      expect(dims).toHaveLength(3);
      expect(dims[2]).toBe(loadRecDictionary().classCount);
    } finally {
      await session.release();
    }
  });

  it('a deliberately truncated dictionary fails the guard with both numbers', () => {
    const real = fs.readFileSync(resolveOnnxOcrAssets().dictPath, 'utf8');
    const truncated = buildRecDictionary(real.split('\n').slice(0, 20).join('\n'));
    const expected = loadRecDictionary().classCount;
    expect(() => assertRecClassCount(truncated, expected)).toThrow(String(expected));
    expect(() => assertRecClassCount(truncated, expected)).toThrow(String(truncated.classCount));
  });
});

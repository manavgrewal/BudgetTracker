import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { onnxOcrEngine } from '@/lib/warranty/ocr/onnx/engine';
import { detResize } from '@/lib/warranty/ocr/onnx/detect';
import { preprocessReceipt } from '@/lib/warranty/ocr/onnx/preprocess';
import { setOnnxSessionsForTests, type OnnxOcrSessions } from '@/lib/warranty/ocr/onnx/session';
import { solidRgb } from '../../../../helpers/ocr-images';

const DICT = ['', 'T', 'O', 'A', 'L', ' '];

afterEach(() => {
  setOnnxSessionsForTests(null);
  vi.restoreAllMocks();
});

async function receiptFile(): Promise<{ file: string; dir: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-ocr-engine-'));
  const width = 1400;
  const height = 900;
  const png = await sharp(solidRgb(width, height, [250, 250, 250]), {
    raw: { width, height, channels: 3 },
  })
    .png()
    .toBuffer();
  const file = path.join(dir, 'receipt.png');
  fs.writeFileSync(file, png);
  return { file, dir };
}

/**
 * A fake session set that reports one box covering the top strip and decodes it to 'TOTAL'.
 *
 * The detection tensor's shape comes from detResize(PREPROCESSED dims), not from the source
 * file's nominal size: preprocessReceipt resizes and may deskew, so the two differ, and
 * detectBoxes throws on a spatial-dimension mismatch. Running the real preprocess here is
 * cheap and is the only way the fake can agree with what the engine actually asks for.
 */
async function fakeSessions(file: string): Promise<OnnxOcrSessions> {
  const pre = await preprocessReceipt(file);
  const geometry = detResize(pre.width, pre.height);
  return {
    runDet: async () => {
      const map = new Float32Array(geometry.resizeW * geometry.resizeH);
      for (let y = 10; y < 34; y += 1) {
        for (let x = 10; x < 120; x += 1) map[y * geometry.resizeW + x] = 0.95;
      }
      return { data: map, dims: [1, 1, geometry.resizeH, geometry.resizeW] };
    },
    runCls: async (input) => {
      const batch = input.dims[0];
      const data = new Float32Array(batch * 2);
      for (let n = 0; n < batch; n += 1) data[n * 2] = 0.99;
      return { data, dims: [batch, 2] };
    },
    runRec: async (input) => {
      const batch = input.dims[0];
      const steps: number[] = [1, 2, 1, 3, 4];
      const data = new Float32Array(batch * steps.length * DICT.length);
      for (let n = 0; n < batch; n += 1) {
        steps.forEach((cls, t) => {
          data[(n * steps.length + t) * DICT.length + cls] = 0.95;
        });
      }
      return { data, dims: [batch, steps.length, DICT.length] };
    },
    clsInputHeight: 80,
    clsInputWidth: 160,
    recClassCount: DICT.length,
    dictionary: DICT,
  };
}

describe('onnxOcrEngine (MUST-4.1, MUST-4.2)', () => {
  it('satisfies the OcrEngine interface and returns { text }', async () => {
    const { file, dir } = await receiptFile();
    try {
      setOnnxSessionsForTests(await fakeSessions(file));
      const result = await onnxOcrEngine.recognize(file, 'image/png');
      expect(Object.keys(result)).toEqual(['text']);
      expect(result.text).toContain('TOTAL');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('runs no inference at all for a PDF (MUST-4.2, MUST-7.1)', async () => {
    const { file: image, dir } = await receiptFile();
    try {
      let touched = 0;
      setOnnxSessionsForTests({
        ...(await fakeSessions(image)),
        runDet: async () => {
          touched += 1;
          throw new Error('the PDF path must never reach a session');
        },
      });
      const pdf = path.join(dir, 'not-a-pdf.pdf');
      fs.writeFileSync(pdf, Buffer.from('not really a pdf'));
      await expect(onnxOcrEngine.recognize(pdf, 'application/pdf')).rejects.toThrow();
      expect(touched).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns an empty string when detection finds nothing, rather than throwing', async () => {
    const { file, dir } = await receiptFile();
    try {
      const pre = await preprocessReceipt(file);
      const geometry = detResize(pre.width, pre.height);
      setOnnxSessionsForTests({
        ...(await fakeSessions(file)),
        runDet: async () => ({
          data: new Float32Array(geometry.resizeW * geometry.resizeH),
          dims: [1, 1, geometry.resizeH, geometry.resizeW],
        }),
      });
      expect(await onnxOcrEngine.recognize(file, 'image/png')).toEqual({ text: '' });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('MUST-4.9: a detection tensor whose spatial dims disagree with the input throws', async () => {
    const { file, dir } = await receiptFile();
    try {
      setOnnxSessionsForTests({
        ...(await fakeSessions(file)),
        runDet: async () => ({ data: new Float32Array(4), dims: [1, 1, 2, 2] }),
      });
      await expect(onnxOcrEngine.recognize(file, 'image/png')).rejects.toThrow(/spatial/i);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('MUST-4.3: a detection failure propagates rather than being swallowed', async () => {
    const { file, dir } = await receiptFile();
    try {
      setOnnxSessionsForTests({
        ...(await fakeSessions(file)),
        runDet: async () => {
          throw new Error('det kernel exploded');
        },
      });
      await expect(onnxOcrEngine.recognize(file, 'image/png')).rejects.toThrow('det kernel exploded');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('MUST-4.3: a recognition failure propagates rather than being swallowed', async () => {
    const { file, dir } = await receiptFile();
    try {
      setOnnxSessionsForTests({
        ...(await fakeSessions(file)),
        runRec: async () => {
          throw new Error('rec kernel exploded');
        },
      });
      await expect(onnxOcrEngine.recognize(file, 'image/png')).rejects.toThrow('rec kernel exploded');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('MUST-4.35: the engine applies no cap of its own', async () => {
    const { file, dir } = await receiptFile();
    try {
      setOnnxSessionsForTests(await fakeSessions(file));
      const source = fs.readFileSync(path.join(process.cwd(), 'src/lib/warranty/ocr/onnx/engine.ts'), 'utf8');
      expect(source).not.toContain('truncateOcrText');
      expect(source).not.toContain('MAX_OCR_TEXT_CHARS');
      await onnxOcrEngine.recognize(file, 'image/png');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

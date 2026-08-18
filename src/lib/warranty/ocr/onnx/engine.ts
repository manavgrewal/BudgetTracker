import type { ReceiptMime } from '@/lib/warranty/sniff';
import type { OcrEngine, OcrResult } from '@/lib/warranty/ocr/engine';
import { extractPdfText } from '@/lib/warranty/ocr/pdf';
import { assembleText, type AssemblyBox } from '@/lib/warranty/ocr/onnx/assemble';
import { classifyAndFlip } from '@/lib/warranty/ocr/onnx/classify';
import { cropBoxes } from '@/lib/warranty/ocr/onnx/crop';
import { detectBoxes } from '@/lib/warranty/ocr/onnx/detect';
import { preprocessReceipt } from '@/lib/warranty/ocr/onnx/preprocess';
import { recognizeCrops } from '@/lib/warranty/ocr/onnx/recognize';
import { getOnnxOcrSessions } from '@/lib/warranty/ocr/onnx/session';

/**
 * The eight stages, in this order, each one the sole responsibility of its module. No stage
 * swallows an error: a throw propagates out of recognize() and the queue records it as a
 * failed job, exactly as a tesseract failure does today. The one exception is the
 * orientation classifier, which handles its own failure inside classifyAndFlip.
 *
 * The engine applies no character cap. That truncation step belongs to the queue.
 */
export const onnxOcrEngine: OcrEngine = {
  async recognize(filePath: string, mime: ReceiptMime): Promise<OcrResult> {
    // A PDF never touches an OCR engine. No session is created and no model is loaded.
    if (mime === 'application/pdf') return { text: await extractPdfText(filePath) };

    const image = await preprocessReceipt(filePath);
    const sessions = await getOnnxOcrSessions();
    const boxes = await detectBoxes(image, sessions.runDet);
    if (boxes.length === 0) return { text: '' };

    const crops = await cropBoxes(image, boxes);
    const oriented = await classifyAndFlip(crops, sessions);
    const lines = await recognizeCrops(oriented, sessions);

    const assembly: AssemblyBox[] = lines.map((line) => ({
      quad: boxes[line.boxIndex].quad,
      text: line.text,
      score: line.score,
    }));
    return { text: assembleText(assembly) };
  },
};

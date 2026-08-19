/**
 * The hardware compatibility probe, run in its own process because an illegal-instruction
 * fault on an ARM core without the features ORT's kernels assume raises SIGILL, and SIGILL
 * terminates the process. It is not a JavaScript exception, so no in-process try/catch can
 * survive it. The parent watches this child die instead.
 *
 * Touches no database, opens no socket, reads no environment variable and writes nothing to
 * disk. It is a pure question about this CPU and these three files.
 *
 * Ruling P10a: every literal below is duplicated from
 * src/lib/warranty/ocr/onnx/{constants,models}.ts, because this script runs inside the
 * runtime image where '@/...' does not resolve and src/ is not present. The probe must load
 * the same graphs with the same options and the same shapes the app will use, or it answers
 * a different question from the one it was asked. tests/scripts/ocr-probe.test.ts pins every
 * one of these against the real exports, so a constant change fails the suite rather than
 * silently desyncing the probe from the thing it probes.
 */
import path from 'node:path';

const OK_LINE = 'ocr-probe-ok';
const DIR = path.join(process.cwd(), 'vendor', 'ocr-models');
const OPTIONS = {
  executionProviders: ['cpu'],
  intraOpNumThreads: 2,
  interOpNumThreads: 1,
  graphOptimizationLevel: 'all',
  logSeverityLevel: 3,
  enableCpuMemArena: false,
};

const CASES = [
  { file: 'ch_PP-OCRv5_det_mobile.onnx', dims: [1, 3, 32, 32] },
  { file: 'ch_PP-LCNet_x0_25_textline_ori_cls_mobile.onnx', dims: [1, 3, 80, 160] },
  { file: 'en_PP-OCRv5_rec_mobile.onnx', dims: [1, 3, 48, 320] },
];

try {
  // Loading the native binding is the first of the two places SIGILL is expected.
  const ort = await import('onnxruntime-node');
  for (const probe of CASES) {
    const session = await ort.InferenceSession.create(path.join(DIR, probe.file), { ...OPTIONS });
    const size = probe.dims.reduce((total, value) => total * value, 1);
    // Executing a real kernel is the second place, which is why the probe does not stop at
    // session creation.
    await session.run({
      [session.inputNames[0]]: new ort.Tensor('float32', new Float32Array(size), probe.dims),
    });
    await session.release();
  }
  console.log(OK_LINE);
  process.exit(0);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

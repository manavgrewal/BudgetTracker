import {
  CLS_INPUT_HEIGHT,
  CLS_INPUT_WIDTH,
  ORT_CPU_MEM_ARENA,
  ORT_GRAPH_OPT,
  ORT_INTER_OP_THREADS,
  ORT_INTRA_OP_THREADS,
  ORT_LOG_SEVERITY,
  REC_BASE_WIDTH,
  REC_INPUT_HEIGHT,
} from '@/lib/warranty/ocr/onnx/constants';
import { assertRecClassCount, loadRecDictionary } from '@/lib/warranty/ocr/onnx/dict';
import { requireVerifiedOnnxOcrAssets, resolveOnnxOcrAssets } from '@/lib/warranty/ocr/onnx/models';

/**
 * One of exactly two places in the tree that import onnxruntime-node (the other is
 * scripts/ocr-probe.mjs). The import is dynamic so a boot on hardware where the native
 * binding cannot even load does not take the process down at module-evaluation time.
 * tests/ops/ocr-egress.test.ts fails on a third import site.
 */

export interface OnnxTensorData {
  data: Float32Array;
  dims: readonly number[];
}

/** The one call a stage module makes into onnxruntime. Nothing else may import ORT. */
export type TensorRun = (input: OnnxTensorData) => Promise<OnnxTensorData>;

export interface OnnxOcrSessions {
  runDet: TensorRun;
  runCls: TensorRun;
  runRec: TensorRun;
  /** Read from the classifier graph; the pinned constants are the symbolic-dimension fallback. */
  clsInputHeight: number;
  clsInputWidth: number;
  /** Verified against the dictionary at creation. */
  recClassCount: number;
  dictionary: readonly string[];
}

interface OrtLike {
  InferenceSession: {
    create(path: string, options: Record<string, unknown>): Promise<OrtSessionLike>;
  };
  Tensor: new (type: 'float32', data: Float32Array, dims: readonly number[]) => unknown;
}

interface OrtSessionLike {
  inputNames: string[];
  outputNames: string[];
  inputMetadata?: { name: string; shape: (number | string)[] }[];
  outputMetadata?: { name: string; shape: (number | string)[] }[];
  run(feeds: Record<string, unknown>): Promise<Record<string, OnnxTensorData>>;
  release(): Promise<void>;
}

type OrtLoader = () => Promise<OrtLike>;

const SESSION_OPTIONS = {
  executionProviders: ['cpu'],
  intraOpNumThreads: ORT_INTRA_OP_THREADS,
  interOpNumThreads: ORT_INTER_OP_THREADS,
  graphOptimizationLevel: ORT_GRAPH_OPT,
  logSeverityLevel: ORT_LOG_SEVERITY,
  // Off on purpose. The arena retains allocated blocks for reuse, which is a throughput
  // optimisation; with a few receipts a day and a 60 second idle teardown, retention is
  // the opposite of what is wanted.
  enableCpuMemArena: ORT_CPU_MEM_ARENA,
} as const;

let loader: OrtLoader = () => import('onnxruntime-node') as unknown as Promise<OrtLike>;
let live: { sessions: OnnxOcrSessions; raw: OrtSessionLike[] } | null = null;
let injected: OnnxOcrSessions | null = null;
let creating: Promise<OnnxOcrSessions> | null = null;

/** Swaps the dynamic onnxruntime-node import for a fake, so session.test.ts can assert the
 *  pinned options and every shape guard without a 12.7 MB model load. */
export function setOrtLoaderForTests(next: OrtLoader | null): void {
  loader = next ?? (() => import('onnxruntime-node') as unknown as Promise<OrtLike>);
}

export function setOnnxSessionsForTests(fake: OnnxOcrSessions | null): void {
  injected = fake;
}

function lastStaticDim(shape: (number | string)[] | undefined, index: number, fallback: number): number {
  const value = shape?.[index];
  return typeof value === 'number' && value > 0 ? value : fallback;
}

function runnerFor(ort: OrtLike, session: OrtSessionLike): TensorRun {
  return async (input) => {
    const tensor = new ort.Tensor('float32', input.data, input.dims);
    const output = await session.run({ [session.inputNames[0]]: tensor });
    return output[session.outputNames[0]];
  };
}

async function readRecClassCount(session: OrtSessionLike, run: TensorRun): Promise<number> {
  const declared = session.outputMetadata?.[0]?.shape;
  const last = declared?.[declared.length - 1];
  if (typeof last === 'number' && last > 0) return last;
  // The metadata dimension is symbolic or the build does not expose it. One zero-filled
  // forward pass at the reference input shape is the only other way to read the width,
  // and it costs a few milliseconds once per process.
  const probe = await run({
    data: new Float32Array(3 * REC_INPUT_HEIGHT * REC_BASE_WIDTH),
    dims: [1, 3, REC_INPUT_HEIGHT, REC_BASE_WIDTH],
  });
  return probe.dims[probe.dims.length - 1];
}

async function build(): Promise<OnnxOcrSessions> {
  requireVerifiedOnnxOcrAssets();
  const assets = resolveOnnxOcrAssets();
  const ort = await loader();
  // Every create below is wrapped so a shape guard that throws after only some of the three
  // sessions exist still releases them. Without this, a bad cls or rec asset leaks whichever
  // native sessions were already created, every time getOnnxOcrSessions() is retried.
  const created: OrtSessionLike[] = [];
  try {
    const det = await ort.InferenceSession.create(assets.detPath, { ...SESSION_OPTIONS });
    created.push(det);
    const cls = await ort.InferenceSession.create(assets.clsPath, { ...SESSION_OPTIONS });
    created.push(cls);
    const rec = await ort.InferenceSession.create(assets.recPath, { ...SESSION_OPTIONS });
    created.push(rec);

    const clsOut = cls.outputMetadata?.[0]?.shape;
    const clsClasses = clsOut?.[clsOut.length - 1];
    if (clsClasses !== 2) {
      throw new Error(
        `The orientation model declares ${String(clsClasses)} output classes; it must declare exactly 2 classes.`,
      );
    }

    const runRec = runnerFor(ort, rec);
    const recClassCount = await readRecClassCount(rec, runRec);
    const dictionary = loadRecDictionary();
    assertRecClassCount(dictionary, recClassCount);

    const sessions: OnnxOcrSessions = {
      runDet: runnerFor(ort, det),
      runCls: runnerFor(ort, cls),
      runRec,
      clsInputHeight: lastStaticDim(cls.inputMetadata?.[0]?.shape, 2, CLS_INPUT_HEIGHT),
      clsInputWidth: lastStaticDim(cls.inputMetadata?.[0]?.shape, 3, CLS_INPUT_WIDTH),
      recClassCount,
      dictionary: dictionary.entries,
    };
    live = { sessions, raw: [det, cls, rec] };
    return sessions;
  } catch (error) {
    for (const session of created) {
      try {
        await session.release();
      } catch (releaseError) {
        console.warn('[ocr] session release failed', releaseError);
      }
    }
    throw error;
  }
}

/** Lazily created, and created together. At most three sessions exist at a time. */
export async function getOnnxOcrSessions(): Promise<OnnxOcrSessions> {
  if (injected !== null) return injected;
  if (live !== null) return live.sessions;
  if (creating === null) {
    creating = build().finally(() => {
      creating = null;
    });
  }
  return creating;
}

export async function releaseOnnxOcrSessions(): Promise<void> {
  const current = live;
  live = null;
  if (current === null) return;
  for (const session of current.raw) {
    try {
      await session.release();
    } catch (error) {
      console.warn('[ocr] session release failed', error);
    }
  }
}

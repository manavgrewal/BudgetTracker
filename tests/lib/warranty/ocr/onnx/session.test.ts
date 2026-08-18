import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  ORT_CPU_MEM_ARENA,
  ORT_GRAPH_OPT,
  ORT_INTER_OP_THREADS,
  ORT_INTRA_OP_THREADS,
  ORT_LOG_SEVERITY,
} from '@/lib/warranty/ocr/onnx/constants';
import {
  getOnnxOcrSessions,
  releaseOnnxOcrSessions,
  setOnnxSessionsForTests,
  setOrtLoaderForTests,
  type OnnxTensorData,
} from '@/lib/warranty/ocr/onnx/session';

interface FakeSession {
  inputNames: string[];
  outputNames: string[];
  inputMetadata: { name: string; shape: (number | string)[] }[];
  outputMetadata: { name: string; shape: (number | string)[] }[];
  run: (feeds: Record<string, unknown>) => Promise<Record<string, OnnxTensorData>>;
  release: () => Promise<void>;
}

function fakeSession(over: Partial<FakeSession> = {}): FakeSession {
  return {
    inputNames: ['x'],
    outputNames: ['y'],
    inputMetadata: [{ name: 'x', shape: [1, 3, 80, 160] }],
    outputMetadata: [{ name: 'y', shape: [1, 2] }],
    run: async () => ({ y: { data: new Float32Array([1, 0]), dims: [1, 2] } }),
    release: async () => {},
    ...over,
  };
}

afterEach(async () => {
  setOnnxSessionsForTests(null);
  setOrtLoaderForTests(null);
  await releaseOnnxOcrSessions();
  vi.restoreAllMocks();
});

function loader(created: { path: string; options: Record<string, unknown> }[], classCount: number) {
  return async () => ({
    InferenceSession: {
      create: async (modelPath: string, options: Record<string, unknown>) => {
        created.push({ path: modelPath, options });
        if (modelPath.includes('rec')) {
          return fakeSession({
            outputMetadata: [{ name: 'y', shape: [1, 'T', classCount] }],
            run: async () => ({ y: { data: new Float32Array(classCount), dims: [1, 1, classCount] } }),
          });
        }
        return fakeSession();
      },
    },
    Tensor: class {
      constructor(
        readonly type: string,
        readonly data: Float32Array,
        readonly dims: readonly number[],
      ) {}
    },
  });
}

describe('MUST-4.36: session options are pinned', () => {
  it('passes the six options verbatim to every create call', async () => {
    const created: { path: string; options: Record<string, unknown> }[] = [];
    const { classCount } = await import('@/lib/warranty/ocr/onnx/dict').then((m) => m.loadRecDictionary());
    setOrtLoaderForTests(loader(created, classCount));
    await getOnnxOcrSessions();
    expect(created).toHaveLength(3);
    for (const call of created) {
      expect(call.options).toEqual({
        executionProviders: ['cpu'],
        intraOpNumThreads: ORT_INTRA_OP_THREADS,
        interOpNumThreads: ORT_INTER_OP_THREADS,
        graphOptimizationLevel: ORT_GRAPH_OPT,
        logSeverityLevel: ORT_LOG_SEVERITY,
        enableCpuMemArena: ORT_CPU_MEM_ARENA,
      });
    }
  });
});

describe('lifecycle', () => {
  it('creates the three sessions once and reuses them', async () => {
    const created: { path: string; options: Record<string, unknown> }[] = [];
    const { classCount } = await import('@/lib/warranty/ocr/onnx/dict').then((m) => m.loadRecDictionary());
    setOrtLoaderForTests(loader(created, classCount));
    await getOnnxOcrSessions();
    await getOnnxOcrSessions();
    expect(created).toHaveLength(3);
  });

  it('releases all three, and a later call builds fresh ones', async () => {
    const created: { path: string; options: Record<string, unknown> }[] = [];
    const { classCount } = await import('@/lib/warranty/ocr/onnx/dict').then((m) => m.loadRecDictionary());
    setOrtLoaderForTests(loader(created, classCount));
    await getOnnxOcrSessions();
    await releaseOnnxOcrSessions();
    await getOnnxOcrSessions();
    expect(created).toHaveLength(6);
  });

  it('a release that throws on one session still releases the other two', async () => {
    let released = 0;
    const { classCount } = await import('@/lib/warranty/ocr/onnx/dict').then((m) => m.loadRecDictionary());
    setOrtLoaderForTests(async () => ({
      InferenceSession: {
        create: async (modelPath: string) =>
          fakeSession({
            outputMetadata: modelPath.includes('rec')
              ? [{ name: 'y', shape: [1, 'T', classCount] }]
              : [{ name: 'y', shape: [1, 2] }],
            release: async () => {
              released += 1;
              if (modelPath.includes('det')) throw new Error('release exploded');
            },
          }),
      },
      Tensor: class {
        constructor(
          readonly type: string,
          readonly data: Float32Array,
          readonly dims: readonly number[],
        ) {}
      },
    }));
    await getOnnxOcrSessions();
    await expect(releaseOnnxOcrSessions()).resolves.toBeUndefined();
    expect(released).toBe(3);
  });
});

describe('shape guards', () => {
  it('reads the classifier input shape from the graph when it is static (MUST-4.22)', async () => {
    const { classCount } = await import('@/lib/warranty/ocr/onnx/dict').then((m) => m.loadRecDictionary());
    setOrtLoaderForTests(loader([], classCount));
    const sessions = await getOnnxOcrSessions();
    expect(sessions.clsInputHeight).toBe(80);
    expect(sessions.clsInputWidth).toBe(160);
  });

  it('falls back to the pinned shape when the dimension is symbolic (MUST-4.22)', async () => {
    const { classCount } = await import('@/lib/warranty/ocr/onnx/dict').then((m) => m.loadRecDictionary());
    setOrtLoaderForTests(async () => ({
      InferenceSession: {
        create: async (modelPath: string) =>
          fakeSession({
            inputMetadata: [{ name: 'x', shape: ['N', 3, 'H', 'W'] }],
            outputMetadata: modelPath.includes('rec')
              ? [{ name: 'y', shape: [1, 'T', classCount] }]
              : [{ name: 'y', shape: [1, 2] }],
          }),
      },
      Tensor: class {
        constructor(
          readonly type: string,
          readonly data: Float32Array,
          readonly dims: readonly number[],
        ) {}
      },
    }));
    const { CLS_INPUT_HEIGHT, CLS_INPUT_WIDTH } = await import('@/lib/warranty/ocr/onnx/constants');
    const sessions = await getOnnxOcrSessions();
    expect(sessions.clsInputHeight).toBe(CLS_INPUT_HEIGHT);
    expect(sessions.clsInputWidth).toBe(CLS_INPUT_WIDTH);
  });

  it('throws when the classifier does not have exactly two classes (MUST-4.24)', async () => {
    const { classCount } = await import('@/lib/warranty/ocr/onnx/dict').then((m) => m.loadRecDictionary());
    setOrtLoaderForTests(async () => ({
      InferenceSession: {
        create: async (modelPath: string) =>
          fakeSession({
            outputMetadata: modelPath.includes('rec')
              ? [{ name: 'y', shape: [1, 'T', classCount] }]
              : [{ name: 'y', shape: [1, 4] }],
          }),
      },
      Tensor: class {
        constructor(
          readonly type: string,
          readonly data: Float32Array,
          readonly dims: readonly number[],
        ) {}
      },
    }));
    await expect(getOnnxOcrSessions()).rejects.toThrow(/2 classes/);
  });

  it('throws when the recognition width disagrees with the dictionary (MUST-3.16)', async () => {
    setOrtLoaderForTests(loader([], 7));
    await expect(getOnnxOcrSessions()).rejects.toThrow(/en_dict\.txt/);
  });
});

describe('setOnnxSessionsForTests (MUST-5.13)', () => {
  it('short-circuits creation entirely', async () => {
    const created: { path: string; options: Record<string, unknown> }[] = [];
    setOrtLoaderForTests(loader(created, 3));
    setOnnxSessionsForTests({
      runDet: async () => ({ data: new Float32Array(1), dims: [1, 1, 1, 1] }),
      runCls: async () => ({ data: new Float32Array(2), dims: [1, 2] }),
      runRec: async () => ({ data: new Float32Array(3), dims: [1, 1, 3] }),
      clsInputHeight: 80,
      clsInputWidth: 160,
      recClassCount: 3,
      dictionary: ['', 'a', ' '],
    });
    const sessions = await getOnnxOcrSessions();
    expect(sessions.recClassCount).toBe(3);
    expect(created).toHaveLength(0);
  });
});

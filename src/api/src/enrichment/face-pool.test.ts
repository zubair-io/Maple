/**
 * Tests for the off-thread face-inference pool (#707).
 *
 * Three layers, mirroring `people/cluster-pool.test.ts`'s honesty about what
 * actually runs:
 *
 *   1. Always-on — protocol round-trip + error-class revival. Proves
 *      `DetectedFace`, the 512-d `Float32Array`, and the `ThumbDecodeError`
 *      discriminator survive `postMessage` and come back as the right CLASS
 *      (so the stages' `instanceof` skip-vs-retry branch keeps working).
 *
 *   2. Always-on — in-process fallback parity. Forces the fallback path and
 *      injects a fake model loader (the model-injection seam is main-thread
 *      only, which is exactly why this can't test the *worker* path), then
 *      asserts the pooled detector returns the same output as a direct
 *      `OnnxFaceDetector` on the same fake sessions.
 *
 *   3. Model-gated (skip-pass) — real worker round-trip. Loads the real ONNX
 *      models inside the worker and proves pooled output equals in-process
 *      output on a synthetic image, plus that the work genuinely left the main
 *      thread (resolves on a macrotask, not within the microtask queue). Skips
 *      when the models aren't on disk — mirrors the repo's fixture-gated
 *      `XCTSkip`-style soft-pass.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';

import {
  OnnxFaceDetector,
  ThumbDecodeError,
  defaultFaceDetector,
  setDefaultFaceDetectorForTests,
  type DetectedFace,
  type FaceDetector,
} from './face-detector.ts';
import {
  PooledFaceDetector,
  preloadFaceModelsOffThread,
  setForceInProcessForTests,
} from './face-pool.ts';
import {
  getFaceModelsStatus,
  setFaceModelLoaderForTests,
  defaultModelDir,
  DETECTOR_BASENAME,
  RECOGNIZER_BASENAME,
  type FaceModels,
  type OnnxSessionLike,
  type OnnxTensorConstructor,
  type OnnxTensorLike,
} from './face-models.ts';
import type { DetectResponse, EmbedResponse, FaceWorkerResponse } from './face-pool-protocol.ts';

// ── Shared fakes ──────────────────────────────────────────────────────────

/** Minimal stand-in for `onnxruntime-node`'s `Tensor`. */
class FakeTensor implements OnnxTensorLike {
  readonly location = 'cpu' as const;
  constructor(
    readonly type: 'float32',
    readonly data: Float32Array,
    readonly dims: readonly number[],
  ) {}
}
const FakeTensorCtor = FakeTensor as unknown as OnnxTensorConstructor;

/** SCRFD outputs with a single high-confidence anchor at stride-8 idx 6480 —
 * the same target the `face-detector.test.ts` decode test uses. Yields exactly
 * one detection at normalised bbox (0.3, 0.3, 0.4, 0.4). */
function singleFaceScrfdOutputs(): Record<string, OnnxTensorLike> {
  const score = new Float32Array(12800);
  const bbox = new Float32Array(12800 * 4);
  const kps = new Float32Array(12800 * 10);
  const TARGET = 6480;
  score[TARGET] = 0.95;
  bbox[TARGET * 4 + 0] = 16;
  bbox[TARGET * 4 + 1] = 16;
  bbox[TARGET * 4 + 2] = 16;
  bbox[TARGET * 4 + 3] = 16;
  // Five distinct landmark offsets so the alignment transform is non-degenerate.
  const offs: Array<[number, number]> = [
    [-4, -4],
    [4, -4],
    [0, 0],
    [-3, 4],
    [3, 4],
  ];
  for (let p = 0; p < 5; p++) {
    kps[TARGET * 10 + p * 2] = offs[p]![0];
    kps[TARGET * 10 + p * 2 + 1] = offs[p]![1];
  }
  const make = (rows: number, cols: number, data?: Float32Array) =>
    new FakeTensor('float32', data ?? new Float32Array(rows * cols), [rows, cols]);
  return {
    score_8: make(12800, 1, score),
    score_16: make(3200, 1),
    score_32: make(800, 1),
    bbox_8: make(12800, 4, bbox),
    bbox_16: make(3200, 4),
    bbox_32: make(800, 4),
    kps_8: make(12800, 10, kps),
    kps_16: make(3200, 10),
    kps_32: make(800, 10),
  };
}

/** Fake recognizer: returns a fixed (un-normalised) 8-d "embedding" derived
 * from the input tensor's mean so the L2-normalise step in `extractEmbedding`
 * has something deterministic to chew on. */
function fakeRecognizerOutput(
  feeds: Record<string, OnnxTensorLike>,
): Record<string, OnnxTensorLike> {
  const input = Object.values(feeds)[0]!;
  const data = input.data as Float32Array;
  let mean = 0;
  for (let i = 0; i < data.length; i++) mean += data[i]!;
  mean /= data.length || 1;
  const emb = new Float32Array([mean, mean + 1, mean + 2, 3, 4, 5, 6, 7]);
  return { out: new FakeTensor('float32', emb, [1, 8]) };
}

function fakeModels(): FaceModels {
  const detector: OnnxSessionLike = { run: async () => singleFaceScrfdOutputs() };
  const recognizer: OnnxSessionLike = { run: async (feeds) => fakeRecognizerOutput(feeds) };
  return {
    detector,
    recognizer,
    Tensor: FakeTensorCtor,
    paths: { detector: 'stub', recognizer: 'stub' },
  };
}

async function tinyJpeg(size = 32): Promise<Uint8Array> {
  const buf = await sharp({
    create: { width: size, height: size, channels: 3, background: { r: 180, g: 120, b: 90 } },
  })
    .jpeg()
    .toBuffer();
  return new Uint8Array(buf);
}

afterEach(() => {
  setForceInProcessForTests(false);
  setFaceModelLoaderForTests(null);
  setDefaultFaceDetectorForTests(null);
});

// ── Layer 1: protocol round-trip ────────────────────────────────────────────

describe('face-pool protocol — serialization survives postMessage', () => {
  it('round-trips a detect response (DetectedFace[]) through structuredClone', () => {
    const detections: DetectedFace[] = [
      {
        bbox: { x: 0.3, y: 0.3, w: 0.4, h: 0.4 },
        confidence: 0.95,
        landmarks: [
          { x: 0.4, y: 0.4 },
          { x: 0.6, y: 0.4 },
          { x: 0.5, y: 0.5 },
          { x: 0.42, y: 0.6 },
          { x: 0.58, y: 0.6 },
        ],
      },
    ];
    const msg: FaceWorkerResponse = { type: 'detect', id: 7, ok: true, detections };
    const cloned = structuredClone(msg) as DetectResponse;
    expect(cloned.type).toBe('detect');
    expect(cloned.id).toBe(7);
    expect(cloned.detections).toEqual(detections);
  });

  it('round-trips an embed response (Float32Array) through structuredClone', () => {
    const embedding = new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5]);
    const msg: FaceWorkerResponse = { type: 'embed', id: 9, ok: true, embedding };
    const cloned = structuredClone(msg) as EmbedResponse;
    expect(cloned.embedding).toBeInstanceOf(Float32Array);
    expect(Array.from(cloned.embedding!)).toEqual(Array.from(embedding));
  });

  it('carries the thumb-decode discriminator on a failed response', () => {
    const msg: FaceWorkerResponse = {
      type: 'detect',
      id: 3,
      ok: false,
      errorKind: 'thumb-decode',
      error: 'VipsJpeg: Invalid SOS parameters',
    };
    const cloned = structuredClone(msg) as DetectResponse;
    expect(cloned.errorKind).toBe('thumb-decode');
    expect(cloned.error).toContain('VipsJpeg');
  });
});

// ── Layer 2: in-process fallback parity ─────────────────────────────────────

describe('PooledFaceDetector — in-process fallback parity', () => {
  it('detect output matches a direct OnnxFaceDetector on the same fake models', async () => {
    setForceInProcessForTests(true);
    setFaceModelLoaderForTests(async () => fakeModels());

    const direct = new OnnxFaceDetector();
    const pooled = new PooledFaceDetector();
    const jpeg = await tinyJpeg();

    const directDet = await direct.detectFaces(jpeg);
    const pooledDet = await pooled.detectFaces(jpeg);
    expect(pooledDet).toEqual(directDet);
    expect(pooledDet).toHaveLength(1);
    expect(pooledDet[0]!.bbox.x).toBeCloseTo(0.3, 5);
  });

  it('embed output matches a direct OnnxFaceDetector on the same fake models', async () => {
    setForceInProcessForTests(true);
    setFaceModelLoaderForTests(async () => fakeModels());

    const direct = new OnnxFaceDetector();
    const pooled = new PooledFaceDetector();
    const jpeg = await tinyJpeg();
    const det = (await direct.detectFaces(jpeg))[0]!;

    const directEmb = await direct.embedFace(jpeg, det);
    const pooledEmb = await pooled.embedFace(jpeg, det);
    expect(Array.from(pooledEmb)).toEqual(Array.from(directEmb));
    // L2-normalised: unit length.
    let norm = 0;
    for (const v of pooledEmb) norm += v * v;
    expect(Math.sqrt(norm)).toBeCloseTo(1, 5);
  });

  it('preserves ThumbDecodeError class through the fallback (so stages skip, not retry)', async () => {
    setForceInProcessForTests(true);
    setFaceModelLoaderForTests(async () => fakeModels());
    const pooled = new PooledFaceDetector();
    const garbage = new Uint8Array([0x00, 0xff, 0x42, 0x42]);

    let err: unknown = null;
    try {
      await pooled.detectFaces(garbage);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ThumbDecodeError);
  });
});

// ── defaultFaceDetector wiring (exercises the require() cycle) ───────────────

describe('defaultFaceDetector', () => {
  it('returns a PooledFaceDetector when no test override is set', () => {
    // Production entry point: every stage test short-circuits this via
    // setDefaultFaceDetectorForTests, so without this assertion the
    // `require('./face-pool.ts')` cycle wiring would be dead code in tests.
    // (The constructor does NOT spawn a worker, so this is free.)
    setDefaultFaceDetectorForTests(null);
    expect(defaultFaceDetector()).toBeInstanceOf(PooledFaceDetector);
  });

  it('honours a test override (stages stub on the main thread, no worker)', () => {
    const stub: FaceDetector = {
      detectFaces: async () => [],
      embedFace: async () => new Float32Array(),
    };
    setDefaultFaceDetectorForTests(stub);
    expect(defaultFaceDetector()).toBe(stub);
  });
});

// ── Worker plumbing via the preload-failure path (no models needed) ──────────

describe('preloadFaceModelsOffThread — real worker spawn + status relay', () => {
  it('spawns the child, fails the load fast, and relays error status', async () => {
    // This is the ONLY always-on test that actually executes the face child
    // PROCESS: it proves the child spawns, imports onnxruntime-node +
    // face-detector without crashing, runs loadFaceModels there, and relays the
    // load-status transition back to the main-process badge
    // (`getFaceModelsStatus`). No models and no network required.
    //
    // The fast-fail is driven entirely through the `config` object (which
    // crosses IPC) — NOT via env. Pointing both model URLs at a closed local
    // port makes `ensureModelFile` skip the antelopev2 auto-download (URLs are
    // set) and fail fast on a refused connection — deterministic and offline.
    const tmp = mkdtempSync(join(tmpdir(), 'maple-face-pool-'));
    const deadUrl = 'http://127.0.0.1:1/nope.onnx';
    try {
      setForceInProcessForTests(false);
      const ok = await preloadFaceModelsOffThread({
        modelDir: tmp,
        detectorUrl: deadUrl,
        recognizerUrl: deadUrl,
      });
      expect(ok).toBe(false);
      // The worker relayed its load-status transition back to the main thread.
      expect(getFaceModelsStatus().kind).toBe('error');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 30_000);
});

// ── Layer 3: real worker round-trip (model-gated, skip-pass) ─────────────────

const modelsPresent =
  existsSync(join(defaultModelDir(), DETECTOR_BASENAME)) &&
  existsSync(join(defaultModelDir(), RECOGNIZER_BASENAME));

describe('PooledFaceDetector — real worker round-trip', () => {
  it.skipIf(!modelsPresent)(
    'creates both ONNX sessions in the worker (preload resolves true, status loaded)',
    async () => {
      // The ticket's explicit stop-condition: does InferenceSession.create()
      // actually work inside the Bun worker thread? A `true` preload result +
      // `'loaded'` status proves BOTH sessions (detector + recognizer)
      // constructed on the worker thread without crashing. Only runs when the
      // antelopev2 models are on disk (the seam is worker-side, can't be faked).
      setForceInProcessForTests(false);
      const ok = await preloadFaceModelsOffThread({ modelDir: defaultModelDir() });
      expect(ok).toBe(true);
      expect(getFaceModelsStatus().kind).toBe('loaded');
    },
    120_000,
  );

  it.skipIf(!modelsPresent)(
    'runs session.run() in the worker (synthetic image yields the same result as in-process)',
    async () => {
      // Worker path: the worker thread owns its own model singleton, so we
      // CANNOT inject a fake loader here (the seam is main-thread only). A flat
      // synthetic image yields zero SCRFD detections; the assertion proves
      // `session.run()` executes IN THE WORKER without crashing and returns the
      // identical (empty) result the in-process path returns. Live-ONNX parity
      // on a NON-empty face is not exercised here (no committed face fixture).
      setForceInProcessForTests(false);
      const pooled = new PooledFaceDetector();
      const direct = new OnnxFaceDetector();
      const jpeg = await tinyJpeg(640);

      const [pooledDet, directDet] = await Promise.all([
        pooled.detectFaces(jpeg),
        direct.detectFaces(jpeg),
      ]);
      expect(pooledDet).toEqual(directDet);
    },
    60_000,
  );

  it.skipIf(!modelsPresent)(
    'runs genuinely off-thread (does not settle within the microtask queue)',
    async () => {
      // A real worker reply arrives on a `message` event — a macrotask — so it
      // can't settle while we only drain microtasks. The in-process fallback,
      // by contrast, would settle within microtasks. This proves the work left
      // the main thread. (cf. cluster-pool.test.ts)
      setForceInProcessForTests(false);
      const pooled = new PooledFaceDetector();
      const jpeg = await tinyJpeg(640);

      let settled = false;
      const p = pooled.detectFaces(jpeg).then((r) => {
        settled = true;
        return r;
      });
      for (let i = 0; i < 5; i += 1) await Promise.resolve();
      expect(settled).toBe(false);
      await p;
      expect(settled).toBe(true);
    },
    60_000,
  );
});

/**
 * face-detector — covers the real OnnxFaceDetector path (the face.test.ts
 * worker tests stub the detector wholesale, so the ORT-feed construction
 * was unguarded until v1.26 broke it).
 *
 * Regression guard: every feed handed to `session.run()` must be a real
 * `Tensor` instance (with a string `.location`), not a plain `{ data, dims }`
 * object — the native `onnxruntime-node` binding rejects the latter with
 * "Tensor.location must be a string." and dead-letters the image.
 */

import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import * as mapleMod from 'maple';
import { solidJpeg } from '../test-support/synth-image.ts';

import { isNativeLoadFailure, OnnxFaceDetector, ThumbDecodeError } from './face-detector.ts';
import {
  setFaceModelLoaderForTests,
  type FaceModels,
  type OnnxSessionLike,
  type OnnxTensorConstructor,
  type OnnxTensorLike,
} from './face-models.ts';

/** Minimal stand-in for `onnxruntime-node`'s `Tensor`. Real Tensors set
 * `location` from the constructor; the detector code only depends on the
 * value being a non-undefined string, so we hard-code `'cpu'`. */
class FakeTensor implements OnnxTensorLike {
  readonly location = 'cpu' as const;
  constructor(
    readonly type: 'float32',
    readonly data: Float32Array,
    readonly dims: readonly number[],
  ) {}
}

const FakeTensorCtor = FakeTensor as unknown as OnnxTensorConstructor;

afterEach(() => {
  setFaceModelLoaderForTests(null);
});

/** Tiny solid-colour JPEG Maple can decode. The detector resizes to
 * 640×640 regardless of input size, so a 4×4 fixture is enough to
 * exercise the preprocess path. */
async function makeTinyJpeg(): Promise<Uint8Array> {
  return solidJpeg(4, 4, [200, 200, 200]);
}

/** SCRFD output shapes for input 640×640 (same layout for both the v1
 * buffalo_s/det_500m checkpoint and the current antelopev2/SCRFD-10G
 * head — they share the architecture, only the weights differ): three
 * strides (8, 16, 32) × three heads (score, bbox, kps). For numAnchors=2:
 * stride 8 → 80×80×2 = 12800, 16 → 3200, 32 → 800. */
function emptyScrfdOutputs(): Record<string, OnnxTensorLike> {
  const make = (rows: number, cols: number) =>
    new FakeTensor('float32', new Float32Array(rows * cols), [rows, cols]);
  return {
    score_8: make(12800, 1),
    score_16: make(3200, 1),
    score_32: make(800, 1),
    bbox_8: make(12800, 4),
    bbox_16: make(3200, 4),
    bbox_32: make(800, 4),
    kps_8: make(12800, 10),
    kps_16: make(3200, 10),
    kps_32: make(800, 10),
  };
}

describe('OnnxFaceDetector — feed construction', () => {
  it('passes a real Tensor instance (with string .location) to session.run', async () => {
    const seenFeeds: Record<string, OnnxTensorLike>[] = [];
    const fakeSession: OnnxSessionLike = {
      run: async (feeds) => {
        seenFeeds.push(feeds);
        // Return SCRFD-shaped outputs with all-zero scores so the
        // decoder runs cleanly and yields no detections — the assertion
        // target here is the input feed, not the decode output.
        return emptyScrfdOutputs();
      },
    };
    setFaceModelLoaderForTests(
      async (): Promise<FaceModels> => ({
        detector: fakeSession,
        recognizer: fakeSession,
        Tensor: FakeTensorCtor,
        paths: { detector: 'stub', recognizer: 'stub' },
      }),
    );

    const detector = new OnnxFaceDetector();
    const detections = await detector.detectFaces(await makeTinyJpeg());

    expect(seenFeeds).toHaveLength(1);
    const feed = Object.values(seenFeeds[0]!)[0]!;
    expect(feed).toBeInstanceOf(FakeTensor);
    // The native ORT binding validates these exact properties — assert
    // each one so a future refactor can't quietly drop them again.
    expect(typeof (feed as FakeTensor).location).toBe('string');
    expect((feed as FakeTensor).location).toBe('cpu');
    expect((feed as FakeTensor).type).toBe('float32');
    expect(feed.dims).toEqual([1, 3, 640, 640]);
    expect(feed.data).toBeInstanceOf(Float32Array);
    // Sanity: zero-score outputs decode to zero detections.
    expect(detections).toEqual([]);
  });
});

describe('OnnxFaceDetector — SCRFD decode', () => {
  it('decodes a single high-confidence anchor into a normalised face', async () => {
    // Target anchor: stride-8 head, grid cell (col=40, row=40), anchor 0.
    // Spatial index = 40*80 + 40 = 3240, anchor stride 2 → idx = 6480.
    // Centre = (40*8, 40*8) = (320, 320). With distances (16,16,16,16)
    // in stride units = (128,128,128,128) px → bbox corners
    // (192, 192, 448, 448) → normalised (0.3, 0.3, 0.4, 0.4) at 640.
    const score = new Float32Array(12800);
    const bbox = new Float32Array(12800 * 4);
    const kps = new Float32Array(12800 * 10);
    const TARGET = 6480;
    score[TARGET] = 0.95;
    bbox[TARGET * 4 + 0] = 16; // dl
    bbox[TARGET * 4 + 1] = 16; // dt
    bbox[TARGET * 4 + 2] = 16; // dr
    bbox[TARGET * 4 + 3] = 16; // db
    // Landmark 0 at +(8, 0) stride units → +(64, 0) px from centre
    // → (384, 320) px → normalised (0.6, 0.5).
    kps[TARGET * 10 + 0] = 8;
    kps[TARGET * 10 + 1] = 0;

    const fakeSession: OnnxSessionLike = {
      run: async () => {
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
      },
    };
    setFaceModelLoaderForTests(
      async (): Promise<FaceModels> => ({
        detector: fakeSession,
        recognizer: fakeSession,
        Tensor: FakeTensorCtor,
        paths: { detector: 'stub', recognizer: 'stub' },
      }),
    );

    const detector = new OnnxFaceDetector();
    const detections = await detector.detectFaces(await makeTinyJpeg());

    expect(detections).toHaveLength(1);
    const d = detections[0]!;
    expect(d.confidence).toBeCloseTo(0.95);
    expect(d.bbox.x).toBeCloseTo(0.3, 5);
    expect(d.bbox.y).toBeCloseTo(0.3, 5);
    expect(d.bbox.w).toBeCloseTo(0.4, 5);
    expect(d.bbox.h).toBeCloseTo(0.4, 5);
    expect(d.landmarks).toHaveLength(5);
    expect(d.landmarks[0]!.x).toBeCloseTo(0.6, 5);
    expect(d.landmarks[0]!.y).toBeCloseTo(0.5, 5);
  });

  it('suppresses near-duplicate detections via NMS', async () => {
    // Two adjacent anchors in stride-8 head, both high-confidence with
    // identical distance values. Anchor A at idx 6480 (cell col=40,
    // row=40) → centre (320, 320). Anchor B at idx 6482 (cell col=41,
    // row=40) → centre (328, 320). Same distances (128 px each side)
    // → boxes overlap by ~256/(256+8) per axis → IoU ≈ 0.94, well above
    // the 0.4 NMS threshold, so the lower-scoring one drops.
    const score = new Float32Array(12800);
    const bbox = new Float32Array(12800 * 4);
    score[6480] = 0.9;
    score[6482] = 0.95;
    for (const target of [6480, 6482]) {
      bbox[target * 4 + 0] = 16;
      bbox[target * 4 + 1] = 16;
      bbox[target * 4 + 2] = 16;
      bbox[target * 4 + 3] = 16;
    }
    const fakeSession: OnnxSessionLike = {
      run: async () => {
        const make = (rows: number, cols: number, data?: Float32Array) =>
          new FakeTensor('float32', data ?? new Float32Array(rows * cols), [rows, cols]);
        return {
          score_8: make(12800, 1, score),
          score_16: make(3200, 1),
          score_32: make(800, 1),
          bbox_8: make(12800, 4, bbox),
          bbox_16: make(3200, 4),
          bbox_32: make(800, 4),
        };
      },
    };
    setFaceModelLoaderForTests(
      async (): Promise<FaceModels> => ({
        detector: fakeSession,
        recognizer: fakeSession,
        Tensor: FakeTensorCtor,
        paths: { detector: 'stub', recognizer: 'stub' },
      }),
    );

    const detector = new OnnxFaceDetector();
    const detections = await detector.detectFaces(await makeTinyJpeg());

    expect(detections).toHaveLength(1);
    expect(detections[0]!.confidence).toBeCloseTo(0.95);
  });

  it('throws on mismatched SCRFD output bucket counts', async () => {
    // Only score tensors, no bbox tensors — operator gave us a broken
    // export. We want a hard error, not a silent empty-detections result.
    const fakeSession: OnnxSessionLike = {
      run: async () =>
        ({
          score_8: new FakeTensor('float32', new Float32Array(12800), [12800, 1]),
        }) as Record<string, OnnxTensorLike>,
    };
    setFaceModelLoaderForTests(
      async (): Promise<FaceModels> => ({
        detector: fakeSession,
        recognizer: fakeSession,
        Tensor: FakeTensorCtor,
        paths: { detector: 'stub', recognizer: 'stub' },
      }),
    );

    const detector = new OnnxFaceDetector();
    let err: unknown = null;
    try {
      await detector.detectFaces(await makeTinyJpeg());
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('SCRFD outputs malformed');
  });
});

describe('OnnxFaceDetector — JPEG decode failure', () => {
  it("throws ThumbDecodeError when maple can't read the bytes", async () => {
    setFaceModelLoaderForTests(
      async (): Promise<FaceModels> => ({
        detector: { run: async () => ({}) },
        recognizer: { run: async () => ({}) },
        Tensor: FakeTensorCtor,
        paths: { detector: 'stub', recognizer: 'stub' },
      }),
    );

    const detector = new OnnxFaceDetector();
    // Garbage bytes that aren't a valid image of any kind. Maple's
    // native decode throws asynchronously; the detector wraps that into
    // ThumbDecodeError.
    const garbage = new Uint8Array([0x00, 0xff, 0x00, 0xff, 0x42, 0x42]);

    let err: unknown = null;
    try {
      await detector.detectFaces(garbage);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ThumbDecodeError);
  });
});

describe('OnnxFaceDetector — degenerate bbox', () => {
  it('throws a plain Error (not ThumbDecodeError) for invalid crop geometry', async () => {
    setFaceModelLoaderForTests(
      async (): Promise<FaceModels> => ({
        detector: { run: async () => ({}) },
        recognizer: { run: async () => ({}) },
        Tensor: FakeTensorCtor,
        paths: { detector: 'stub', recognizer: 'stub' },
      }),
    );

    const detector = new OnnxFaceDetector();
    // Zero-width/zero-height detection — what a bad RetinaFace export
    // could conceivably emit. We want the handler to see a generic
    // Error (retryable, then dead-letters with a real message) rather
    // than a misleading `thumb-undecodable` skip-pass.
    const badDetection = {
      bbox: { x: 0.5, y: 0.5, w: 0, h: 0 },
      confidence: 0.9,
      landmarks: [],
    };

    let err: unknown = null;
    try {
      await detector.embedFace(await makeTinyJpeg(), badDetection);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ThumbDecodeError);
    expect((err as Error).message).toContain('invalid crop geometry');
  });
});

describe('isNativeLoadFailure', () => {
  it('recognises the "library not found" message shape', () => {
    const err = new Error(
      'Maple native library (libmaple_core.dylib) not found. Build it with cargo build --release -p raw-ffi or set MAPLE_NATIVE_LIB.',
    );
    expect(isNativeLoadFailure(err)).toBe(true);
  });

  it('recognises the "requires Bun" message shape', () => {
    const err = new Error('Maple native bindings currently require Bun (bun:ffi).');
    expect(isNativeLoadFailure(err)).toBe(true);
  });

  it('returns false for an unrelated Error message (a real decode failure)', () => {
    const err = new Error('unsupported image format');
    expect(isNativeLoadFailure(err)).toBe(false);
  });

  it('returns false for a non-Error thrown value', () => {
    expect(isNativeLoadFailure('some string')).toBe(false);
    expect(isNativeLoadFailure(null)).toBe(false);
    expect(isNativeLoadFailure(undefined)).toBe(false);
    expect(
      isNativeLoadFailure({ message: 'Maple native bindings currently require Bun (bun:ffi).' }),
    ).toBe(false);
  });
});

describe('OnnxFaceDetector — native dylib load failure propagation (#3623 follow-up guard)', () => {
  /**
   * A broken/missing native library must abort loudly (a retryable throw
   * the stage runner's retry/backoff path handles), never get folded into
   * `ThumbDecodeError` — which the stage handlers treat as a permanent
   * per-asset skip. We simulate this by making the real `maple(...)` call
   * throw one of `loadNativeBinding()`'s exact two message shapes, via
   * `spyOn` on the `maple` package's namespace export (restored in
   * `finally`) — the same pattern this file's sibling
   * `face-bootstrap.never-throws.test.ts` uses for a same-repo module,
   * confirmed here to also apply to the external `maple` package's
   * namespace binding.
   */
  it('detectFaces re-throws a native-load failure untouched, not wrapped in ThumbDecodeError', async () => {
    setFaceModelLoaderForTests(
      async (): Promise<FaceModels> => ({
        detector: { run: async () => ({}) },
        recognizer: { run: async () => ({}) },
        Tensor: FakeTensorCtor,
        paths: { detector: 'stub', recognizer: 'stub' },
      }),
    );
    const nativeErr = new Error('Maple native bindings currently require Bun (bun:ffi).');
    const mapleSpy = spyOn(mapleMod, 'maple').mockImplementation(() => {
      throw nativeErr;
    });

    try {
      const detector = new OnnxFaceDetector();
      let err: unknown = null;
      try {
        await detector.detectFaces(await makeTinyJpeg());
      } catch (e) {
        err = e;
      }
      expect(err).toBe(nativeErr);
      expect(err).not.toBeInstanceOf(ThumbDecodeError);
    } finally {
      mapleSpy.mockRestore();
    }
  });

  it('embedFace (via alignFaceCrop) re-throws a native-load failure untouched, not wrapped in ThumbDecodeError', async () => {
    setFaceModelLoaderForTests(
      async (): Promise<FaceModels> => ({
        detector: { run: async () => ({}) },
        recognizer: { run: async () => ({}) },
        Tensor: FakeTensorCtor,
        paths: { detector: 'stub', recognizer: 'stub' },
      }),
    );
    const nativeErr = new Error(
      'Maple native library (libmaple_core.dylib) not found. Build it with cargo build --release -p raw-ffi or set MAPLE_NATIVE_LIB.',
    );
    const mapleSpy = spyOn(mapleMod, 'maple').mockImplementation(() => {
      throw nativeErr;
    });

    try {
      const detector = new OnnxFaceDetector();
      const detection = {
        bbox: { x: 0.2, y: 0.2, w: 0.4, h: 0.4 },
        confidence: 0.9,
        landmarks: [],
      };
      let err: unknown = null;
      try {
        await detector.embedFace(await makeTinyJpeg(), detection);
      } catch (e) {
        err = e;
      }
      expect(err).toBe(nativeErr);
      expect(err).not.toBeInstanceOf(ThumbDecodeError);
    } finally {
      mapleSpy.mockRestore();
    }
  });
});

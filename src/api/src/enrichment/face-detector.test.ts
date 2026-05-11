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

import { afterEach, describe, expect, it } from "bun:test";
import sharp from "sharp";

import { OnnxFaceDetector, ThumbDecodeError } from "./face-detector.ts";
import {
  setFaceModelLoaderForTests,
  type FaceModels,
  type OnnxSessionLike,
  type OnnxTensorConstructor,
  type OnnxTensorLike,
} from "./face-models.ts";

/** Minimal stand-in for `onnxruntime-node`'s `Tensor`. Real Tensors set
 * `location` from the constructor; the detector code only depends on the
 * value being a non-undefined string, so we hard-code `'cpu'`. */
class FakeTensor implements OnnxTensorLike {
  readonly location = "cpu" as const;
  constructor(
    readonly type: "float32",
    readonly data: Float32Array,
    readonly dims: readonly number[],
  ) {}
}

const FakeTensorCtor = FakeTensor as unknown as OnnxTensorConstructor;

afterEach(() => {
  setFaceModelLoaderForTests(null);
});

/** Tiny solid-colour JPEG sharp can decode. The detector resizes to
 * 640×640 regardless of input size, so a 4×4 fixture is enough to
 * exercise the preprocess path. */
async function makeTinyJpeg(): Promise<Uint8Array> {
  const buf = await sharp({
    create: {
      width: 4,
      height: 4,
      channels: 3,
      background: { r: 200, g: 200, b: 200 },
    },
  })
    .jpeg()
    .toBuffer();
  return new Uint8Array(buf);
}

describe("OnnxFaceDetector — feed construction", () => {
  it("passes a real Tensor instance (with string .location) to session.run", async () => {
    const seenFeeds: Record<string, OnnxTensorLike>[] = [];
    const fakeSession: OnnxSessionLike = {
      run: async (feeds) => {
        seenFeeds.push(feeds);
        // Return a decoded-faces tensor [N, 5] with one detection above
        // the 0.6 confidence gate. Values are arbitrary — the test
        // only cares about the input feed, not the decode output.
        return {
          faces: new FakeTensor(
            "float32",
            new Float32Array([10, 20, 100, 200, 0.9]),
            [1, 5],
          ),
        };
      },
    };
    setFaceModelLoaderForTests(
      async (): Promise<FaceModels> => ({
        retinaFace: fakeSession,
        mobileFaceNet: fakeSession,
        Tensor: FakeTensorCtor,
        paths: { retinaFace: "stub", mobileFaceNet: "stub" },
      }),
    );

    const detector = new OnnxFaceDetector();
    await detector.detectFaces(await makeTinyJpeg());

    expect(seenFeeds).toHaveLength(1);
    const feed = Object.values(seenFeeds[0]!)[0]!;
    expect(feed).toBeInstanceOf(FakeTensor);
    // The native ORT binding validates these exact properties — assert
    // each one so a future refactor can't quietly drop them again.
    expect(typeof (feed as FakeTensor).location).toBe("string");
    expect((feed as FakeTensor).location).toBe("cpu");
    expect((feed as FakeTensor).type).toBe("float32");
    expect(feed.dims).toEqual([1, 3, 640, 640]);
    expect(feed.data).toBeInstanceOf(Float32Array);
  });
});

describe("OnnxFaceDetector — JPEG decode failure", () => {
  it("throws ThumbDecodeError when sharp/libvips can't read the bytes", async () => {
    setFaceModelLoaderForTests(
      async (): Promise<FaceModels> => ({
        retinaFace: { run: async () => ({}) },
        mobileFaceNet: { run: async () => ({}) },
        Tensor: FakeTensorCtor,
        paths: { retinaFace: "stub", mobileFaceNet: "stub" },
      }),
    );

    const detector = new OnnxFaceDetector();
    // Garbage bytes that aren't a valid image of any kind. Sharp throws
    // synchronously inside `.metadata()`/`.toBuffer()`; the detector
    // wraps that into ThumbDecodeError.
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

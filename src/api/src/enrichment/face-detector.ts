/**
 * ONNX wrapper around the face models loaded by `face-models.ts`.
 *
 * Two operations:
 *
 *   - `detectFaces(jpegBytes)` runs RetinaFace and returns one entry per
 *     detection: `{ bbox, confidence, landmarks }`, all in normalised
 *     [0,1] coordinates relative to the input image. Returning normalised
 *     values means the worker doesn't have to track decoded image size
 *     past the call site.
 *
 *   - `embedFace(jpegBytes, alignment)` runs MobileFaceNet on a 112×112
 *     aligned crop derived from the landmarks and returns the 512-D
 *     embedding as a `Float32Array`. The worker stores it as `number[]`
 *     so Mongo can serialise it without a BSON Binary detour.
 *
 * Image decode goes through `sharp` (already a dep — used by the indexer's
 * thumb pipeline). The face models eat normalised-RGB float tensors, so
 * `sharp` is the right place to handle resize + extract + raw pixel read.
 *
 * The detection / embedding *math* (NMS, anchor decoding, similarity
 * transforms) is intentionally light here — each model exposes its own
 * shape and we keep this file as a thin adapter. When we move to a
 * different detector head (e.g. SCRFD) the heavy lifting changes; the
 * worker contract does not.
 *
 * Spec: `docs/indexer-enrichment.md` §6.
 */

import sharp from "sharp";
import { child as childLogger } from "../log.ts";
import {
  loadFaceModels,
  type FaceModels,
  type OnnxSessionLike,
  type OnnxTensorConstructor,
  type OnnxTensorLike,
} from "./face-models.ts";

const log = childLogger("enrichment:face-detector");

/** Thrown when `sharp`/libvips cannot decode the thumbnail JPEG (e.g.
 * "VipsJpeg: Invalid SOS parameters"). Surfaces a non-retryable signal
 * to the worker handler, which converts it into a `{ skip }` so we
 * don't burn 5 retries on a permanently-corrupt thumbnail. */
export class ThumbDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ThumbDecodeError";
  }
}

/** Single detection from RetinaFace. All coords normalised to [0,1]. */
export interface DetectedFace {
  bbox: { x: number; y: number; w: number; h: number };
  confidence: number;
  /** Five landmarks (left eye, right eye, nose, left mouth, right mouth)
   * in normalised coordinates. RetinaFace's standard output. */
  landmarks: Array<{ x: number; y: number }>;
}

/** Sane default for the detection score gate. RetinaFace tends to emit
 * lots of low-confidence proposals; anything below ~0.6 is noise. */
export const DEFAULT_DETECTION_THRESHOLD = 0.6;

/** RetinaFace's standard input is 640×640, NCHW float32, normalised by
 * subtracting (104, 117, 123) per the original Caffe model. We follow
 * that — most pretrained checkpoints expect those magic numbers. */
const RETINAFACE_INPUT_SIZE = 640;

/** MobileFaceNet's input is 112×112 NCHW float32, normalised to [-1, 1]
 * (i.e. (px - 127.5) / 128.0 per channel). Standard for face-recognition
 * checkpoints. */
const MFN_INPUT_SIZE = 112;

/** Test/inject hook so worker tests can stub the detector without
 * touching ONNX. The `detectFaces` + `embedFace` pair is the entire
 * surface the worker depends on. */
export interface FaceDetector {
  detectFaces(jpegBytes: Uint8Array): Promise<DetectedFace[]>;
  embedFace(
    jpegBytes: Uint8Array,
    detection: DetectedFace,
  ): Promise<Float32Array>;
}

/** Default implementation — uses the singleton ONNX models. */
export class OnnxFaceDetector implements FaceDetector {
  private modelsPromise: Promise<FaceModels> | null = null;

  /** Load models on first call; cache the promise so concurrent callers
   * share one load. */
  private models(): Promise<FaceModels> {
    if (!this.modelsPromise) this.modelsPromise = loadFaceModels();
    return this.modelsPromise;
  }

  async detectFaces(jpegBytes: Uint8Array): Promise<DetectedFace[]> {
    const { retinaFace, Tensor } = await this.models();
    const { tensor, srcWidth, srcHeight } = await jpegToInputTensor(
      jpegBytes,
      RETINAFACE_INPUT_SIZE,
      "retinaface",
      Tensor,
    );
    const inputName = inferInputName(retinaFace, "input");
    const outputs = await retinaFace.run({ [inputName]: tensor });
    return decodeRetinaFaceOutputs(outputs, srcWidth, srcHeight);
  }

  async embedFace(
    jpegBytes: Uint8Array,
    detection: DetectedFace,
  ): Promise<Float32Array> {
    const { mobileFaceNet, Tensor } = await this.models();
    const aligned = await alignFaceCrop(jpegBytes, detection, Tensor);
    const inputName = inferInputName(mobileFaceNet, "input");
    const outputs = await mobileFaceNet.run({ [inputName]: aligned });
    return extractEmbedding(outputs);
  }
}

/** Singleton. Worker grabs this via `defaultFaceDetector()` so tests can
 * inject a stub without poking module internals. */
let defaultDetector: FaceDetector | null = null;

export function defaultFaceDetector(): FaceDetector {
  if (!defaultDetector) defaultDetector = new OnnxFaceDetector();
  return defaultDetector;
}

/** Test-only: replace the detector. Pass `null` to clear. */
export function setDefaultFaceDetectorForTests(d: FaceDetector | null): void {
  defaultDetector = d;
}

// ---------------------------------------------------------------------------
// Helpers — image preprocess + ONNX postprocess.
// ---------------------------------------------------------------------------

/** Decode JPEG → resize to `size`×`size` → produce NCHW float32 tensor.
 * For RetinaFace we mean-subtract; for MobileFaceNet we centre to [-1,1]
 * — controlled by `mode`.
 *
 * Throws `ThumbDecodeError` if `sharp`/libvips can't read the input —
 * the worker handler converts that into `{ skip }` so corrupt thumbnails
 * dead-letter immediately instead of after 5 retries. */
async function jpegToInputTensor(
  jpegBytes: Uint8Array,
  size: number,
  mode: "retinaface" | "mobilefacenet",
  Tensor: OnnxTensorConstructor,
): Promise<{
  tensor: OnnxTensorLike;
  srcWidth: number;
  srcHeight: number;
}> {
  let srcWidth: number;
  let srcHeight: number;
  let raw: Buffer;
  try {
    const img = sharp(jpegBytes);
    const meta = await img.metadata();
    srcWidth = meta.width ?? size;
    srcHeight = meta.height ?? size;
    raw = await img
      .resize(size, size, { fit: "fill" })
      .removeAlpha()
      .raw()
      .toBuffer();
  } catch (err) {
    throw new ThumbDecodeError(err instanceof Error ? err.message : String(err));
  }
  // Sharp returns interleaved RGB (HWC, uint8). We reshape into NCHW float32.
  const data = new Float32Array(3 * size * size);
  const plane = size * size;
  for (let i = 0; i < plane; i++) {
    const r = raw[i * 3]!;
    const g = raw[i * 3 + 1]!;
    const b = raw[i * 3 + 2]!;
    if (mode === "retinaface") {
      // Caffe-style mean subtraction (BGR order in the original model).
      data[i] = b - 104;
      data[plane + i] = g - 117;
      data[2 * plane + i] = r - 123;
    } else {
      // MobileFaceNet: RGB, centred to [-1, 1].
      data[i] = (r - 127.5) / 128.0;
      data[plane + i] = (g - 127.5) / 128.0;
      data[2 * plane + i] = (b - 127.5) / 128.0;
    }
  }
  return {
    tensor: new Tensor("float32", data, [1, 3, size, size]),
    srcWidth,
    srcHeight,
  };
}

/** Crop the face out of the JPEG using the bounding box, resize to
 * 112×112, and return the MobileFaceNet input tensor.
 *
 * Proper alignment uses the five landmarks via a similarity transform.
 * That's a meaningful future improvement (the embedding quality jumps
 * noticeably with aligned crops) but a square bbox crop is the standard
 * fallback and gives recognisable embeddings for v1. The landmarks are
 * still stored on each detection, so we can re-embed later without
 * re-detecting once the alignment path lands.
 */
async function alignFaceCrop(
  jpegBytes: Uint8Array,
  detection: DetectedFace,
  Tensor: OnnxTensorConstructor,
): Promise<OnnxTensorLike> {
  let W: number;
  let H: number;
  let cropRaw: Buffer;
  try {
    const meta = await sharp(jpegBytes).metadata();
    W = meta.width ?? 0;
    H = meta.height ?? 0;
  } catch (err) {
    throw new ThumbDecodeError(err instanceof Error ? err.message : String(err));
  }
  // Dimension sanity check sits OUTSIDE the decode try-catch on purpose:
  // sharp accepting bytes but returning zero dims would indicate a bug
  // in our preprocessing pipeline, not a corrupt JPEG, so we surface it
  // as a hard error rather than swallowing it as `thumb-undecodable`.
  if (W === 0 || H === 0) {
    throw new Error("face-detector: unable to read image dimensions");
  }
  // Inflate the box a touch so MobileFaceNet sees a bit of context — it
  // was trained on slightly-padded crops, not tight bounding boxes.
  const pad = 0.1;
  const cx = (detection.bbox.x + detection.bbox.w / 2) * W;
  const cy = (detection.bbox.y + detection.bbox.h / 2) * H;
  const side =
    Math.max(detection.bbox.w * W, detection.bbox.h * H) * (1 + pad);
  const left = Math.max(0, Math.round(cx - side / 2));
  const top = Math.max(0, Math.round(cy - side / 2));
  const width = Math.min(W - left, Math.round(side));
  const height = Math.min(H - top, Math.round(side));
  // Validate geometry OUTSIDE the decode try-catch: a degenerate bbox
  // (zero side, or one wholly outside the image) means the detector
  // emitted garbage, not that the JPEG is corrupt. Surface it as a
  // hard error so the operator sees a real signal in the dead-letter
  // queue instead of a misleading `thumb-undecodable` skip.
  if (width <= 0 || height <= 0) {
    throw new Error(
      `face-detector: invalid crop geometry left=${left} top=${top} ` +
        `width=${width} height=${height} from bbox=${JSON.stringify(detection.bbox)} ` +
        `image=${W}x${H}`,
    );
  }
  try {
    cropRaw = await sharp(jpegBytes)
      .extract({ left, top, width, height })
      .resize(MFN_INPUT_SIZE, MFN_INPUT_SIZE, { fit: "fill" })
      .removeAlpha()
      .raw()
      .toBuffer();
  } catch (err) {
    throw new ThumbDecodeError(err instanceof Error ? err.message : String(err));
  }
  const data = new Float32Array(3 * MFN_INPUT_SIZE * MFN_INPUT_SIZE);
  const plane = MFN_INPUT_SIZE * MFN_INPUT_SIZE;
  for (let i = 0; i < plane; i++) {
    const r = cropRaw[i * 3]!;
    const g = cropRaw[i * 3 + 1]!;
    const b = cropRaw[i * 3 + 2]!;
    data[i] = (r - 127.5) / 128.0;
    data[plane + i] = (g - 127.5) / 128.0;
    data[2 * plane + i] = (b - 127.5) / 128.0;
  }
  return new Tensor("float32", data, [1, 3, MFN_INPUT_SIZE, MFN_INPUT_SIZE]);
}

/** Pick the model's input tensor name. ONNX exporters disagree on what
 * to call the input — common values are `input`, `data`, `images`, etc.
 * — and `onnxruntime-node` exposes `inputNames` on the session.
 *
 * Fall back to a guess so the test stub (which doesn't expose the
 * field) keeps working. */
function inferInputName(
  session: OnnxSessionLike,
  fallback: string,
): string {
  const names = (session as unknown as { inputNames?: string[] }).inputNames;
  if (names && names.length > 0) return names[0]!;
  return fallback;
}

/** Decode RetinaFace's outputs into normalised face entries. The standard
 * RetinaFace ONNX export emits three tensors: `loc` (boxes), `conf`
 * (scores), and `landmarks`. We don't run the full anchor-decode +
 * NMS dance here — that's tied to the specific checkpoint's anchor
 * stride list, which we don't know without reading the model card.
 *
 * Strategy: if the model exports already-decoded boxes (some forks do —
 * shape `[N, 5]` for `[x1,y1,x2,y2,score]` or `[N, 15]` including
 * landmarks) we read them directly. Otherwise we throw a clear error
 * pointing at the model card. The worker treats that as a non-retryable
 * failure (dead-letter) so we stop hammering bad inputs.
 *
 * The structure is permissive on purpose — we'll tighten it in v2 once
 * we lock in a specific RetinaFace export.
 */
function decodeRetinaFaceOutputs(
  outputs: Record<string, OnnxTensorLike>,
  srcWidth: number,
  srcHeight: number,
): DetectedFace[] {
  // Prefer a decoded "faces" tensor when present.
  const decoded =
    outputs["faces"] ?? outputs["output"] ?? Object.values(outputs)[0];
  if (!decoded) return [];
  const dims = decoded.dims;
  if (dims.length !== 2) {
    throw new Error(
      `face-detector: unexpected RetinaFace output shape ${JSON.stringify(dims)}; expected 2D [N, K]`,
    );
  }
  const n = dims[0]!;
  const k = dims[1]!;
  if (n === 0) return [];
  if (k !== 5 && k !== 15) {
    throw new Error(
      `face-detector: unsupported RetinaFace output stride ${k}; expected 5 (bbox+score) or 15 (bbox+score+5 landmarks)`,
    );
  }
  const result: DetectedFace[] = [];
  const data = decoded.data as Float32Array;
  const W = srcWidth;
  const H = srcHeight;
  for (let i = 0; i < n; i++) {
    const off = i * k;
    const x1 = data[off]!;
    const y1 = data[off + 1]!;
    const x2 = data[off + 2]!;
    const y2 = data[off + 3]!;
    const score = data[off + 4]!;
    if (score < DEFAULT_DETECTION_THRESHOLD) continue;
    const bbox = {
      x: x1 / W,
      y: y1 / H,
      w: (x2 - x1) / W,
      h: (y2 - y1) / H,
    };
    const landmarks: Array<{ x: number; y: number }> = [];
    if (k === 15) {
      for (let j = 0; j < 5; j++) {
        landmarks.push({
          x: data[off + 5 + j * 2]! / W,
          y: data[off + 5 + j * 2 + 1]! / H,
        });
      }
    }
    result.push({ bbox, confidence: score, landmarks });
  }
  log.debug({ count: result.length }, "decoded RetinaFace detections");
  return result;
}

/** Extract the 512-D embedding from MobileFaceNet's outputs. The model's
 * single output tensor is the embedding. We L2-normalise so cosine
 * similarity in clustering reduces to a dot product. */
function extractEmbedding(
  outputs: Record<string, OnnxTensorLike>,
): Float32Array {
  const tensor = Object.values(outputs)[0];
  if (!tensor) {
    throw new Error("face-detector: MobileFaceNet returned no output");
  }
  const raw = tensor.data as Float32Array;
  // L2-normalise.
  let norm = 0;
  for (let i = 0; i < raw.length; i++) norm += raw[i]! * raw[i]!;
  norm = Math.sqrt(norm) || 1;
  const out = new Float32Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw[i]! / norm;
  return out;
}

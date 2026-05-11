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
    const { tensor } = await jpegToInputTensor(
      jpegBytes,
      RETINAFACE_INPUT_SIZE,
      Tensor,
    );
    const inputName = inferInputName(retinaFace, "input");
    const outputs = await retinaFace.run({ [inputName]: tensor });
    return decodeScrfdOutputs(outputs, RETINAFACE_INPUT_SIZE);
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
 *
 * Normalisation is `(pixel - 127.5) / 128.0` in RGB order — what both
 * InsightFace's SCRFD detector (`buffalo_s/det_500m.onnx`) and
 * MobileFaceNet expect. The earlier Caffe-style `(B-104, G-117, R-123)`
 * BGR preprocessing was for the legacy RetinaFace MobileNet0.25 export
 * that we no longer ship; SCRFD doesn't share that contract and the
 * mean-subtract path produced wildly wrong scores.
 *
 * Throws `ThumbDecodeError` if `sharp`/libvips can't read the input —
 * the worker handler converts that into `{ skip }` so corrupt thumbnails
 * dead-letter immediately instead of after 5 retries. */
async function jpegToInputTensor(
  jpegBytes: Uint8Array,
  size: number,
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
    data[i] = (r - 127.5) / 128.0;
    data[plane + i] = (g - 127.5) / 128.0;
    data[2 * plane + i] = (b - 127.5) / 128.0;
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

/** IoU threshold for the post-detection NMS pass. InsightFace's SCRFD
 * reference uses 0.4 — anything closer is treated as the same face. */
const NMS_IOU_THRESHOLD = 0.4;

/** Decode SCRFD's outputs into normalised face entries.
 *
 * The InsightFace `buffalo_s/det_500m.onnx` detector emits 9 tensors —
 * three feature-pyramid strides (8, 16, 32), each with three heads
 * (score, bbox, kps). Output names are export-specific integer strings
 * (e.g. `"443"`, `"446"`, `"449"`), so we don't key off names; instead
 * we bucket by tensor column count — `[N, 1]` is score, `[N, 4]` is
 * bbox, `[N, 10]` is kps — and pair them across heads by descending
 * row count, which orders them stride-8, stride-16, stride-32.
 *
 * Per-anchor decode follows SCRFD's `distance2bbox` convention: the
 * model emits four positive distances `(dl, dt, dr, db)` from the
 * anchor centre in stride units. The bbox corners are
 * `(cx - dl*s, cy - dt*s, cx + dr*s, cy + db*s)`. Landmarks decode as
 * absolute offsets from the same anchor centre, also in stride units.
 *
 * Coordinates come out in input-tensor space (`inputSize × inputSize`),
 * which `fit: "fill"` mapped 1:1 to the source aspect — so dividing by
 * `inputSize` gives the same normalised value as dividing by source
 * dims, and we don't need to track `srcWidth/srcHeight` past here.
 *
 * Final pass: greedy NMS at IoU 0.4 to drop duplicates across strides.
 */
function decodeScrfdOutputs(
  outputs: Record<string, OnnxTensorLike>,
  inputSize: number,
): DetectedFace[] {
  const scoreTensors: OnnxTensorLike[] = [];
  const bboxTensors: OnnxTensorLike[] = [];
  const kpsTensors: OnnxTensorLike[] = [];
  for (const t of Object.values(outputs)) {
    if (t.dims.length !== 2) continue;
    const k = t.dims[1]!;
    if (k === 1) scoreTensors.push(t);
    else if (k === 4) bboxTensors.push(t);
    else if (k === 10) kpsTensors.push(t);
  }
  // Descending by row count = stride 8 → 16 → 32 (the input area shrinks
  // by 4× each step, so more anchors at finer strides).
  const byRowsDesc = (a: OnnxTensorLike, b: OnnxTensorLike) =>
    b.dims[0]! - a.dims[0]!;
  scoreTensors.sort(byRowsDesc);
  bboxTensors.sort(byRowsDesc);
  kpsTensors.sort(byRowsDesc);

  if (scoreTensors.length === 0 || scoreTensors.length !== bboxTensors.length) {
    throw new Error(
      `face-detector: SCRFD outputs malformed — got ${scoreTensors.length} score tensors and ${bboxTensors.length} bbox tensors (kps=${kpsTensors.length}); expected matching counts (3 strides)`,
    );
  }

  const candidates: DetectedFace[] = [];
  for (let i = 0; i < scoreTensors.length; i++) {
    const scoreT = scoreTensors[i]!;
    const bboxT = bboxTensors[i]!;
    const kpsT: OnnxTensorLike | undefined = kpsTensors[i];
    const rows = scoreT.dims[0]!;
    const { stride, fmSize, numAnchors } = inferStrideLayout(rows, inputSize);
    const scoreData = scoreT.data as Float32Array;
    const bboxData = bboxT.data as Float32Array;
    const kpsData = kpsT ? (kpsT.data as Float32Array) : undefined;

    for (let idx = 0; idx < rows; idx++) {
      const score = scoreData[idx]!;
      if (score < DEFAULT_DETECTION_THRESHOLD) continue;
      // Anchors are tiled row-major over the (fmSize × fmSize) grid,
      // with `numAnchors` copies stacked at each cell.
      const spatial = Math.floor(idx / numAnchors);
      const row = Math.floor(spatial / fmSize);
      const col = spatial % fmSize;
      const cx = col * stride;
      const cy = row * stride;
      const dl = bboxData[idx * 4]! * stride;
      const dt = bboxData[idx * 4 + 1]! * stride;
      const dr = bboxData[idx * 4 + 2]! * stride;
      const db = bboxData[idx * 4 + 3]! * stride;
      const x1 = cx - dl;
      const y1 = cy - dt;
      const x2 = cx + dr;
      const y2 = cy + db;
      const landmarks: Array<{ x: number; y: number }> = [];
      if (kpsData) {
        for (let p = 0; p < 5; p++) {
          const px = cx + kpsData[idx * 10 + p * 2]! * stride;
          const py = cy + kpsData[idx * 10 + p * 2 + 1]! * stride;
          landmarks.push({ x: px / inputSize, y: py / inputSize });
        }
      }
      candidates.push({
        bbox: {
          x: x1 / inputSize,
          y: y1 / inputSize,
          w: (x2 - x1) / inputSize,
          h: (y2 - y1) / inputSize,
        },
        confidence: score,
        landmarks,
      });
    }
  }

  const kept = nms(candidates, NMS_IOU_THRESHOLD);
  log.debug(
    { candidates: candidates.length, kept: kept.length },
    "decoded SCRFD detections",
  );
  return kept;
}

/** Recover (stride, feature-map side, anchors-per-cell) from a head's
 * row count. SCRFD emits `numAnchors × (inputSize/stride)²` rows per
 * stride; we try the standard `numAnchors=2` first (what buffalo_s
 * uses) and fall back to `1` so an operator-supplied variant still
 * decodes. */
function inferStrideLayout(
  rows: number,
  inputSize: number,
): { stride: number; fmSize: number; numAnchors: number } {
  for (const numAnchors of [2, 1]) {
    if (rows % numAnchors !== 0) continue;
    const cells = rows / numAnchors;
    const fmSize = Math.round(Math.sqrt(cells));
    if (fmSize * fmSize !== cells) continue;
    if (inputSize % fmSize !== 0) continue;
    return { stride: inputSize / fmSize, fmSize, numAnchors };
  }
  throw new Error(
    `face-detector: cannot infer SCRFD stride layout from rows=${rows} input=${inputSize}`,
  );
}

/** Greedy non-maximum suppression. Sorts by confidence and drops every
 * detection that overlaps a higher-scoring one above `iouThreshold`. */
function nms(detections: DetectedFace[], iouThreshold: number): DetectedFace[] {
  const sorted = [...detections].sort(
    (a, b) => b.confidence - a.confidence,
  );
  const kept: DetectedFace[] = [];
  for (const det of sorted) {
    let suppress = false;
    for (const k of kept) {
      if (bboxIoU(det.bbox, k.bbox) > iouThreshold) {
        suppress = true;
        break;
      }
    }
    if (!suppress) kept.push(det);
  }
  return kept;
}

function bboxIoU(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
): number {
  const ax2 = a.x + a.w;
  const ay2 = a.y + a.h;
  const bx2 = b.x + b.w;
  const by2 = b.y + b.h;
  const ix1 = Math.max(a.x, b.x);
  const iy1 = Math.max(a.y, b.y);
  const ix2 = Math.min(ax2, bx2);
  const iy2 = Math.min(ay2, by2);
  const iw = Math.max(0, ix2 - ix1);
  const ih = Math.max(0, iy2 - iy1);
  const inter = iw * ih;
  const union = a.w * a.h + b.w * b.h - inter;
  if (union <= 0) return 0;
  return inter / union;
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

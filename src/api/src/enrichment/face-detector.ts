/**
 * ONNX wrapper around the face models loaded by `face-models.ts`.
 *
 * Pipeline overview (Phase 1 of the face-clustering quality upgrade):
 *
 *   1. `detectFaces(jpegBytes)` decodes the input to a 640×640 NCHW float
 *      tensor, runs the **SCRFD-10G** detector
 *      (`antelopev2/scrfd_10g_bnkps.onnx`, shipped as `scrfd_10g.onnx`),
 *      and returns one entry per detection: `{ bbox, confidence,
 *      landmarks }`, all in normalised [0,1] coordinates relative to
 *      the input image. The five landmarks (left eye, right eye, nose,
 *      left mouth, right mouth) are the identity-preserving keypoints
 *      recognised by every InsightFace head — they feed directly into
 *      the alignment step below.
 *
 *   2. `embedFace(jpegBytes, detection)` computes a similarity transform
 *      via Umeyama's closed-form least-squares method that maps the
 *      detected landmarks onto the canonical `arcface_dst` template
 *      (the standard 112×112 5-point template every InsightFace
 *      recognizer is trained on). The source image is warped through
 *      that transform with bilinear sampling, normalised to [-1,1] and
 *      fed to the **ArcFace R100** recognizer
 *      (`antelopev2/glintr100.onnx` — R100 trained on Glint360K,
 *      shipped as `arcface_r100_glint360k.onnx`). The 512-D L2-normalised
 *      output is the identity embedding.
 *
 * Landmark-based alignment is load-bearing: ArcFace R100's discrimination
 * is the headline reason for the buffalo_s → antelopev2 swap (buffalo_l
 * was considered but ships R50 — `w600k_r50.onnx` — not R100 despite
 * being the "large" bundle), and that discrimination collapses if the
 * input crop doesn't match the geometry the network was trained on. A
 * tilted-head crop fed bbox-only embeds about as well as a different
 * person's face — see InsightFace's own docs for the parity numbers.
 * Every face that reaches the embedder MUST have five landmarks in
 * normalised coordinates; the detector guarantees this for SCRFD
 * outputs.
 *
 * Image decode goes through `sharp` (already a dep — used by the indexer's
 * thumb pipeline). For detection we let sharp resize-to-640 directly; for
 * the recognizer we extract the raw RGB plane and warp in TS so the
 * sampling stays under our control (sharp's `affine` doesn't expose the
 * bilinear coefficients we'd need to match InsightFace's reference output).
 *
 * Spec: `docs/indexer-enrichment.md` §6.
 */

import sharp from 'sharp';
import { child as childLogger } from '../log.ts';
import {
  ARCFACE_DST,
  invertSimilarity,
  sampleBilinear,
  umeyamaSimilarity,
} from './face-similarity.ts';
import {
  loadFaceModels,
  type FaceModels,
  type OnnxSessionLike,
  type OnnxTensorConstructor,
  type OnnxTensorLike,
} from './face-models.ts';
import type * as FacePoolMod from './face-pool.ts';

const log = childLogger('enrichment:face-detector');

/** One-shot guard for the synthetic-landmarks warning. The re-embed
 * migration calls embedFace with empty landmarks for every legacy face
 * (the v1 detector didn't store them) — without this, a million-face
 * library would log a million WARN lines. We warn once at process
 * start and demote the rest to debug. */
let warnedSyntheticLandmarks = false;

/** Thrown when `sharp`/libvips cannot decode the thumbnail JPEG (e.g.
 * "VipsJpeg: Invalid SOS parameters"). Surfaces a non-retryable signal
 * to the worker handler, which converts it into a `{ skip }` so we
 * don't burn 5 retries on a permanently-corrupt thumbnail. */
export class ThumbDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ThumbDecodeError';
  }
}

/** Single detection from SCRFD. All coords normalised to [0,1]. */
export interface DetectedFace {
  bbox: { x: number; y: number; w: number; h: number };
  confidence: number;
  /** Five landmarks (left eye, right eye, nose, left mouth, right mouth)
   * in normalised coordinates. SCRFD's standard output. */
  landmarks: Array<{ x: number; y: number }>;
}

/** Sane default for the detection score gate. SCRFD-10G tends to emit
 * lots of low-confidence proposals; anything below ~0.5 is noise. */
export const DEFAULT_DETECTION_THRESHOLD = 0.5;

/** SCRFD-10G's standard input is 640×640, NCHW float32. The antelopev2
 * detector uses InsightFace's standard `(px - 127.5) / 128.0` per-channel
 * RGB normalisation — same as the v1 SCRFD-500m head. */
const DETECTOR_INPUT_SIZE = 640;

/** ArcFace R100's input is 112×112 NCHW float32, normalised to [-1, 1]
 * (i.e. (px - 127.5) / 128.0 per channel). Same normalisation as the v1
 * MobileFaceNet head — the input geometry (the 112×112 *crop content*)
 * is what changes between the two pipelines: ArcFace expects a
 * landmark-aligned face, not a bbox crop. */
const RECOGNIZER_INPUT_SIZE = 112;

/** Test/inject hook so worker tests can stub the detector without
 * touching ONNX. The `detectFaces` + `embedFace` pair is the entire
 * surface the worker depends on. */
export interface FaceDetector {
  detectFaces(jpegBytes: Uint8Array): Promise<DetectedFace[]>;
  embedFace(jpegBytes: Uint8Array, detection: DetectedFace): Promise<Float32Array>;
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
    const { detector, Tensor } = await this.models();
    const { tensor } = await jpegToInputTensor(jpegBytes, DETECTOR_INPUT_SIZE, Tensor);
    const inputName = inferInputName(detector, 'input.1');
    const outputs = await detector.run({ [inputName]: tensor });
    return decodeScrfdOutputs(outputs, DETECTOR_INPUT_SIZE);
  }

  async embedFace(jpegBytes: Uint8Array, detection: DetectedFace): Promise<Float32Array> {
    const { recognizer, Tensor } = await this.models();
    const aligned = await alignFaceCrop(jpegBytes, detection, Tensor);
    const inputName = inferInputName(recognizer, 'input.1');
    const outputs = await recognizer.run({ [inputName]: aligned });
    return extractEmbedding(outputs);
  }
}

/** Singleton. The stages grab this via `defaultFaceDetector()` so tests can
 * inject a stub without poking module internals. */
let defaultDetector: FaceDetector | null = null;

/**
 * The default face detector the stages call through.
 *
 * Production returns a `PooledFaceDetector`, which runs detect/embed on a
 * dedicated worker thread so the synchronous ONNX `session.run()` doesn't
 * freeze the HTTP event loop (#707). The worker runs this same
 * `OnnxFaceDetector` wholesale, so output is identical — the pool is a timing
 * change, not a results change. A test override set via
 * `setDefaultFaceDetectorForTests` short-circuits the pool entirely (the
 * override is consulted first), so stage tests keep stubbing the detector on
 * the main thread without spawning a worker.
 *
 * `PooledFaceDetector` is imported lazily (inside the function body, not at
 * module top level) to keep the `face-detector ↔ face-pool` import cycle inert
 * during module evaluation: the pool imports `OnnxFaceDetector` from here, and
 * resolving that binding at this module's eval time would be order-sensitive.
 */
export function defaultFaceDetector(): FaceDetector {
  if (!defaultDetector) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { PooledFaceDetector } = require('./face-pool.ts') as typeof FacePoolMod;
    defaultDetector = new PooledFaceDetector();
  }
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
 * InsightFace's SCRFD-10G detector and the ArcFace R100 recognizer
 * expect.
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
    // `toColourspace('srgb')` forces a 3-channel RGB output even when the
    // input is single-channel grayscale (a small but real fraction of
    // user libraries — scans, B&W JPEGs from older cameras). Without it,
    // `.raw()` would yield a 1-channel buffer and the (r,g,b) indexing
    // below would read into adjacent pixels' luma values. `removeAlpha()`
    // then drops the alpha channel if present (4 → 3) without affecting
    // the already-3-channel path.
    raw = await img
      .resize(size, size, { fit: 'fill' })
      .toColourspace('srgb')
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
    tensor: new Tensor('float32', data, [1, 3, size, size]),
    srcWidth,
    srcHeight,
  };
}

/** Warp the face out of the JPEG via a 5-point landmark similarity
 * transform onto the canonical `arcface_dst` template at 112×112, then
 * package it as an NCHW float32 recognizer input.
 *
 * The transform is computed by `umeyamaSimilarity` (closed-form
 * Umeyama 1991 — covariance SVD, with the sign-correction rule that
 * makes it a proper rotation rather than a reflection). We invert it
 * via `invertSimilarity` so we can sample the source image at the
 * pre-image of every output pixel — that's bilinear interpolation in
 * the conventional sense for image warps and avoids any "where do output
 * pixels land" rasterisation issues.
 *
 * Falls back to a bbox-derived synthetic landmark set when the detection
 * has no landmarks (operator-injected face, hand-edited XMP) — preserves
 * the v0 behaviour but logs a warning since the embedding quality drops
 * meaningfully without real landmarks.
 */
async function alignFaceCrop(
  jpegBytes: Uint8Array,
  detection: DetectedFace,
  Tensor: OnnxTensorConstructor,
): Promise<OnnxTensorLike> {
  let W: number;
  let H: number;
  let raw: Buffer;
  let channels: number;
  try {
    const img = sharp(jpegBytes);
    const meta = await img.metadata();
    W = meta.width ?? 0;
    H = meta.height ?? 0;
    if (W === 0 || H === 0) {
      // Dimension sanity check sits OUTSIDE the catch on purpose:
      // sharp accepting bytes but returning zero dims would indicate a
      // bug in our preprocessing pipeline, not a corrupt JPEG, so we
      // surface it as a hard error rather than swallowing it as
      // `thumb-undecodable`.
      throw new Error('face-detector: unable to read image dimensions');
    }
    // Same reason as in `jpegToInputTensor`: `toColourspace('srgb')`
    // forces a 3-channel RGB output even when the input is single-channel
    // grayscale (B&W scans, older cameras). Without it, the bilinear
    // sampler below would read garbage out of a 1-channel buffer because
    // it assumes a 3-byte stride per pixel.
    raw = await img.toColourspace('srgb').removeAlpha().raw().toBuffer();
    channels = 3;
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('face-detector:')) {
      // Re-throw our own hard error untouched (see comment above).
      throw err;
    }
    throw new ThumbDecodeError(err instanceof Error ? err.message : String(err));
  }
  if (raw.length !== W * H * channels) {
    // Defensive — sharp should always return W*H*3 bytes after removeAlpha,
    // but if anything ever changes upstream we want a hard error, not
    // out-of-bounds reads in the warp loop.
    throw new Error(
      `face-detector: raw buffer size mismatch (${raw.length} bytes for ${W}x${H}x${channels})`,
    );
  }

  // Build the source landmark set in source-image pixel coordinates.
  // Detector landmarks are normalised to [0,1] — multiply through.
  let landmarksPx: Array<[number, number]>;
  if (detection.landmarks && detection.landmarks.length === 5) {
    landmarksPx = detection.landmarks.map((p) => [p.x * W, p.y * H] as [number, number]);
  } else {
    // No landmarks — synthesise a sensible default set from the bbox so
    // we still produce a workable embedding. Quality drops a lot here
    // because the points are guesses; warn once per process so the
    // operator knows but the migration of N legacy faces doesn't spam
    // N lines into the log.
    if (!warnedSyntheticLandmarks) {
      warnedSyntheticLandmarks = true;
      log.warn(
        'face has no landmarks — using bbox-derived synthetic template (embedding quality reduced); subsequent occurrences logged at debug level',
      );
    } else {
      log.debug({ bbox: detection.bbox }, 'face has no landmarks — synthetic template');
    }
    const bx = detection.bbox.x * W;
    const by = detection.bbox.y * H;
    const bw = detection.bbox.w * W;
    const bh = detection.bbox.h * H;
    // Scale ARCFACE_DST down to the bbox; result is upright by construction.
    landmarksPx = ARCFACE_DST.map(
      ([tx, ty]) => [bx + (tx / 112) * bw, by + (ty / 112) * bh] as [number, number],
    );
  }

  // Reject degenerate inputs early so the warp loop doesn't have to.
  // A bbox with zero area means the detector emitted garbage; we want
  // that to surface as a real error rather than silently producing
  // an embedding of the image's top-left corner.
  if (detection.bbox.w * W <= 0 || detection.bbox.h * H <= 0) {
    throw new Error(
      `face-detector: invalid crop geometry from bbox=${JSON.stringify(detection.bbox)} image=${W}x${H}`,
    );
  }

  // Solve the similarity transform mapping landmarksPx → ARCFACE_DST.
  // Then invert it so we can sample the source for every output pixel
  // (the conventional inverse-warp setup for bilinear resampling).
  const fwd = umeyamaSimilarity(landmarksPx, ARCFACE_DST);
  const inv = invertSimilarity(fwd);

  const S = RECOGNIZER_INPUT_SIZE;
  const data = new Float32Array(3 * S * S);
  const plane = S * S;
  const a = inv.a;
  const b = inv.b;
  const tx = inv.tx;
  const ty = inv.ty;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      // Forward similarity is (x',y') = a*(x,y) + b*(-y,x)? No — for a
      // 2×2 rotation+scale the matrix is [[a, -b],[b, a]] in standard
      // form. We use that explicit form (rather than a generic affine)
      // because it preserves the "rotation+uniform-scale" property the
      // Umeyama solver returns.
      const srcX = a * x - b * y + tx;
      const srcY = b * x + a * y + ty;
      const sample = sampleBilinear(raw, W, H, srcX, srcY);
      const r = sample[0];
      const g = sample[1];
      const blue = sample[2];
      const idx = y * S + x;
      data[idx] = (r - 127.5) / 128.0;
      data[plane + idx] = (g - 127.5) / 128.0;
      data[2 * plane + idx] = (blue - 127.5) / 128.0;
    }
  }
  return new Tensor('float32', data, [1, 3, S, S]);
}

/** Pick the model's input tensor name. ONNX exporters disagree on what
 * to call the input — common values are `input`, `data`, `images`,
 * `input.1`, etc. — and `onnxruntime-node` exposes `inputNames` on the
 * session.
 *
 * Fall back to a guess so the test stub (which doesn't expose the
 * field) keeps working. */
function inferInputName(session: OnnxSessionLike, fallback: string): string {
  const names = (session as unknown as { inputNames?: string[] }).inputNames;
  if (names && names.length > 0) return names[0]!;
  return fallback;
}

/** IoU threshold for the post-detection NMS pass. InsightFace's SCRFD
 * reference uses 0.4 — anything closer is treated as the same face. */
const NMS_IOU_THRESHOLD = 0.4;

/** Decode SCRFD's outputs into normalised face entries.
 *
 * SCRFD (both `det_500m.onnx` and `det_10g.onnx`) emits 9 tensors —
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
  const byRowsDesc = (a: OnnxTensorLike, b: OnnxTensorLike) => b.dims[0]! - a.dims[0]!;
  scoreTensors.sort(byRowsDesc);
  bboxTensors.sort(byRowsDesc);
  kpsTensors.sort(byRowsDesc);

  if (scoreTensors.length === 0 || scoreTensors.length !== bboxTensors.length) {
    throw new Error(
      `face-detector: SCRFD outputs malformed — got ${scoreTensors.length} score tensors and ${bboxTensors.length} bbox tensors (kps=${kpsTensors.length}); expected matching score/bbox counts (typically one per stride)`,
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
  log.debug({ candidates: candidates.length, kept: kept.length }, 'decoded SCRFD detections');
  return kept;
}

/** Recover (stride, feature-map side, anchors-per-cell) from a head's
 * row count. SCRFD emits `numAnchors × (inputSize/stride)²` rows per
 * stride. We try `numAnchors ∈ {2, 1}` first — the values used by
 * every public SCRFD variant — and 4 as a generous fallback for
 * operator-supplied SCRFD/YOLO-style exports that pack more anchors
 * per cell. Beyond 4 you should be locking the model down anyway. */
function inferStrideLayout(
  rows: number,
  inputSize: number,
): { stride: number; fmSize: number; numAnchors: number } {
  for (const numAnchors of [2, 1, 4, 3]) {
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
  const sorted = [...detections].sort((a, b) => b.confidence - a.confidence);
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

/** Extract the 512-D embedding from the recognizer's outputs. The model's
 * single output tensor is the embedding. We L2-normalise so cosine
 * similarity in clustering reduces to a dot product. */
function extractEmbedding(outputs: Record<string, OnnxTensorLike>): Float32Array {
  const tensor = Object.values(outputs)[0];
  if (!tensor) {
    throw new Error('face-detector: recognizer returned no output');
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

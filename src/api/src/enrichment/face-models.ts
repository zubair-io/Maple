/**
 * Face-detection model lifecycle.
 *
 * Phase 5 of `docs/indexer-enrichment.md`. The face worker depends on two
 * ONNX models — a face **detector** (SCRFD-10G from InsightFace's
 * `antelopev2` bundle) that emits bounding boxes + 5-point landmarks, and
 * a face **recognizer** (ArcFace **R100**, `glintr100.onnx`, same bundle —
 * R100 trained on Glint360K) that produces the 512-D identity embedding
 * from a landmark-aligned 112×112 crop. Both are loaded lazily on first
 * inference and shared as singletons across worker instances within a
 * process: the model-load step is heavy (cold load can be seconds), and
 * the runtime sessions are cheap to share since calls run on the worker's
 * own main loop with `pool size 1` (CPU-bound).
 *
 * Why antelopev2 (not buffalo_l): buffalo_l's recognizer is actually
 * ArcFace **R50** (`w600k_r50.onnx`, trained on WebFace600K) — the
 * filename is the giveaway. antelopev2 ships the real R100 weights
 * (`glintr100.onnx`, trained on Glint360K), which is the canonical
 * high-quality InsightFace recognizer. Both bundles ship SCRFD-10G as
 * their detector (different filenames; same architecture).
 *
 * Resolution order for each model file:
 *
 *   1. Operator dropped the file at `<modelDir>/<basename>` — use that.
 *   2. DB row from /settings/enrichment OR `MAPLE_FACE_DETECTOR_URL` /
 *      `MAPLE_FACE_RECOGNIZER_URL` env var is set — download once into
 *      the model dir, verify the SHA256, then use it. The legacy
 *      `MAPLE_FACE_RETINAFACE_URL` / `MAPLE_FACE_MOBILEFACENET_URL`
 *      env vars are still honoured but log a deprecation warning at
 *      boot — they point at the OLD pipeline's model files (SCRFD-500m
 *      + MobileFaceNet) which are no longer compatible with the
 *      detector/recognizer code in this process.
 *   3. Zero-config fallback: download InsightFace's `antelopev2.zip`
 *      from its public GitHub Release, extract the two files. Suppress
 *      with `MAPLE_FACE_NO_AUTO_DOWNLOAD=true` to force step 1 or 2.
 *
 * Test override: `setFaceModelLoaderForTests(loader)` lets the worker tests
 * inject a fake session pair without touching disk or `onnxruntime-node`.
 *
 * Spec: `docs/indexer-enrichment.md` §6 ("Face worker").
 */

import { existsSync, mkdirSync, statSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { availableParallelism, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { child as childLogger } from '../log.ts';
import { downloadAntelopeV2Default } from './face-models-bootstrap.ts';

const log = childLogger('enrichment:face-models');

/** Minimal ONNX session contract — shaped to match `onnxruntime-node`'s
 * `InferenceSession` so the real lib drops in without an adapter, but
 * narrow enough that tests can fake it. */
export interface OnnxSessionLike {
  run(
    feeds: Record<string, OnnxTensorLike>,
    options?: Record<string, unknown>,
  ): Promise<Record<string, OnnxTensorLike>>;
}

/** Tensor contract — matches `onnxruntime-node`'s `Tensor` for the float32
 * case, which is all the face models use.
 *
 * `type` and `location` are required (not just `data`/`dims`) because the
 * native ORT binding rejects feeds whose `.location`/`.type` aren't
 * strings — see `OnnxTensorConstructor` below. Encoding that in the type
 * means a plain `{ data, dims }` object won't typecheck as a feed, so
 * the regression that broke face detection in 1.26 can't reappear
 * silently. */
export interface OnnxTensorLike {
  readonly type: string;
  readonly data: Float32Array | Uint8Array;
  readonly dims: readonly number[];
  readonly location: string;
}

/** Constructor for an ORT-compatible tensor. The native `onnxruntime-node`
 * binding validates each feed's `.location` (string) and `.type` (string)
 * at the C++ layer — plain `{ data, dims }` objects fail with
 * "Tensor.location must be a string." Real `Tensor` instances default
 * `location` to `'cpu'`, so we route all feed construction through the
 * runtime's own constructor. */
export interface OnnxTensorConstructor {
  new (type: 'float32', data: Float32Array, dims: readonly number[]): OnnxTensorLike;
}

/** Loaded model pair handed to the face detector. */
export interface FaceModels {
  /** SCRFD-10G detector session (replaces the v1 SCRFD-500m head).
   * Shipped as `scrfd_10g_bnkps.onnx` inside the antelopev2 bundle. */
  detector: OnnxSessionLike;
  /** ArcFace R100 recognizer session, trained on Glint360K (replaces v1
   * MobileFaceNet). Shipped as `glintr100.onnx` inside the antelopev2
   * bundle. */
  recognizer: OnnxSessionLike;
  /** ORT Tensor constructor — surfaced through the loader so callers don't
   * have to import `onnxruntime-node` directly (keeps the dep optional). */
  Tensor: OnnxTensorConstructor;
  /** Resolved on-disk paths the sessions were loaded from. Surfaced for
   * the operator status endpoint so they can confirm which files booted. */
  paths: { detector: string; recognizer: string };
}

/**
 * The embedding-version tag stamped on every face document produced by the
 * current model pair. Bump this string when the pipeline changes in a way
 * that makes existing embeddings incompatible with new ones (different
 * recognizer architecture, different alignment template, different
 * normalisation). The re-embed migration uses it as the gate for whether
 * to recompute an existing face's embedding.
 *
 * The tag intentionally encodes the training dataset (`glint360k`) as
 * well as the architecture (`arcface_r100`) — distinct datasets produce
 * distinct embedding spaces even when the architecture matches, and a
 * future swap from one to the other must trigger a re-embed migration.
 *
 * Tag for the v1 pipeline (SCRFD-500m + MobileFaceNet, bbox-only crop):
 * `"mobilefacenet_v1"` — used by the migration to identify rows that
 * predate this commit. Old face docs without an `embedding_version` field
 * are treated as `"mobilefacenet_v1"`.
 */
export const CURRENT_EMBEDDING_VERSION = 'arcface_r100_glint360k_v1' as const;

/** Tag used for face docs produced by the OLD (pre-antelopev2) pipeline.
 * Surfaced as a constant so the migration's matcher and the test suite
 * agree on the exact string. */
export const LEGACY_EMBEDDING_VERSION = 'mobilefacenet_v1' as const;

/** Test override hook. When set, `loadFaceModels()` returns the loader's
 * result instead of going through the disk + ONNX runtime path. */
export type FaceModelLoader = () => Promise<FaceModels>;

let injectedLoader: FaceModelLoader | null = null;
let singleton: FaceModels | null = null;
let loadPromise: Promise<FaceModels> | null = null;

/** Test-only: inject a loader. Pass `null` to clear and fall back to the
 * real disk + ONNX path. Resets the singleton so the next call rebuilds. */
export function setFaceModelLoaderForTests(loader: FaceModelLoader | null): void {
  injectedLoader = loader;
  singleton = null;
  loadPromise = null;
  liveStatus = { kind: 'idle' };
}

/** Default model directory — `~/.maple/models/`. Honours `MAPLE_MODEL_DIR`
 * for tests / non-standard installs. */
export function defaultModelDir(): string {
  return process.env.MAPLE_MODEL_DIR ?? join(homedir(), '.maple', 'models');
}

/** Parse an env-var thread-count override. Returns `fallback` if `raw` is
 * unset, not a finite positive integer, or otherwise invalid. ORT silently
 * reverts to its host-CPU-count default on `0` / `NaN` / negative values
 * (which is the exact misbehaviour this module fixes), so reject those
 * here and log loud so operator misconfigs surface. */
export function resolveOrtThreadCount(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    log.warn({ raw, fallback }, 'invalid ORT thread-count env value; falling back to default');
    return fallback;
  }
  return n;
}

/** File name used for each model under the model dir. Operator can drop a
 * file at `<modelDir>/<basename>` to skip the download path entirely.
 *
 * The basenames intentionally reflect the actual model architecture (SCRFD
 * 10G + ArcFace R100 trained on Glint360K) rather than the v1 misnomers
 * (`retinaface.onnx` / `mobilefacenet.onnx`). The recognizer basename
 * names the training dataset (`glint360k`) too — distinct datasets
 * produce incompatible embedding spaces even when the architecture
 * matches, so operators should not mix files across bundles.
 *
 * Operators upgrading from v1 must move or delete the old files — they
 * won't be picked up automatically. */
export const DETECTOR_BASENAME = 'scrfd_10g.onnx';
export const RECOGNIZER_BASENAME = 'arcface_r100_glint360k.onnx';

// ── Live status surface ────────────────────────────────────────────────
// Module-level state the route handler reads to power the UI badge on
// /settings/enrichment. Updated by `loadFaceModels()` at every state
// transition so the operator can see whether a download is in flight,
// whether the load succeeded, or what failed.

export type FaceModelsLoadStatus =
  | 'idle' // loadFaceModels has not been called this process
  | 'downloading' // antelopev2 default bundle is being fetched
  | 'loaded' // ONNX sessions are live
  | 'error'; // last load attempt failed

interface InternalStatus {
  kind: FaceModelsLoadStatus;
  errorDetail?: string;
}

let liveStatus: InternalStatus = { kind: 'idle' };

/** Snapshot of the loader's current state. Pure read — never triggers
 * a load. Used by the /api/enrichment/config route to populate the UI
 * badge. */
export function getFaceModelsStatus(): {
  kind: FaceModelsLoadStatus;
  errorDetail: string | null;
} {
  return { kind: liveStatus.kind, errorDetail: liveStatus.errorDetail ?? null };
}

/** Inspect a model directory without loading anything. Reports whether
 * each ONNX file is on disk and how big it is. The route uses this to
 * tell the operator "files are ready, will load on worker enable" vs.
 * "files are missing, auto-download will run on enable". */
export function probeFaceModelFiles(dir: string): {
  detector: { path: string; present: boolean; bytes: number };
  recognizer: { path: string; present: boolean; bytes: number };
} {
  const probe = (basename: string) => {
    const path = join(dir, basename);
    if (!existsSync(path)) return { path, present: false, bytes: 0 };
    try {
      return { path, present: true, bytes: statSync(path).size };
    } catch {
      return { path, present: false, bytes: 0 };
    }
  };
  return {
    detector: probe(DETECTOR_BASENAME),
    recognizer: probe(RECOGNIZER_BASENAME),
  };
}

/**
 * Load (or return the cached) singleton model pair. Safe to call from
 * multiple workers concurrently — only one disk + load round-trip is
 * performed; subsequent callers await the in-flight promise.
 *
 * Throws if a model file is missing AND no download URL is set. The
 * caller (face bootstrap) catches this and leaves the worker dormant
 * with a loud log line, so the rest of the API stays up.
 */
export interface FaceModelsConfig {
  /** Directory the model files live in (or get downloaded into).
   * `bootstrap.ts` passes the resolved DB → env → default value. */
  modelDir?: string;
  /** Operator-supplied download URL for the SCRFD-10G detector. Used only
   * when the file isn't already on disk. */
  detectorUrl?: string | null;
  detectorSha256?: string | null;
  /** Operator-supplied download URL for the ArcFace R100 recognizer. */
  recognizerUrl?: string | null;
  recognizerSha256?: string | null;
}

export async function loadFaceModels(config: FaceModelsConfig = {}): Promise<FaceModels> {
  if (singleton) return singleton;
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    if (injectedLoader) {
      const m = await injectedLoader();
      singleton = m;
      liveStatus = { kind: 'loaded' };
      return m;
    }
    const dir = config.modelDir ?? defaultModelDir();
    mkdirSync(dir, { recursive: true });

    // Resolve URLs from the call-site config OR env. Honour the legacy
    // MAPLE_FACE_RETINAFACE_URL / MAPLE_FACE_MOBILEFACENET_URL env vars
    // so operators with those set in production keep booting, but log a
    // loud deprecation line: the underlying model architecture has
    // changed (SCRFD-500m → 10G, MobileFaceNet → ArcFace R100), so a
    // v1-era custom URL almost certainly points at the wrong weights.
    const detectorUrl =
      config.detectorUrl ?? process.env.MAPLE_FACE_DETECTOR_URL ?? legacyDetectorUrl();
    const detectorSha =
      config.detectorSha256 ??
      process.env.MAPLE_FACE_DETECTOR_SHA256 ??
      process.env.MAPLE_FACE_RETINAFACE_SHA256 ??
      null;
    const recognizerUrl =
      config.recognizerUrl ?? process.env.MAPLE_FACE_RECOGNIZER_URL ?? legacyRecognizerUrl();
    const recognizerSha =
      config.recognizerSha256 ??
      process.env.MAPLE_FACE_RECOGNIZER_SHA256 ??
      process.env.MAPLE_FACE_MOBILEFACENET_SHA256 ??
      null;

    // Zero-config bootstrap: if neither model file exists on disk AND
    // neither has a configured URL, fetch + extract the InsightFace
    // antelopev2 bundle from its public GitHub Release. This is the
    // "personal install, just works at boot" path. Operator can disable
    // by setting `MAPLE_FACE_NO_AUTO_DOWNLOAD=true`, or override with
    // their own URLs to skip this branch.
    if (
      process.env.MAPLE_FACE_NO_AUTO_DOWNLOAD !== 'true' &&
      !existsSync(join(dir, DETECTOR_BASENAME)) &&
      !existsSync(join(dir, RECOGNIZER_BASENAME)) &&
      !detectorUrl &&
      !recognizerUrl
    ) {
      liveStatus = { kind: 'downloading' };
      await downloadAntelopeV2Default(dir, DETECTOR_BASENAME, RECOGNIZER_BASENAME);
    }

    const detectorPath = await ensureModelFile({
      dir,
      basename: DETECTOR_BASENAME,
      url: detectorUrl,
      sha256: detectorSha,
    });
    const recognizerPath = await ensureModelFile({
      dir,
      basename: RECOGNIZER_BASENAME,
      url: recognizerUrl,
      sha256: recognizerSha,
    });
    const ort = await loadOnnxRuntime();
    // Constrain ORT thread pools. Without explicit thread counts, the native
    // binding sizes its intra-op pool to the host's logical CPU count and
    // tries to pin each thread to a distinct CPU via pthread_setaffinity_np.
    // In a container whose cgroup cpuset is narrower than the host (the
    // common case for 64–128-core hosts running Docker), most of those pins
    // fail with EINVAL and ORT spams stderr — one ERROR line per thread per
    // session — before the load even completes. The face stage runs with
    // `concurrency: 1` (workers/stages/face.ts), so a small pool is plenty.
    const sessionOptions = {
      intraOpNumThreads: resolveOrtThreadCount(
        process.env.MAPLE_FACE_ORT_INTRA_OP_THREADS,
        Math.min(4, availableParallelism()),
      ),
      interOpNumThreads: resolveOrtThreadCount(process.env.MAPLE_FACE_ORT_INTER_OP_THREADS, 1),
    };
    log.info({ detectorPath, recognizerPath, sessionOptions }, 'loading ONNX face models');
    const detector = await ort.InferenceSession.create(detectorPath, sessionOptions);
    const recognizer = await ort.InferenceSession.create(recognizerPath, sessionOptions);
    singleton = {
      detector,
      recognizer,
      Tensor: ort.Tensor,
      paths: { detector: detectorPath, recognizer: recognizerPath },
    };
    liveStatus = { kind: 'loaded' };
    log.info('ONNX face models ready');
    return singleton;
  })();

  try {
    return await loadPromise;
  } catch (err) {
    // Reset on failure so a subsequent call retries (e.g. operator drops
    // the file in after the first boot attempt).
    loadPromise = null;
    singleton = null;
    liveStatus = {
      kind: 'error',
      errorDetail: err instanceof Error ? err.message : String(err),
    };
    throw err;
  }
}

/** Read the legacy `MAPLE_FACE_RETINAFACE_URL` env var. If present, log a
 * one-shot deprecation warning so operators see it in their boot logs.
 * Returns the value (or null) — the caller treats it as a fallback for the
 * new `MAPLE_FACE_DETECTOR_URL`. */
let warnedLegacyDetector = false;
function legacyDetectorUrl(): string | null {
  const v = process.env.MAPLE_FACE_RETINAFACE_URL;
  if (typeof v === 'string' && v.length > 0) {
    if (!warnedLegacyDetector) {
      warnedLegacyDetector = true;
      log.warn(
        { url: v },
        'MAPLE_FACE_RETINAFACE_URL is deprecated — switch to MAPLE_FACE_DETECTOR_URL. ' +
          'The face pipeline now expects SCRFD-10G (antelopev2/scrfd_10g_bnkps.onnx); the v1 URL likely points at SCRFD-500m and will produce poor detections.',
      );
    }
    return v;
  }
  return null;
}

let warnedLegacyRecognizer = false;
function legacyRecognizerUrl(): string | null {
  const v = process.env.MAPLE_FACE_MOBILEFACENET_URL;
  if (typeof v === 'string' && v.length > 0) {
    if (!warnedLegacyRecognizer) {
      warnedLegacyRecognizer = true;
      log.warn(
        { url: v },
        'MAPLE_FACE_MOBILEFACENET_URL is deprecated — switch to MAPLE_FACE_RECOGNIZER_URL. ' +
          'The face pipeline now expects ArcFace R100 trained on Glint360K (antelopev2/glintr100.onnx); the v1 URL likely points at MobileFaceNet (mbf) and is incompatible with the new alignment path.',
      );
    }
    return v;
  }
  return null;
}

interface EnsureFileOpts {
  dir: string;
  basename: string;
  /** Download URL — `null` when neither DB nor env supplied one. The
   * loader then requires the file to be already present at `dir/basename`. */
  url: string | null;
  /** Hex SHA256 to verify the downloaded blob. `null` skips verification. */
  sha256: string | null;
}

/** Resolve one model file. Order: existing on-disk file → download from
 * URL with optional SHA256 check → throw with operator-actionable advice.
 * Never invents a default URL. */
async function ensureModelFile(opts: EnsureFileOpts): Promise<string> {
  const target = join(opts.dir, opts.basename);
  if (existsSync(target) && statSync(target).size > 0) {
    return target;
  }
  if (!opts.url || opts.url.length === 0) {
    throw new Error(
      `Face model "${opts.basename}" not found at ${target}. ` +
        `Set the download URL via /settings/enrichment or drop the file at ${target}.`,
    );
  }
  log.info({ url: opts.url, target }, 'downloading face model');
  const res = await fetch(opts.url);
  if (!res.ok) {
    throw new Error(`Failed to download face model from ${opts.url}: HTTP ${res.status}`);
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (opts.sha256 && opts.sha256.length > 0) {
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual.toLowerCase() !== opts.sha256.toLowerCase()) {
      throw new Error(
        `SHA256 mismatch for ${opts.basename}: expected ${opts.sha256}, got ${actual}`,
      );
    }
  }
  mkdirSync(dirname(target), { recursive: true });
  await writeFile(target, bytes);
  log.info({ target, bytes: bytes.length }, 'face model downloaded');
  return target;
}

interface OnnxRuntimeModule {
  InferenceSession: {
    create(
      path: string,
      options?: {
        intraOpNumThreads?: number;
        interOpNumThreads?: number;
      },
    ): Promise<OnnxSessionLike>;
  };
  Tensor: OnnxTensorConstructor;
}

/** Lazy-import `onnxruntime-node`. Kept dynamic so the API process can
 * boot (and tests can run) without the package installed — only the
 * face worker hitting the real model-load path needs it. */
async function loadOnnxRuntime(): Promise<OnnxRuntimeModule> {
  try {
    // Lazy-imported so the typecheck doesn't require the dep on machines
    // where the face worker isn't enabled. Bun resolves this at call time.
    const mod = (await import('onnxruntime-node')) as unknown as OnnxRuntimeModule;
    return mod;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `onnxruntime-node not installed (${msg}). Run \`bun add onnxruntime-node\` in src/api.`,
    );
  }
}

/** Test-only: peek at the cached singleton without triggering a load. */
export function _getCachedModelsForTests(): FaceModels | null {
  return singleton;
}

/**
 * Face-detection model lifecycle.
 *
 * Phase 5 of `docs/indexer-enrichment.md`. The face worker depends on two
 * ONNX models — RetinaFace (detection + landmarks) and MobileFaceNet (the
 * 512-D embedding head). Both are loaded lazily on first inference and
 * shared as singletons across worker instances within a process: the
 * model-load step is heavy (cold load can be seconds), and the runtime
 * sessions are cheap to share since calls run on the worker's own main
 * loop with `pool size 1` (CPU-bound).
 *
 * Resolution order for each model file:
 *
 *   1. Operator dropped the file at `<modelDir>/<basename>` — use that.
 *   2. `MAPLE_FACE_RETINAFACE_URL` / `MAPLE_FACE_MOBILEFACENET_URL` is
 *      set — download once into the model dir, verify the SHA256, then
 *      use it.
 *   3. Neither — fail fast with a single, actionable error message that
 *      lists both options. Never download from a guessed URL.
 *
 * Test override: `setFaceModelLoaderForTests(loader)` lets the worker tests
 * inject a fake session pair without touching disk or `onnxruntime-node`.
 *
 * Spec: `docs/indexer-enrichment.md` §6 ("Face worker").
 */

import { existsSync, mkdirSync, statSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { child as childLogger } from "../log.ts";

const log = childLogger("enrichment:face-models");

/** Minimal ONNX session contract — shaped to match `onnxruntime-node`'s
 * `InferenceSession` so the real lib drops in without an adapter, but
 * narrow enough that tests can fake it. */
export interface OnnxSessionLike {
  run(
    feeds: Record<string, OnnxTensorLike>,
    options?: Record<string, unknown>,
  ): Promise<Record<string, OnnxTensorLike>>;
}

/** Tensor contract — a typed-array `data` plus a `dims` shape. Matches
 * `onnxruntime-node`'s `Tensor` for the float32 case, which is all the
 * face models use. */
export interface OnnxTensorLike {
  data: Float32Array | Uint8Array;
  dims: readonly number[];
}

/** Loaded model pair handed to the face detector. */
export interface FaceModels {
  retinaFace: OnnxSessionLike;
  mobileFaceNet: OnnxSessionLike;
  /** Resolved on-disk paths the sessions were loaded from. Surfaced for
   * the operator status endpoint so they can confirm which files booted. */
  paths: { retinaFace: string; mobileFaceNet: string };
}

/** Test override hook. When set, `loadFaceModels()` returns the loader's
 * result instead of going through the disk + ONNX runtime path. */
export type FaceModelLoader = () => Promise<FaceModels>;

let injectedLoader: FaceModelLoader | null = null;
let singleton: FaceModels | null = null;
let loadPromise: Promise<FaceModels> | null = null;

/** Test-only: inject a loader. Pass `null` to clear and fall back to the
 * real disk + ONNX path. Resets the singleton so the next call rebuilds. */
export function setFaceModelLoaderForTests(
  loader: FaceModelLoader | null,
): void {
  injectedLoader = loader;
  singleton = null;
  loadPromise = null;
}

/** Default model directory — `~/.maple/models/`. Honours `MAPLE_MODEL_DIR`
 * for tests / non-standard installs. */
export function defaultModelDir(): string {
  return process.env.MAPLE_MODEL_DIR ?? join(homedir(), ".maple", "models");
}

/** File name used for each model under the model dir. Operator can drop a
 * file at `<modelDir>/<basename>` to skip the download path entirely. */
export const RETINAFACE_BASENAME = "retinaface.onnx";
export const MOBILEFACENET_BASENAME = "mobilefacenet.onnx";

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
  /** Operator-supplied download URL for `retinaface.onnx`. Used only
   * when the file isn't already on disk. */
  retinafaceUrl?: string | null;
  retinafaceSha256?: string | null;
  mobilefacenetUrl?: string | null;
  mobilefacenetSha256?: string | null;
}

export async function loadFaceModels(
  config: FaceModelsConfig = {},
): Promise<FaceModels> {
  if (singleton) return singleton;
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    if (injectedLoader) {
      const m = await injectedLoader();
      singleton = m;
      return m;
    }
    const dir = config.modelDir ?? defaultModelDir();
    mkdirSync(dir, { recursive: true });
    const retinaPath = await ensureModelFile({
      dir,
      basename: RETINAFACE_BASENAME,
      url: config.retinafaceUrl ?? process.env.MAPLE_FACE_RETINAFACE_URL ?? null,
      sha256:
        config.retinafaceSha256 ?? process.env.MAPLE_FACE_RETINAFACE_SHA256 ?? null,
    });
    const mfnPath = await ensureModelFile({
      dir,
      basename: MOBILEFACENET_BASENAME,
      url:
        config.mobilefacenetUrl ?? process.env.MAPLE_FACE_MOBILEFACENET_URL ?? null,
      sha256:
        config.mobilefacenetSha256 ??
        process.env.MAPLE_FACE_MOBILEFACENET_SHA256 ??
        null,
    });
    const ort = await loadOnnxRuntime();
    log.info({ retinaPath, mfnPath }, "loading ONNX face models");
    const retinaFace = await ort.InferenceSession.create(retinaPath);
    const mobileFaceNet = await ort.InferenceSession.create(mfnPath);
    singleton = {
      retinaFace,
      mobileFaceNet,
      paths: { retinaFace: retinaPath, mobileFaceNet: mfnPath },
    };
    log.info("ONNX face models ready");
    return singleton;
  })();

  try {
    return await loadPromise;
  } catch (err) {
    // Reset on failure so a subsequent call retries (e.g. operator drops
    // the file in after the first boot attempt).
    loadPromise = null;
    singleton = null;
    throw err;
  }
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
  log.info({ url: opts.url, target }, "downloading face model");
  const res = await fetch(opts.url);
  if (!res.ok) {
    throw new Error(
      `Failed to download face model from ${opts.url}: HTTP ${res.status}`,
    );
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (opts.sha256 && opts.sha256.length > 0) {
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual.toLowerCase() !== opts.sha256.toLowerCase()) {
      throw new Error(
        `SHA256 mismatch for ${opts.basename}: expected ${opts.sha256}, got ${actual}`,
      );
    }
  }
  mkdirSync(dirname(target), { recursive: true });
  await writeFile(target, bytes);
  log.info({ target, bytes: bytes.length }, "face model downloaded");
  return target;
}

/** Lazy-import `onnxruntime-node`. Kept dynamic so the API process can
 * boot (and tests can run) without the package installed — only the
 * face worker hitting the real model-load path needs it. */
async function loadOnnxRuntime(): Promise<{
  InferenceSession: { create(path: string): Promise<OnnxSessionLike> };
}> {
  try {
    // Lazy-imported so the typecheck doesn't require the dep on machines
    // where the face worker isn't enabled. Bun resolves this at call time.
    // @ts-expect-error optional dep — only present when the operator opts in
    const mod = (await import("onnxruntime-node")) as unknown as {
      InferenceSession: { create(path: string): Promise<OnnxSessionLike> };
    };
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

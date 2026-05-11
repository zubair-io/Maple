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
 *   2. DB row from /settings/enrichment OR `MAPLE_FACE_*_URL` env var is
 *      set — download once into the model dir, verify the SHA256, then
 *      use it.
 *   3. Zero-config fallback: download InsightFace's `buffalo_s.zip` from
 *      its public GitHub Release, extract the two files. Suppress with
 *      `MAPLE_FACE_NO_AUTO_DOWNLOAD=true` to force step 1 or 2.
 *
 * Test override: `setFaceModelLoaderForTests(loader)` lets the worker tests
 * inject a fake session pair without touching disk or `onnxruntime-node`.
 *
 * Spec: `docs/indexer-enrichment.md` §6 ("Face worker").
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
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
  new (
    type: "float32",
    data: Float32Array,
    dims: readonly number[],
  ): OnnxTensorLike;
}

/** Loaded model pair handed to the face detector. */
export interface FaceModels {
  retinaFace: OnnxSessionLike;
  mobileFaceNet: OnnxSessionLike;
  /** ORT Tensor constructor — surfaced through the loader so callers don't
   * have to import `onnxruntime-node` directly (keeps the dep optional). */
  Tensor: OnnxTensorConstructor;
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
  liveStatus = { kind: "idle" };
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

// ── Live status surface ────────────────────────────────────────────────
// Module-level state the route handler reads to power the UI badge on
// /settings/enrichment. Updated by `loadFaceModels()` at every state
// transition so the operator can see whether a download is in flight,
// whether the load succeeded, or what failed.

export type FaceModelsLoadStatus =
  | "idle"        // loadFaceModels has not been called this process
  | "downloading" // buffalo_s default bundle is being fetched
  | "loaded"      // ONNX sessions are live
  | "error";      // last load attempt failed

interface InternalStatus {
  kind: FaceModelsLoadStatus;
  errorDetail?: string;
}

let liveStatus: InternalStatus = { kind: "idle" };

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
  retinaface: { path: string; present: boolean; bytes: number };
  mobilefacenet: { path: string; present: boolean; bytes: number };
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
    retinaface: probe(RETINAFACE_BASENAME),
    mobilefacenet: probe(MOBILEFACENET_BASENAME),
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
      liveStatus = { kind: "loaded" };
      return m;
    }
    const dir = config.modelDir ?? defaultModelDir();
    mkdirSync(dir, { recursive: true });

    // Zero-config bootstrap: if neither model file exists on disk AND
    // neither has a configured URL, fetch + extract the InsightFace
    // buffalo_s bundle from its public GitHub Release. This is the
    // "personal install, just works at boot" path. Operator can disable
    // by setting `MAPLE_FACE_NO_AUTO_DOWNLOAD=true`, or override with
    // their own URLs to skip this branch.
    if (
      process.env.MAPLE_FACE_NO_AUTO_DOWNLOAD !== "true" &&
      !existsSync(join(dir, RETINAFACE_BASENAME)) &&
      !existsSync(join(dir, MOBILEFACENET_BASENAME)) &&
      !(config.retinafaceUrl ?? process.env.MAPLE_FACE_RETINAFACE_URL) &&
      !(config.mobilefacenetUrl ?? process.env.MAPLE_FACE_MOBILEFACENET_URL)
    ) {
      liveStatus = { kind: "downloading" };
      await downloadBuffaloSDefault(dir);
    }

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
      Tensor: ort.Tensor,
      paths: { retinaFace: retinaPath, mobileFaceNet: mfnPath },
    };
    liveStatus = { kind: "loaded" };
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
    liveStatus = {
      kind: "error",
      errorDetail: err instanceof Error ? err.message : String(err),
    };
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
  Tensor: OnnxTensorConstructor;
}> {
  try {
    // Lazy-imported so the typecheck doesn't require the dep on machines
    // where the face worker isn't enabled. Bun resolves this at call time.
    const mod = (await import("onnxruntime-node")) as unknown as {
      InferenceSession: { create(path: string): Promise<OnnxSessionLike> };
      Tensor: OnnxTensorConstructor;
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

// ─── buffalo_s zero-config bootstrap ────────────────────────────────────────
//
// `loadFaceModels()` calls this when neither model file is on disk and
// neither URL is configured. It downloads the InsightFace `buffalo_s`
// release zip (the project's official small-model bundle) and extracts
// the two ONNX files we need into the model dir.
//
// Why this URL: InsightFace's GitHub Releases are the canonical source
// for the `buffalo_*` bundles. The `v0.7` release is the long-standing
// host for `buffalo_s.zip`; if the project ever rotates it, the download
// fails with a clear error and the operator falls back to the configured
// URL fields on /settings/enrichment or drops the files at
// `<modelDir>/{retinaface,mobilefacenet}.onnx` manually.
//
// Why shell out to `unzip`: avoids pulling a JS unzip dep just for one
// boot-time path. `unzip` is preinstalled on every mainstream Linux
// distro and the official Bun Docker image. If it's missing, the error
// is clearly actionable (`apt install unzip`).

const DEFAULT_BUFFALO_S_URL =
  "https://github.com/deepinsight/insightface/releases/download/v0.7/buffalo_s.zip";

/** Member names inside `buffalo_s.zip` (paths the InsightFace bundle uses). */
const BUFFALO_S_DET_MEMBER = "det_500m.onnx";
const BUFFALO_S_REC_MEMBER = "w600k_mbf.onnx";

async function downloadBuffaloSDefault(dir: string): Promise<void> {
  log.info(
    { url: DEFAULT_BUFFALO_S_URL, dir },
    "no face models on disk and no URL configured — downloading buffalo_s default bundle",
  );

  // Fetch the zip once.
  const res = await fetch(DEFAULT_BUFFALO_S_URL);
  if (!res.ok) {
    throw new Error(
      `Failed to fetch buffalo_s default bundle from ${DEFAULT_BUFFALO_S_URL}: HTTP ${res.status}. ` +
        `Either set MAPLE_FACE_RETINAFACE_URL / MAPLE_FACE_MOBILEFACENET_URL, ` +
        `or drop the model files at ${join(dir, RETINAFACE_BASENAME)} and ${join(dir, MOBILEFACENET_BASENAME)}.`,
    );
  }
  const zipBytes = new Uint8Array(await res.arrayBuffer());
  const zipPath = join(dir, "_buffalo_s.zip");
  await writeFile(zipPath, zipBytes);
  log.info(
    { zipPath, bytes: zipBytes.length },
    "buffalo_s downloaded; extracting",
  );

  // Extract into a staging dir so we can find the two files regardless
  // of whether the zip places them at the root or under `buffalo_s/`.
  const stagingDir = join(dir, "_buffalo_s_extract");
  rmSync(stagingDir, { recursive: true, force: true });
  mkdirSync(stagingDir, { recursive: true });
  try {
    await execFileAsync("unzip", ["-o", "-q", zipPath, "-d", stagingDir]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Failed to extract buffalo_s.zip (${msg}). Install unzip (\`apt install unzip\`) ` +
        `or drop the model files at ${join(dir, RETINAFACE_BASENAME)} and ${join(dir, MOBILEFACENET_BASENAME)} manually.`,
    );
  }

  const findMember = (member: string): string => {
    for (const candidate of [
      join(stagingDir, member),
      join(stagingDir, "buffalo_s", member),
    ]) {
      if (existsSync(candidate)) return candidate;
    }
    throw new Error(
      `buffalo_s.zip did not contain ${member} — InsightFace may have rotated the bundle. ` +
        `Set MAPLE_FACE_RETINAFACE_URL / MAPLE_FACE_MOBILEFACENET_URL with explicit URLs.`,
    );
  };

  copyFileSync(
    findMember(BUFFALO_S_DET_MEMBER),
    join(dir, RETINAFACE_BASENAME),
  );
  copyFileSync(
    findMember(BUFFALO_S_REC_MEMBER),
    join(dir, MOBILEFACENET_BASENAME),
  );

  // Cleanup so we don't leave the zip + extraction droppings under the
  // model dir (would survive container rebuilds via the volume mount).
  rmSync(zipPath, { force: true });
  rmSync(stagingDir, { recursive: true, force: true });

  log.info(
    {
      retina: join(dir, RETINAFACE_BASENAME),
      mfn: join(dir, MOBILEFACENET_BASENAME),
    },
    "buffalo_s default bundle extracted",
  );
}

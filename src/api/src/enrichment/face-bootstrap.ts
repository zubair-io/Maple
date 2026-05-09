/**
 * Face-worker bootstrap. Owns the env+DB-driven on/off switch and the
 * singleton instance. Imported by `src/index.ts` after the DB connection
 * is up, alongside the geocode-worker bootstrap.
 *
 * Behaviour:
 *
 *   - Worker disabled (DB row says false, or `MAPLE_FACE_WORKER_ENABLED`
 *     is unset / != "true") → no-op. Default off because the worker
 *     needs ONNX models on disk; opt-in keeps fresh installs from
 *     loud-logging "models missing" on every boot.
 *
 *   - Worker enabled but model load fails (file missing AND no download
 *     URL) → log loud and leave the worker dormant. Do NOT crash the
 *     API. The operator fixes via:
 *       (a) dropping the file at `<MAPLE_MODEL_DIR>/<basename>`, or
 *       (b) setting `MAPLE_FACE_RETINAFACE_URL` /
 *           `MAPLE_FACE_MOBILEFACENET_URL` and restarting.
 *
 *   - Worker enabled and models load → start the loop.
 *
 * The DB-backed `app_settings.enrichment` row overrides the env vars at
 * boot, and `applyEnrichmentConfigFace()` re-applies live when the
 * operator edits settings via the UI. Env stays as fallback so existing
 * deploys don't break.
 *
 * Spec: `docs/indexer-enrichment.md` §6.
 */

import { child as childLogger } from "../log.ts";
import { loadFaceModels } from "./face-models.ts";

const log = childLogger("face");

/**
 * Face lifecycle bootstrap — Plan 3 cutover.
 *
 * The bespoke FaceWorker class has been retired (face-worker.ts deleted).
 * Face detection is now handled by the unified stage-controller runtime
 * (src/api/src/workers/stages/face.ts). This bootstrap retains the model-
 * preload side-effect so the ONNX session is warm before the first claim
 * arrives. The start/stop interface is kept so index.ts doesn't need editing.
 */

/** Attempt to preload the face ONNX models so they are warm on first claim.
 * Never throws — a missing model is a non-fatal warning; the stage handler
 * will encounter the error on first inference and dead-letter that asset. */
export async function startFaceWorker(): Promise<null> {
  try {
    await loadFaceModels();
    log.info("face models loaded (stage controller will handle detection)");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(
      { err: msg },
      "face model preload failed; first inference will attempt load. Fix via /settings/enrichment.",
    );
  }
  return null;
}

/** No-op — lifecycle now owned by the stage controller runtime. */
export async function stopFaceWorker(): Promise<void> {
  // Nothing to do — the stage controller shuts down on SIGTERM.
}

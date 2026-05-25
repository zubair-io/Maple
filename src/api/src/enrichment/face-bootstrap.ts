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
 *     loud-logging "models missing" on every boot. Sets worker_config.paused=true
 *     so the stage controller reflects the disabled state.
 *
 *   - Worker enabled but model load fails (file missing AND no download
 *     URL) → log loud and leave the worker dormant. Do NOT crash the
 *     API. The operator fixes via:
 *       (a) dropping the file at `<MAPLE_MODEL_DIR>/<basename>`, or
 *       (b) setting `MAPLE_FACE_DETECTOR_URL` /
 *           `MAPLE_FACE_RECOGNIZER_URL` and restarting. The legacy
 *           `MAPLE_FACE_RETINAFACE_URL` / `MAPLE_FACE_MOBILEFACENET_URL`
 *           env vars are still honoured (deprecation-warned at boot).
 *
 *   - Worker enabled and models load → start the loop. Sets
 *     worker_config.paused=false so the stage controller unblocks.
 *
 * The DB-backed `app_settings.enrichment` row overrides the env vars at
 * boot, and `applyEnrichmentConfigFace()` re-applies live when the
 * operator edits settings via the UI. Env stays as fallback so existing
 * deploys don't break.
 *
 * Spec: `docs/indexer-enrichment.md` §6.
 */

import { child as childLogger } from '../log.ts';
import { loadEnrichmentConfig, resolveEnrichmentConfig } from './enrichment-config.repo.ts';
import { loadFaceModels } from './face-models.ts';
import { workerConfigCollection } from '../db/client.ts';

const log = childLogger('face');

/**
 * Propagate the paused state for a stage into the worker_config collection.
 * Uses upsert so it's safe to call before any stage has been seeded.
 */
async function applyPausedToWorkerConfig(name: string, paused: boolean): Promise<void> {
  try {
    const coll = await workerConfigCollection();
    await coll.updateOne(
      { name },
      { $set: { paused }, $setOnInsert: { name } as never },
      { upsert: true },
    );
  } catch (err) {
    // Non-fatal — log and continue. The stage controller will fall back to
    // the stage's built-in defaults if the DB write fails.
    const msg = err instanceof Error ? err.message : String(err);
    log.warn({ err: msg, name }, 'failed to write paused state to worker_config');
  }
}

/**
 * Face lifecycle bootstrap — Plan 3 cutover.
 *
 * The bespoke FaceWorker class has been retired (face-worker.ts deleted).
 * Face detection is now handled by the unified stage-controller runtime
 * (src/api/src/workers/stages/face-detect.ts + face-embed.ts). This
 * bootstrap retains the model-
 * preload side-effect so the ONNX session is warm before the first claim
 * arrives. The start/stop interface is kept so index.ts doesn't need editing.
 */

/** Attempt to preload the face ONNX models so they are warm on first claim.
 * Never throws — a missing model is a non-fatal warning; the stage handler
 * will encounter the error on first inference and dead-letter that asset. */
export async function startFaceWorker(): Promise<null> {
  const dbConfig = await loadEnrichmentConfig();
  const resolved = resolveEnrichmentConfig(dbConfig);

  if (!resolved.face_worker_enabled) {
    log.info('face_bootstrap: face_worker_enabled=false; skipping model preload');
    await applyPausedToWorkerConfig('face', true);
    return null;
  }

  try {
    await loadFaceModels({
      modelDir: resolved.face_model_dir,
      detectorUrl: resolved.face_detector_url,
      detectorSha256: resolved.face_detector_sha256,
      recognizerUrl: resolved.face_recognizer_url,
      recognizerSha256: resolved.face_recognizer_sha256,
    });
    log.info('face models loaded (stage controller will handle detection)');
    await applyPausedToWorkerConfig('face', false);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(
      { err: msg },
      'face model preload failed; first inference will attempt load. Fix via /settings/enrichment.',
    );
  }
  return null;
}

/** No-op — lifecycle now owned by the stage controller runtime. */
export async function stopFaceWorker(): Promise<void> {
  // Nothing to do — the stage controller shuts down on SIGTERM.
}

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
import { loadEnrichmentConfig } from './enrichment-config.repo.ts';
import {
  resolveEnrichmentConfig,
  type ResolvedEnrichmentConfig,
} from './enrichment-config.resolve.ts';
import { preloadFaceModelsOffThread } from './face-pool.ts';
import { workerConfigCollection } from '../db/client.ts';

const log = childLogger('face');

/**
 * The worker_config stage keys the face pipeline now runs as. The monolithic
 * `face` stage was split into a detection stage and an embedding stage
 * (see `workers/stages/manifest.ts`), so the enrichment on/off toggle must
 * pause/unpause BOTH — pausing only the legacy `face` key would leave the
 * split stages running (or stuck) regardless of the toggle.
 */
export const FACE_STAGE_NAMES = ['face-detect', 'face-embed'] as const;

/** Apply the paused state to every stage in the split face pipeline. */
async function applyPausedToFaceStages(paused: boolean): Promise<void> {
  try {
    const coll = await workerConfigCollection();
    await Promise.all(
      FACE_STAGE_NAMES.map(async (name) => {
        try {
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
      }),
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn({ err: msg }, 'failed to access worker_config collection');
  }
}

/**
 * Face lifecycle bootstrap — Plan 3 cutover.
 *
 * The bespoke FaceWorker class has been retired (face-worker.ts deleted).
 * Face detection is now handled by the unified stage-controller runtime
 * (src/api/src/workers/stages/face-detect.ts + face-embed.ts). This
 * bootstrap retains the model-preload side-effect so the ONNX session is warm
 * before the first claim arrives. The start/stop interface is kept so
 * index.ts doesn't need editing.
 *
 * The preload now runs INSIDE the face worker thread (#707): the ONNX
 * sessions live on the worker, so warming them on the main thread would
 * double-load ~hundreds of MB. `preloadFaceModelsOffThread` posts the load to
 * the worker, which relays its status back so the /settings/enrichment badge
 * (`getFaceModelsStatus`) stays accurate. If no Worker can spawn, the pool
 * degrades to an in-process preload — same warm-on-boot behaviour, on the main
 * thread.
 */

/** Attempt to preload the face ONNX models so they are warm on first claim.
 * Never throws — a missing model is a non-fatal warning; the stage handler
 * will encounter the error on first inference and dead-letter that asset. */
export async function startFaceWorker(): Promise<null> {
  // `loadEnrichmentConfig` reads the DB-backed enrichment row; `resolveEnrichmentConfig`
  // folds it together with env fallbacks. Both can throw — `loadEnrichmentConfig` if Mongo
  // is unreachable mid-boot (it guards internally today, but that's an implementation
  // detail this contract must not depend on), and `resolveEnrichmentConfig` on a malformed
  // config. This function is documented "Never throws", and the `index.ts` call site treats
  // a face bootstrap failure as isolated/non-fatal (log + continue). Catch here, log, and
  // leave the worker disabled by returning — identical to how the preload path below logs
  // and falls through on failure. Don't coerce the error into `null` and continue:
  // `resolveEnrichmentConfig(null)` is the legitimate "no DB row, use env" path, so feeding
  // a Mongo-down boot into it could route an env-enabled preload; a throw means "leave
  // disabled and return."
  let resolved: ResolvedEnrichmentConfig;
  try {
    resolved = resolveEnrichmentConfig(await loadEnrichmentConfig());
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'face_bootstrap: failed to load enrichment config; leaving face worker disabled. Fix via /settings/enrichment.',
    );
    return null;
  }

  if (!resolved.face_worker_enabled) {
    log.info('face_bootstrap: face_worker_enabled=false; skipping model preload');
    await applyPausedToFaceStages(true);
    return null;
  }

  // `preloadFaceModelsOffThread` resolves false on a model-load failure
  // (missing file + no URL, download error, …), but it can still REJECT on a
  // transport-level fault — a worker that crashes on spawn, or a
  // response/pending kind mismatch (see `face-pool.ts`). This function is
  // documented "Never throws", and the call site in `index.ts` treats a face
  // preload failure as isolated/non-fatal (log + continue), so a reject must
  // not bubble out of bootstrap. Catch it, log, and fall through to the
  // failure branch below — identical to the pre-#707 main-thread preload,
  // which only ever logged on failure.
  let ok = false;
  try {
    ok = await preloadFaceModelsOffThread({
      modelDir: resolved.face_model_dir,
      detectorUrl: resolved.face_detector_url,
      detectorSha256: resolved.face_detector_sha256,
      recognizerUrl: resolved.face_recognizer_url,
      recognizerSha256: resolved.face_recognizer_sha256,
    });
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'face model preload threw; first inference will retry. Fix via /settings/enrichment.',
    );
  }

  if (ok) {
    log.info('face models loaded in worker (stage controller will handle detection)');
    await applyPausedToFaceStages(false);
  } else {
    // Preload failed (missing model + no URL, download error, …). Don't touch
    // the paused state — a fresh install is already paused via
    // `pausedOnFirstBoot`, and re-pausing here would fight an operator who
    // manually unpaused. The first inference will retry the load and surface
    // the real error to the operator via the /settings/enrichment badge. This
    // mirrors the pre-#707 behaviour (the old main-thread preload only logged
    // on failure).
    log.warn(
      'face model preload failed; first inference will attempt load. Fix via /settings/enrichment.',
    );
  }
  return null;
}

/** No-op — lifecycle now owned by the stage controller runtime. */
export async function stopFaceWorker(): Promise<void> {
  // Nothing to do — the stage controller shuts down on SIGTERM.
}

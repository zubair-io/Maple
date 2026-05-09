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
import {
  loadEnrichmentConfig,
  resolveEnrichmentConfig,
  type ResolvedEnrichmentConfig,
} from "./enrichment-config.repo.ts";
import { loadFaceModels } from "./face-models.ts";
import { FaceWorker } from "./face-worker.ts";

const log = childLogger("face");

let singleton: FaceWorker | null = null;
/** Last-known reason the worker is dormant. Surfaced by the status route /
 * UI banner so the operator knows what to fix. `null` = worker is running
 * (or intentionally disabled). */
let dormantReason: string | null = null;

/**
 * Build the worker, attempt the model load, and start the loop.
 *
 * Reads the resolved config (DB → env → defaults). NEVER throws on a
 * model-load failure — the worker is left dormant with `dormantReason`
 * set so the API stays up. Returns the worker instance when started, or
 * `null` when it's disabled or dormant.
 */
export async function startFaceWorker(): Promise<FaceWorker | null> {
  const dbConfig = await loadEnrichmentConfig();
  const resolved = resolveEnrichmentConfig(dbConfig);
  await applyResolved(resolved);
  return singleton;
}

/**
 * Re-apply settings after the operator changes them via the UI. The
 * function compares the new config against the running worker and:
 *   - stops the worker when `face_worker_enabled` flips false
 *   - starts a fresh worker when it flips true (and re-attempts the
 *     model load — fixing the URL via the UI lets the operator recover
 *     from a dormant boot without an API restart)
 */
export async function applyEnrichmentConfigFace(
  resolved: ResolvedEnrichmentConfig,
): Promise<void> {
  await applyResolved(resolved);
}

/** Graceful shutdown — called from the SIGTERM handler. */
export async function stopFaceWorker(): Promise<void> {
  if (!singleton) return;
  log.info("worker stopping");
  await singleton.shutdown();
  singleton = null;
  log.info("worker stopped");
}

/** Why the worker isn't running, if it isn't. UI / status routes read this
 * to render the "models missing" banner. `null` means everything's fine. */
export function faceWorkerDormantReason(): string | null {
  return dormantReason;
}

/** Test-only: peek at the singleton without spawning one. */
export function _getWorkerForTests(): FaceWorker | null {
  return singleton;
}

/** Internal: shared boot + reapply path. */
async function applyResolved(
  resolved: ResolvedEnrichmentConfig,
): Promise<void> {
  if (!resolved.face_worker_enabled) {
    if (singleton) {
      log.info("stopping worker after config change (disabled)");
      await singleton.shutdown();
      singleton = null;
    } else {
      log.info("face worker disabled (face_worker_enabled=false)");
    }
    dormantReason = null; // Intentionally off, not dormant.
    return;
  }

  // Enabled — try to load models. A failure leaves the worker dormant
  // but doesn't take the API down; operator can recover by setting the
  // download URL or dropping the model file in.
  try {
    await loadFaceModels();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(
      { err: msg },
      "face worker is enabled but model load failed; worker will not start. Fix via /settings/enrichment or set MAPLE_FACE_RETINAFACE_URL / MAPLE_FACE_MOBILEFACENET_URL.",
    );
    dormantReason = msg;
    if (singleton) {
      // The previous worker had working models — keep it running. We don't
      // get here because of a per-call detector failure; this only runs
      // when models couldn't be loaded at all. Defensive nonetheless.
      return;
    }
    return;
  }

  if (singleton) {
    log.info("worker already running; no restart needed");
    dormantReason = null;
    return;
  }

  const worker = new FaceWorker();
  worker.start();
  singleton = worker;
  dormantReason = null;
  log.info("worker started");
}

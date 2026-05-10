/**
 * OCR-engine bootstrap. Manages the Tesseract engine lifecycle.
 *
 * The bespoke OcrWorker has been retired (Plan 3). The stage-controller
 * runtime (`src/api/src/workers/`) now handles claim/lease/retry/dead-letter.
 * This module is retained only to own engine teardown on SIGTERM so a
 * running Tesseract scheduler is torn down cleanly on shutdown.
 *
 * `stopOcrWorker` is kept for backwards-compat with the SIGTERM handler in
 * `index.ts` — it now only tears down the engine, not a worker loop.
 */

import { child as childLogger } from "../log.ts";
import {
  loadEnrichmentConfig,
  resolveEnrichmentConfig,
  type ResolvedEnrichmentConfig,
} from "./enrichment-config.repo.ts";
import { resetOcrEngine } from "./ocr-engine.ts";
import { workerConfigCollection } from "../db/client.ts";

const log = childLogger("ocr");

/**
 * Propagate the paused state for a stage into the worker_config collection.
 * Uses upsert so it's safe to call before any stage has been seeded.
 */
async function applyPausedToWorkerConfig(name: string, paused: boolean): Promise<void> {
  try {
    const coll = await workerConfigCollection();
    await coll.updateOne({ name }, { $set: { paused }, $setOnInsert: { name } as never }, { upsert: true });
  } catch (err) {
    // Non-fatal — log and continue. The stage controller will fall back to
    // the stage's built-in defaults if the DB write fails.
    const msg = err instanceof Error ? err.message : String(err);
    log.warn({ err: msg, name }, "failed to write paused state to worker_config");
  }
}

/** No-op: the stage-controller runtime owns worker lifecycle. Retained for
 * backwards-compat with the bootstrap sequence in `index.ts`. */
export async function startOcrWorker(): Promise<null> {
  const dbConfig = await loadEnrichmentConfig();
  const resolved = resolveEnrichmentConfig(dbConfig);
  const paused = !resolved.ocr_worker_enabled;
  await applyPausedToWorkerConfig("ocr", paused);
  log.info(
    `ocr_bootstrap: ocr_worker_enabled=${resolved.ocr_worker_enabled}; worker_config.ocr.paused=${paused}`,
  );
  return null;
}

/** Re-apply settings after the operator changes them via the UI. No-op now
 * that the bespoke worker is retired; retained for call-site compat. */
export async function applyOcrConfig(
  _resolved: ResolvedEnrichmentConfig,
): Promise<void> {
  // Stage-controller runtime reads worker_config from DB; no action needed here.
}

/** Graceful shutdown — called from the SIGTERM handler. Tears down the
 * Tesseract scheduler so the process can exit cleanly. */
export async function stopOcrWorker(): Promise<void> {
  await resetOcrEngine();
  log.info("ocr engine torn down");
}

/** Test-only: returns null (no bespoke worker singleton). */
export function _getOcrWorkerForTests(): null {
  return null;
}

/**
 * OCR-worker bootstrap. Mirrors `bootstrap.ts` (geocode worker):
 *
 *   - DB row's `ocr_worker_enabled` overrides the env var
 *     (`MAPLE_OCR_WORKER_ENABLED`).
 *   - Disabled by default — first use downloads tesseract traineddata
 *     and OCR is CPU-heavy, so operators must opt in.
 *   - `applyOcrConfig()` re-applies live so toggling via the settings
 *     UI doesn't require a restart.
 *   - `stopOcrWorker()` is wired into the SIGTERM handler so a
 *     running tesseract scheduler is torn down on shutdown.
 *
 * No health check — there's no upstream service to ping. The engine
 * lazy-loads on first claim, so an unreachable language file surfaces
 * the first time the worker actually picks up an asset rather than at
 * boot. (Per-asset failures dead-letter after maxAttempts.)
 */

import { child as childLogger } from "../log.ts";
import {
  loadEnrichmentConfig,
  resolveEnrichmentConfig,
  type ResolvedEnrichmentConfig,
} from "./enrichment-config.repo.ts";
import { OcrWorker } from "./ocr-worker.ts";
import { resetOcrEngine } from "./ocr-engine.ts";

const log = childLogger("ocr");

let singleton: OcrWorker | null = null;

/** Build the worker and start the loop when enabled. Returns the
 * running worker (or `null` when disabled). Does NOT throw — the OCR
 * stage is non-essential to the rest of the API. */
export async function startOcrWorker(): Promise<OcrWorker | null> {
  const dbConfig = await loadEnrichmentConfig();
  const resolved = resolveEnrichmentConfig(dbConfig);
  await applyResolved(resolved);
  return singleton;
}

/** Re-apply settings after the operator changes them via the UI. */
export async function applyOcrConfig(
  resolved: ResolvedEnrichmentConfig,
): Promise<void> {
  await applyResolved(resolved);
}

/** Graceful shutdown — called from the SIGTERM handler. Stops the
 * worker AND tears down the tesseract scheduler so the process can
 * exit cleanly. */
export async function stopOcrWorker(): Promise<void> {
  if (singleton) {
    log.info("worker stopping");
    await singleton.shutdown();
    singleton = null;
    log.info("worker stopped");
  }
  await resetOcrEngine();
}

async function applyResolved(
  resolved: ResolvedEnrichmentConfig,
): Promise<void> {
  if (!resolved.ocr_worker_enabled) {
    if (singleton) {
      log.info("stopping worker after config change");
      await singleton.shutdown();
      singleton = null;
      // Engine teardown happens lazily on idle — no need to force it
      // here, but doing so keeps "disabled" behaviour predictable.
      await resetOcrEngine();
    } else {
      log.info("worker disabled (ocr_worker_enabled=false)");
    }
    return;
  }
  if (singleton) {
    log.info("worker already running");
    return;
  }
  const worker = new OcrWorker();
  worker.start();
  singleton = worker;
  log.info("worker started");
}

/** Test-only: peek at the singleton without spawning one. */
export function _getOcrWorkerForTests(): OcrWorker | null {
  return singleton;
}

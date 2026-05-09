/**
 * Stage controller runtime.
 *
 * Imported by every stage child process (via the entry shim main.ts).
 * Handles: boot, version-bump reset, poll loop, worker pool, atomic writeback,
 * throughput rolling window, pause/resume, reload-config, and graceful drain on SIGTERM.
 *
 * This file is built incrementally across Tasks 4–8 of the plan.
 * The _test export is gated on process.env.MAPLE_TEST so production builds
 * include no test surface.
 */

import type { Collection } from "mongodb";
import { child as childLogger } from "../../log.ts";
import type { WorkerConfig } from "./define-stage.ts";
import type { ImageDoc, StageConfig } from "./define-stage.ts";
import type { WorkerConfigDoc } from "../worker-config.repo.ts";
import { WorkerConfigRepo } from "../worker-config.repo.ts";

// ---------------------------------------------------------------------------
// Boot: load or seed worker_config for this stage.
// ---------------------------------------------------------------------------

/**
 * Load the saved config for this stage from the worker_config collection.
 * If no document exists (first boot), seed from stage.defaults respecting
 * pausedOnFirstBoot. Returns the effective WorkerConfig.
 *
 * On re-boot, the saved document wins over defaults — operator changes persist.
 */
export async function bootConfig(
  stage: StageConfig,
  coll: Collection<WorkerConfigDoc>,
): Promise<WorkerConfig> {
  const repo = new WorkerConfigRepo(coll);
  const existing = await repo.load(stage.name);
  if (existing) return existing;

  // First boot: seed from defaults, respecting pausedOnFirstBoot.
  const initial: WorkerConfig = {
    concurrency: stage.defaults.concurrency,
    pollIntervalMs: stage.defaults.pollIntervalMs,
    batchSize: stage.defaults.batchSize,
    maxAttempts: stage.defaults.maxAttempts,
    paused: stage.defaults.pausedOnFirstBoot,
    last_seen_target_version: 0,
  };
  await repo.upsert(stage.name, initial);
  return initial;
}

// ---------------------------------------------------------------------------
// Version-bump reset: re-queue dead docs when targetVersion was bumped.
// ---------------------------------------------------------------------------

/**
 * If stage.targetVersion > lastSeenVersion, run an updateMany that resets
 * all docs at a lower version (including previously dead ones) so they become
 * eligible for the new version's claim query.
 *
 * Idempotent: if the API crashes between the updateMany and the config write,
 * the reset will run again on the next boot — harmless because the predicate
 * only matches docs whose version < targetVersion.
 */
export async function versionBumpReset(
  stage: StageConfig,
  lastSeenVersion: number,
  images: Collection<ImageDoc>,
): Promise<void> {
  if (stage.targetVersion <= lastSeenVersion) return;

  const stageKey = `stages.${stage.name}`;
  await images.updateMany(
    { [`${stageKey}.version`]: { $lt: stage.targetVersion } },
    {
      $set: {
        [`${stageKey}.dead`]: false,
        [`${stageKey}.attempts`]: 0,
        [`${stageKey}.last_error`]: null,
      },
    },
  );
}

// ---------------------------------------------------------------------------
// _test export — internal helpers exposed only in test mode.
// ---------------------------------------------------------------------------

export const _test =
  process.env.MAPLE_TEST === "1"
    ? { bootConfig, versionBumpReset }
    : (undefined as never);

// ---------------------------------------------------------------------------
// runStage — full entry point (implemented incrementally in Tasks 5–8).
// ---------------------------------------------------------------------------

/**
 * Main entry point called by the stage child's entry shim (main.ts).
 * Connects to Mongo, boots config, starts the poll loop, and handles
 * SIGTERM for graceful drain. Implemented fully in Tasks 5–8.
 */
export async function runStage(_stage: StageConfig): Promise<void> {
  // Placeholder: Tasks 5–8 implement the full poll loop inline below.
  throw new Error(
    "runStage is not yet fully implemented — see Tasks 5–8 of Plan 1",
  );
}

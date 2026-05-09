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

import type { Collection, Filter, ObjectId } from "mongodb";
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
// Claim query construction.
// ---------------------------------------------------------------------------

/**
 * Build the MongoDB filter that selects docs eligible for this stage:
 *   - stages.<name>.version < targetVersion (missing field treated as < any number)
 *   - stages.<name>.dead != true
 *   - For each dep: stages.<dep>.version >= 1
 *   - _id not in the current in-flight set
 */
export function buildClaimQuery(
  name: string,
  targetVersion: number,
  dependsOn: string[],
  inFlight: Set<ObjectId>,
): Filter<ImageDoc> {
  const filter: Filter<ImageDoc> = {
    [`stages.${name}.version`]: { $lt: targetVersion },
    [`stages.${name}.dead`]: { $ne: true },
  };
  for (const dep of dependsOn) {
    (filter as Record<string, unknown>)[`stages.${dep}.version`] = { $gte: 1 };
  }
  if (inFlight.size > 0) {
    (filter as Record<string, unknown>)["_id"] = {
      $nin: [...inFlight],
    };
  }
  return filter;
}

// ---------------------------------------------------------------------------
// Single poll tick: claim + dispatch + writeback.
// ---------------------------------------------------------------------------

/**
 * Run one poll tick: find eligible docs, dispatch each to the handler,
 * write back results. Used by the full poll loop and directly from tests.
 */
export async function runOnce(
  stage: StageConfig,
  config: WorkerConfig,
  images: Collection<ImageDoc>,
  _configColl: Collection<WorkerConfigDoc>,
): Promise<void> {
  if (config.paused) return;

  const inFlight = new Set<ObjectId>();
  const log = childLogger(`workers:${stage.name}`);
  const abortController = new AbortController();
  const ctx = { log, signal: abortController.signal };

  const query = buildClaimQuery(
    stage.name,
    stage.targetVersion,
    stage.dependsOn,
    inFlight,
  );

  const docs = await images
    .find(query)
    .limit(config.batchSize)
    .toArray();

  await Promise.all(
    docs.map(async (doc) => {
      const id = (doc as { _id: ObjectId })._id;
      inFlight.add(id);
      try {
        const result = await stage.handler(doc, ctx);
        const stageState = {
          version: stage.targetVersion,
          attempts: 0,
          last_error: null,
          processed_at: new Date(),
          dead: false,
        };

        if ("patch" in result) {
          const forbiddenKeys = Object.keys(result.patch).filter((k) =>
            k.startsWith("stages."),
          );
          if (forbiddenKeys.length > 0) {
            throw new Error(
              `Handler returned patch with forbidden stage keys: ${forbiddenKeys.join(", ")}`,
            );
          }
          await images.updateOne(
            { _id: id },
            {
              $set: {
                [`stages.${stage.name}`]: stageState,
                ...result.patch,
              },
            },
          );
        } else if ("wrote" in result) {
          await images.updateOne(
            { _id: id },
            { $set: { [`stages.${stage.name}`]: stageState } },
          );
        } else if ("skip" in result) {
          await images.updateOne(
            { _id: id },
            {
              $set: {
                [`stages.${stage.name}`]: {
                  ...stageState,
                  last_error: `skip: ${result.skip}`,
                },
              },
            },
          );
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const current = await images.findOne(
          { _id: id },
          { projection: { [`stages.${stage.name}`]: 1 } },
        );
        const currentAttempts =
          (current?.stages?.[stage.name]?.attempts ?? 0) + 1;
        const dead = currentAttempts >= config.maxAttempts;
        await images.updateOne(
          { _id: id },
          {
            $set: {
              [`stages.${stage.name}.attempts`]: currentAttempts,
              [`stages.${stage.name}.last_error`]: msg,
              [`stages.${stage.name}.dead`]: dead,
            },
          },
        );
      } finally {
        inFlight.delete(id);
      }
    }),
  );
}

// ---------------------------------------------------------------------------
// _test export — internal helpers exposed only in test mode.
// ---------------------------------------------------------------------------

export const _test =
  process.env.MAPLE_TEST === "1"
    ? { bootConfig, versionBumpReset, runOnce }
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

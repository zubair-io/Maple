/**
 * Canonical types for the stage-controller worker system.
 *
 * These names are used verbatim across Plans 1–4. Do not rename them.
 *
 * - StageState     : per-stage subdocument on each image doc (stages.<name>)
 * - WorkerConfig   : operator-tunable config stored in worker_config collection
 * - StageResult    : the three return shapes a handler can emit
 * - StageConfig    : the config + handler object a stage file exports
 * - StageContext   : dependencies injected into every handler call
 *
 * defineStage() is a zero-cost identity helper that provides type inference
 * for the generic TPatch parameter so handler return types are checked
 * against the patch shape without verbose type annotations at call sites.
 */

import type { Logger } from "pino";
import type { IndexerAssetDoc } from "../../indexer/images.repo.ts";

// ---------------------------------------------------------------------------
// ImageDoc — the asset document type visible to stage handlers.
// Extends IndexerAssetDoc with the new stages subdocument.
// ---------------------------------------------------------------------------

export interface StageState {
  /** Last version the handler ran at. 0 = never run. */
  version: number;
  /** Failed attempts at the current target version. Resets on success or version bump. */
  attempts: number;
  /** Stringified error from the most recent failed attempt. */
  last_error: string | null;
  /** Wall-clock time of the most recent successful run. */
  processed_at: Date | null;
  /** True when attempts >= maxAttempts. Excluded from the claim query. */
  dead: boolean;
}

export type ImageDoc = IndexerAssetDoc & {
  stages?: Record<string, StageState>;
};

// ---------------------------------------------------------------------------
// WorkerConfig — operator-tunable config stored in worker_config collection.
// ---------------------------------------------------------------------------

export interface WorkerConfig {
  concurrency: number;
  pollIntervalMs: number;
  batchSize: number;
  maxAttempts: number;
  paused: boolean;
  /**
   * The last targetVersion this controller has seen. Compared against
   * StageConfig.targetVersion on boot to detect version bumps that require
   * a dead-doc reset.
   */
  last_seen_target_version: number;
}

// ---------------------------------------------------------------------------
// StageResult — three return shapes a handler can emit.
// ---------------------------------------------------------------------------

export type StageResult<TPatch = Record<string, unknown>> =
  | { patch: TPatch }
  | { wrote: true }
  | { skip: string };

// ---------------------------------------------------------------------------
// StageContext — dependencies injected into every handler call.
// ---------------------------------------------------------------------------

export interface StageContext {
  /** Child logger pre-tagged with { controller: stageName }. */
  log: Logger;
  /** Canceled on graceful shutdown (SIGTERM received). */
  signal: AbortSignal;
}

// ---------------------------------------------------------------------------
// StageConfig — the full config + handler object a stage file exports.
// ---------------------------------------------------------------------------

/**
 * A dependency entry in `StageConfig.dependsOn`.
 *
 * Bare string `"exif"` is shorthand for `{ name: "exif", minVersion: 1 }` —
 * the dep just needs to have run at least once. Use the object form when a
 * stage depends on a specific dep version (e.g. geocode requires exif v2 so
 * it never reads pre-fix western-hemisphere coords).
 */
export type StageDep = string | { name: string; minVersion: number };

export interface StageConfig<TPatch = Record<string, unknown>> {
  name: string;
  /**
   * Bumping this number on deploy triggers a dead-doc reset on boot and
   * re-queues all docs at the lower version. This is the entire backfill
   * mechanism — no separate backfill job is needed.
   */
  targetVersion: number;
  /**
   * Stages whose version must reach a minimum before this stage's claim
   * query matches a doc. Expressed as field-level predicates in the claim
   * query: { "stages.<dep>.version": { $gte: minVersion } }
   *
   * String entries default to minVersion: 1 (dep just needs to have run).
   */
  dependsOn: StageDep[];
  defaults: WorkerConfig & {
    /**
     * When worker_config[name] does not yet exist, write this as the initial
     * paused state. On subsequent boots, the saved paused value is authoritative.
     * Set true for paid/rate-limited stages (describe, geocode) so they don't
     * run until the operator configures credentials and unpauses them.
     */
    pausedOnFirstBoot: boolean;
  };
  handler: (image: ImageDoc, ctx: StageContext) => Promise<StageResult<TPatch>>;
}

// ---------------------------------------------------------------------------
// defineStage — identity helper providing TPatch inference.
// ---------------------------------------------------------------------------

/**
 * Zero-cost identity function. Call it in every stage file so TypeScript
 * infers the correct TPatch for the handler's return type.
 *
 * Example:
 *   export default defineStage({
 *     name: "exif",
 *     targetVersion: 1,
 *     dependsOn: ["hash"],
 *     defaults: { concurrency: 4, pollIntervalMs: 1000, batchSize: 10,
 *                 maxAttempts: 5, paused: false, pausedOnFirstBoot: false },
 *     handler: async (image, ctx) => {
 *       const exif = await readExif(image.abs_path);
 *       return { patch: { exif } };
 *     },
 *   });
 */
export function defineStage<TPatch = Record<string, unknown>>(
  config: StageConfig<TPatch>,
): StageConfig<TPatch> {
  return config;
}

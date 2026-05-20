/**
 * In-process stage runner.
 *
 * Replaces the deleted multi-process supervisor (`supervisor.ts`,
 * `runtime/main.ts`, `runtime/run-stage.ts`, `runtime/define-stage.ts`) — see
 * issue #135. Each stage file (`stages/<name>.ts`) exports a thin
 * `start<Name>Stage()` async function that just calls `runStage(config)`; this
 * module owns the poll loop, claim query, worker-pool dispatch, atomic
 * writeback, retry/dead-letter bookkeeping, throughput counter, and the
 * pause-via-config path.
 *
 * No child processes, no IPC: everything runs in the API server process.
 * Pause/resume is implemented as "write `paused: true` to the worker_config
 * Mongo doc; the running loop notices on its next tick (≤ pollIntervalMs)".
 *
 * Status / control surface is published into the in-process `stageRegistry`
 * (see `./registry.ts`) so `routes.ts` and `events.ts` can read live state.
 */

import type { Collection, Filter, ObjectId } from "mongodb";
import type { Logger } from "pino";
import { child as childLogger } from "../log.ts";
import type { IndexerAssetDoc } from "../indexer/images.repo.ts";
import { WorkerConfigRepo, type WorkerConfigDoc } from "./worker-config.repo.ts";
import { recordAndPublishAssetChange } from "../db/changes.repo.ts";
import { stageRegistry } from "./registry.ts";

// ---------------------------------------------------------------------------
// Public types — load-bearing for every stage file and stage test.
// ---------------------------------------------------------------------------

export interface StageState {
  /** Last version the handler ran at. 0 = never run. */
  version: number;
  /** Failed attempts at the current target version. Resets on success / bump. */
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

export interface WorkerConfig {
  concurrency: number;
  pollIntervalMs: number;
  batchSize: number;
  maxAttempts: number;
  paused: boolean;
  /**
   * Last targetVersion the runner has seen. Compared against
   * StageConfig.targetVersion on boot to detect version bumps that
   * require a dead-doc reset.
   */
  last_seen_target_version: number;
}

export type StageResult<TPatch = Record<string, unknown>> =
  | { patch: TPatch }
  | { wrote: true }
  | { skip: string };

export interface StageContext {
  log: Logger;
  /** Canceled when the runner is shutting down. */
  signal: AbortSignal;
}

export type StageDep = string | { name: string; minVersion: number };

export interface StageConfig<TPatch = Record<string, unknown>> {
  name: string;
  /**
   * Bumping this on deploy triggers a dead-doc reset on boot and re-queues
   * all docs at the lower version.
   */
  targetVersion: number;
  /**
   * Stages whose version must reach a minimum before this stage's claim
   * query matches a doc.
   */
  dependsOn: StageDep[];
  defaults: WorkerConfig & {
    /**
     * Initial paused state when no worker_config doc exists yet. On
     * subsequent boots, the saved value is authoritative.
     */
    pausedOnFirstBoot: boolean;
  };
  handler: (image: ImageDoc, ctx: StageContext) => Promise<StageResult<TPatch>>;
}

/** Zero-cost identity helper that provides `TPatch` inference at stage sites. */
export function defineStage<TPatch = Record<string, unknown>>(
  config: StageConfig<TPatch>,
): StageConfig<TPatch> {
  return config;
}

// ---------------------------------------------------------------------------
// Boot: load or seed worker_config for a stage.
// ---------------------------------------------------------------------------

export async function bootConfig(
  stage: StageConfig,
  coll: Collection<WorkerConfigDoc>,
): Promise<WorkerConfig> {
  const repo = new WorkerConfigRepo(coll);
  const existing = await repo.load(stage.name);

  const merged: WorkerConfig = {
    concurrency: pickInt(existing?.concurrency, stage.defaults.concurrency),
    pollIntervalMs: pickInt(
      existing?.pollIntervalMs,
      stage.defaults.pollIntervalMs,
    ),
    batchSize: pickInt(existing?.batchSize, stage.defaults.batchSize),
    maxAttempts: pickInt(existing?.maxAttempts, stage.defaults.maxAttempts),
    paused:
      typeof existing?.paused === "boolean"
        ? existing.paused
        : stage.defaults.pausedOnFirstBoot,
    last_seen_target_version: pickInt(existing?.last_seen_target_version, 0),
  };

  // Idempotent. On first boot, seeds defaults; on subsequent boots, either
  // no-ops (when the doc was already complete) or repairs missing fields
  // written by a PATCH that landed before the first bootConfig.
  await repo.upsert(stage.name, merged);
  return merged;
}

function pickInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) ? value : fallback;
}

// ---------------------------------------------------------------------------
// Version-bump reset: re-queue dead docs when targetVersion was bumped.
// ---------------------------------------------------------------------------

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
// Claim query.
// ---------------------------------------------------------------------------

export function buildClaimQuery(
  name: string,
  targetVersion: number,
  dependsOn: Array<{ name: string; minVersion: number }>,
  inFlight: Set<ObjectId>,
): Filter<ImageDoc> {
  const filter: Filter<ImageDoc> = {
    $or: [
      { [`stages.${name}.version`]: { $lt: targetVersion } },
      { [`stages.${name}.version`]: { $exists: false } },
    ],
    [`stages.${name}.dead`]: { $ne: true },
  };
  for (const dep of dependsOn) {
    (filter as Record<string, unknown>)[`stages.${dep.name}.version`] = {
      $gte: dep.minVersion,
    };
  }
  if (inFlight.size > 0) {
    (filter as Record<string, unknown>)["_id"] = { $nin: [...inFlight] };
  }
  return filter;
}

// ---------------------------------------------------------------------------
// Worker-slot pool — bounded concurrency for the per-tick dispatch.
// ---------------------------------------------------------------------------

async function dispatchPool<T>(
  items: T[],
  limit: number,
  run: (item: T) => Promise<void>,
): Promise<void> {
  const queue = [...items];
  const workers: Promise<void>[] = [];
  const concurrency = Math.max(1, Math.min(limit, queue.length));
  for (let i = 0; i < concurrency; i++) {
    workers.push(
      (async () => {
        while (queue.length > 0) {
          const item = queue.shift();
          if (item === undefined) return;
          await run(item);
        }
      })(),
    );
  }
  await Promise.all(workers);
}

// ---------------------------------------------------------------------------
// Single poll tick.
// ---------------------------------------------------------------------------

export async function runOnce(
  stage: StageConfig,
  config: WorkerConfig,
  images: Collection<ImageDoc>,
  _configColl: Collection<WorkerConfigDoc>,
  resolvedDeps: Array<{ name: string; minVersion: number }> = stage.dependsOn.map(
    (d) => (typeof d === "string" ? { name: d, minVersion: 1 } : d),
  ),
  signal?: AbortSignal,
  inFlightSet?: Set<string>,
  throughput?: ThroughputWindow,
): Promise<void> {
  if (config.paused) return;

  const log = childLogger(`workers:${stage.name}`);
  const effectiveSignal = signal ?? new AbortController().signal;
  const ctx = { log, signal: effectiveSignal };

  const claimSet = new Set<ObjectId>();
  const query = buildClaimQuery(stage.name, stage.targetVersion, resolvedDeps, claimSet);

  const docs = await images.find(query).limit(config.batchSize).toArray();

  await dispatchPool(docs, config.concurrency, async (doc) => {
    const id = (doc as { _id: ObjectId })._id;
    const idStr = String(id);
    inFlightSet?.add(idStr);
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
        await recordAndPublishAssetChange({
          kind: "update",
          asset_id: id,
          folder_id: (doc as { folder_id: ObjectId }).folder_id,
          abs_path: (doc as { abs_path: string }).abs_path,
        }).catch(() => {});
      } else if ("wrote" in result) {
        await images.updateOne(
          { _id: id },
          { $set: { [`stages.${stage.name}`]: stageState } },
        );
        await recordAndPublishAssetChange({
          kind: "update",
          asset_id: id,
          folder_id: (doc as { folder_id: ObjectId }).folder_id,
          abs_path: (doc as { abs_path: string }).abs_path,
        }).catch(() => {});
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
      throughput?.record(new Date());
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
      inFlightSet?.delete(idStr);
    }
  });
}

// ---------------------------------------------------------------------------
// ThroughputWindow — rolling completion counter for the status API.
// ---------------------------------------------------------------------------

export class ThroughputWindow {
  private timestamps: number[] = [];
  private readonly windowMs: number;

  constructor(windowMs: number = 300_000) {
    this.windowMs = windowMs;
  }

  record(processedAt: Date): void {
    this.timestamps.push(processedAt.getTime());
  }

  countInWindow(nowMs: number = Date.now()): number {
    const cutoff = nowMs - this.windowMs;
    this.timestamps = this.timestamps.filter((t) => t >= cutoff);
    return this.timestamps.length;
  }
}

// ---------------------------------------------------------------------------
// Test-only export — internal helpers used by run-stage.test.ts.
// ---------------------------------------------------------------------------

export const _test = { bootConfig, versionBumpReset, runOnce };

// ---------------------------------------------------------------------------
// runStage — the in-process entry point. One call per stage on boot.
// ---------------------------------------------------------------------------

const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];

export interface RunStageHandle {
  /** Cancel the poll loop and wait for in-flight docs to drain. */
  stop: () => Promise<void>;
}

/**
 * Boot and run a stage in the current process. Returns a handle whose
 * `stop()` cancels the loop and waits for in-flight work to drain.
 *
 * Behaviour preserved from the old supervisor + runtime:
 *   - bootConfig (seed-or-load with self-heal for partial PATCH docs)
 *   - version-bump dead-doc reset
 *   - poll loop with per-tick claim-query + bounded worker pool
 *   - retry / dead-letter bookkeeping inside runOnce
 *   - throughput window + in-flight set published to stageRegistry
 *   - pause: written to worker_config; re-read every tick
 *   - retry transient errors with exponential backoff (saturates at 30s)
 */
export async function runStage(stage: StageConfig): Promise<RunStageHandle> {
  const log = childLogger(`workers:${stage.name}`);
  const { getDb } = await import("../db/client.ts");
  const db = await getDb();
  const images = db.collection<ImageDoc>("assets");
  const configColl = db.collection<WorkerConfigDoc>("worker_config");
  const repo = new WorkerConfigRepo(configColl);

  let config = await bootConfig(stage, configColl);
  log.info({ config }, `${stage.name} stage booted`);

  if (stage.targetVersion > config.last_seen_target_version) {
    log.info(
      { from: config.last_seen_target_version, to: stage.targetVersion },
      `${stage.name} version bump — resetting dead docs`,
    );
    await versionBumpReset(stage, config.last_seen_target_version, images);
    await repo.patch(stage.name, { last_seen_target_version: stage.targetVersion });
    config = { ...config, last_seen_target_version: stage.targetVersion };
  }

  const throughput = new ThroughputWindow();
  const inFlightSet = new Set<string>();
  const abortController = new AbortController();

  // Publish ourselves to the in-process registry so routes/events can read
  // live state and route pause/resume / config-changed signals back to us.
  stageRegistry.register(stage.name, {
    targetVersion: stage.targetVersion,
    getInFlight: () => inFlightSet.size,
    getThroughput: () => throughput.countInWindow(),
    getPaused: () => config.paused,
    reloadConfig: async () => {
      const updated = await repo.load(stage.name);
      if (updated) {
        config = updated;
        log.info({ config }, `${stage.name} config reloaded`);
      }
    },
    pause: async () => {
      await repo.patch(stage.name, { paused: true });
      config = { ...config, paused: true };
      log.info(`${stage.name} paused`);
    },
    resume: async () => {
      await repo.patch(stage.name, { paused: false });
      config = { ...config, paused: false };
      log.info(`${stage.name} resumed`);
    },
  });

  let shuttingDown = false;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let consecutiveErrors = 0;

  const poll = async (): Promise<void> => {
    if (shuttingDown) return;
    let delay = config.pollIntervalMs;
    try {
      await runOnce(
        stage,
        config,
        images,
        configColl,
        undefined,
        abortController.signal,
        inFlightSet,
        throughput,
      );
      consecutiveErrors = 0;
      // Surface a clean recovery via /api/workers/status — without this the
      // last poll-loop error would linger as `lastError` indefinitely.
      stageRegistry.clearError(stage.name);
    } catch (err) {
      consecutiveErrors++;
      const idx = Math.min(consecutiveErrors - 1, BACKOFF_MS.length - 1);
      delay = BACKOFF_MS[idx]!;
      const msg = err instanceof Error ? err.message : String(err);
      // Publish into the registry so DB/claim-query failures show up on the
      // status route instead of being a silent log-only event with the stage
      // still reported as healthy.
      stageRegistry.recordError(stage.name, msg);
      // Pass the raw Error to pino so its serializer preserves the stack
      // and any structured driver fields (MongoDB error codes etc.) —
      // restores the contract established by #25.
      log.error(
        { err, retryInMs: delay },
        `${stage.name} poll tick error`,
      );
    }
    if (!shuttingDown) pollTimer = setTimeout(poll, delay);
  };

  // First tick fires immediately so a freshly-booted stage doesn't wait a
  // full poll interval before doing any work.
  pollTimer = setTimeout(poll, 0);

  const stop = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`${stage.name} shutting down — draining`);
    abortController.abort();
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
    // Wait for in-flight handlers to finish. Bounded to 30s so a stuck
    // handler can't block server shutdown indefinitely.
    const deadline = Date.now() + 30_000;
    while (inFlightSet.size > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    stageRegistry.unregister(stage.name);
    log.info(`${stage.name} shut down`);
  };

  return { stop };
}

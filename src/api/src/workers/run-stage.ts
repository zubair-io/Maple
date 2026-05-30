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
 * Mongo doc; the running loop notices on its next tick (≤ POLL_INTERVAL_MS)".
 *
 * Status / control surface is published into the in-process `stageRegistry`
 * (see `./registry.ts`) so `routes.ts` and `events.ts` can read live state.
 */

import type { Collection, Filter, ObjectId, WithId } from 'mongodb';
import type { Logger } from 'pino';
import { child as childLogger } from '../log.ts';
import {
  assetAbsPath,
  assetPrimaryFileInfo,
  isEnoentError,
  type IndexerAssetDoc,
} from '../indexer/images.repo.ts';
import { loadLibraryRoots } from '../indexer/libraries.cache.ts';
import { WorkerConfigRepo, type WorkerConfigDoc } from './worker-config.repo.ts';
import { recordAndPublishAssetChange } from '../db/changes.repo.ts';
import { stageRegistry } from './registry.ts';
import { POLL_INTERVAL_MS, deriveBatchSize, nextPollDelay } from './loop-policy.ts';

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

export type ImageDoc = WithId<IndexerAssetDoc> & {
  stages?: Record<string, StageState>;
};

export interface WorkerConfig {
  concurrency: number;
  maxAttempts: number;
  paused: boolean;
  /**
   * Last targetVersion the runner has seen. Compared against
   * StageConfig.targetVersion on boot to detect version bumps that
   * require a dead-doc reset.
   */
  last_seen_target_version: number;
}

// Poll-loop timing policy lives in `./loop-policy.ts`. Re-exported here so the
// many stage files and tests that import these from `run-stage.ts` keep working.
export { POLL_INTERVAL_MS, BACKOFF_MS, deriveBatchSize, nextPollDelay } from './loop-policy.ts';

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
  /**
   * When true, a handler failure whose error is ENOENT is taken to mean the
   * on-disk original vanished: the runner stamps `missing_since` on the asset
   * (the "pending delete" tag the operator-gated missing-reaper consumes) in
   * addition to the normal attempts / dead bookkeeping. Set ONLY on stages
   * that read the original file (exif / thumb / preview) — never on stages
   * that read a derived artefact (a missing thumbnail must not be mistaken
   * for a missing original). A spurious tag is self-correcting: the reaper
   * re-stats on disk and clears the tag when the file is actually present.
   */
  tagsMissingOnEnoent?: boolean;
  handler: (image: ImageDoc, ctx: StageContext) => Promise<StageResult<TPatch>>;
  /**
   * Optional per-tick progress hook, invoked by the poll loop after each
   * successful `runOnce` tick (NOT on a tick that threw — those go through
   * the retry/backoff path instead). Generic + opt-in: stages that don't
   * set it pay nothing. `face-embed` uses it to drive auto-clustering.
   *
   * @param processedThisTick docs claimed + dispatched this tick (0 = the
   *   claim query matched nothing — i.e. the stage is idle/drained).
   * @param idle convenience flag, `true` iff `processedThisTick === 0`.
   *
   * Best-effort: the loop awaits it but swallows + logs any rejection so a
   * misbehaving hook can never stall or crash the poll loop.
   */
  onProgress?: (processedThisTick: number, idle: boolean) => void | Promise<void>;
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
    maxAttempts: pickInt(existing?.maxAttempts, stage.defaults.maxAttempts),
    paused:
      typeof existing?.paused === 'boolean' ? existing.paused : stage.defaults.pausedOnFirstBoot,
    last_seen_target_version: pickInt(existing?.last_seen_target_version, 0),
  };

  // Idempotent. On first boot, seeds defaults; on subsequent boots, either
  // no-ops (when the doc was already complete) or repairs missing fields
  // written by a PATCH that landed before the first bootConfig.
  await repo.upsert(stage.name, merged);
  return merged;
}

function pickInt(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) ? value : fallback;
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

/** Normalise a stage's `dependsOn` (bare-string or {name,minVersion}) to the
 * concrete {name, minVersion} shape `buildClaimQuery` and the registry use.
 * A bare string means "depends on that stage at version >= 1". */
export function resolveStageDeps(
  dependsOn: StageDep[],
): Array<{ name: string; minVersion: number }> {
  return dependsOn.map((d) => (typeof d === 'string' ? { name: d, minVersion: 1 } : d));
}

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
    // Skip assets whose original is tagged missing: `missing_since` holds an ISO
    // string while tagged, and is absent/null otherwise. A tagged asset is
    // parked for EVERY stage until the missing-reaper resolves it (clears the
    // tag → reprocesses, or hard-deletes the row). This is what makes "tag once,
    // stop touching it everywhere" hold — see the ENOENT branch in runOnce.
    missing_since: { $not: { $type: 'string' } },
  };
  for (const dep of dependsOn) {
    (filter as Record<string, unknown>)[`stages.${dep.name}.version`] = {
      $gte: dep.minVersion,
    };
  }
  if (inFlight.size > 0) {
    (filter as Record<string, unknown>)['_id'] = { $nin: [...inFlight] };
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

/**
 * Resolve `(folder_id, abs_path)` from the doc's primary fileinfo entry and
 * publish an update event onto the change feed. Best-effort — failures are
 * swallowed; the change feed tolerates gaps.
 */
async function publishUpdate(id: ObjectId, doc: ImageDoc): Promise<void> {
  let libs: ReadonlyMap<string, string>;
  try {
    libs = await loadLibraryRoots();
  } catch {
    libs = new Map();
  }
  const primary = assetPrimaryFileInfo(doc);
  const folderId = primary?.library_id ?? null;
  const absPath = assetAbsPath(doc, libs);
  await recordAndPublishAssetChange({
    kind: 'update',
    asset_id: id,
    folder_id: folderId,
    abs_path: absPath,
  }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Single poll tick.
// ---------------------------------------------------------------------------

export async function runOnce(
  stage: StageConfig,
  config: WorkerConfig,
  images: Collection<ImageDoc>,
  _configColl: Collection<WorkerConfigDoc>,
  resolvedDeps: Array<{ name: string; minVersion: number }> = resolveStageDeps(stage.dependsOn),
  signal?: AbortSignal,
  inFlightSet?: Set<string>,
  throughput?: ThroughputWindow,
): Promise<number> {
  if (config.paused) return 0;

  const log = childLogger(`workers:${stage.name}`);
  const effectiveSignal = signal ?? new AbortController().signal;
  const ctx = { log, signal: effectiveSignal };

  const claimSet = new Set<ObjectId>();
  const query = buildClaimQuery(stage.name, stage.targetVersion, resolvedDeps, claimSet);

  // Batch size is derived (5× concurrency), not a knob. With the
  // re-poll-on-full-batch loop, this only governs DB round-trip efficiency.
  const batchSize = deriveBatchSize(config.concurrency);
  const docs = await images.find(query).limit(batchSize).toArray();

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

      if ('patch' in result) {
        const forbiddenKeys = Object.keys(result.patch).filter((k) => k.startsWith('stages.'));
        if (forbiddenKeys.length > 0) {
          throw new Error(
            `Handler returned patch with forbidden stage keys: ${forbiddenKeys.join(', ')}`,
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
        await publishUpdate(id, doc);
      } else if ('wrote' in result) {
        await images.updateOne({ _id: id }, { $set: { [`stages.${stage.name}`]: stageState } });
        await publishUpdate(id, doc);
      } else if ('skip' in result) {
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
      // Handled case: an original-file stage hit ENOENT — the on-disk original
      // is (apparently) gone. Just TAG it (`missing_since`) and stop. We touch
      // no stage state: the tag immediately drops the asset out of every
      // stage's claim query (see buildClaimQuery), so there's no retry churn,
      // no dead-letter, and no scary raw ENOENT. The missing-reaper then
      // resolves it — clears the tag (asset reprocesses, since its stages were
      // never marked done/dead) or hard-deletes the row.
      if (stage.tagsMissingOnEnoent && isEnoentError(err)) {
        // Conditional tag → first-detection wins (the reaper's boot age-gate
        // must not be pushed forward by re-runs). Best-effort.
        await images
          .updateOne(
            { _id: id, $or: [{ missing_since: { $exists: false } }, { missing_since: null }] },
            { $set: { missing_since: new Date().toISOString() } },
          )
          .catch(() => {});
        log.debug({ _id: idStr }, `${stage.name}: original missing — tagged for reaper`);
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      const current = await images.findOne(
        { _id: id },
        { projection: { [`stages.${stage.name}`]: 1 } },
      );
      const currentAttempts = (current?.stages?.[stage.name]?.attempts ?? 0) + 1;
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

  // Report how many docs this tick claimed + dispatched. The poll loop hands
  // this to `stage.onProgress` so a stage can react to throughput / idle
  // edges without a second DB query (the count is the claim batch size).
  return docs.length;
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

export const _test = { bootConfig, versionBumpReset, runOnce, nextPollDelay };

// ---------------------------------------------------------------------------
// runStage — the in-process entry point. One call per stage on boot.
// ---------------------------------------------------------------------------

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
export async function runStage<TPatch extends Record<string, unknown>>(
  stage: StageConfig<TPatch>,
): Promise<RunStageHandle> {
  const log = childLogger(`workers:${stage.name}`);
  const { getDb } = await import('../db/client.ts');
  const db = await getDb();
  const images = db.collection<ImageDoc>('assets');
  const configColl = db.collection<WorkerConfigDoc>('worker_config');
  const repo = new WorkerConfigRepo(configColl);

  let config = await bootConfig(stage, configColl);
  log.info({ config }, `${stage.name} stage booted`);

  if (stage.targetVersion > config.last_seen_target_version) {
    log.info(
      { from: config.last_seen_target_version, to: stage.targetVersion },
      `${stage.name} version bump — resetting dead docs`,
    );
    await versionBumpReset(stage, config.last_seen_target_version, images);
    await repo.patch(stage.name, {
      last_seen_target_version: stage.targetVersion,
    });
    config = { ...config, last_seen_target_version: stage.targetVersion };
  }

  const throughput = new ThroughputWindow();
  const inFlightSet = new Set<string>();
  const abortController = new AbortController();

  // Publish ourselves to the in-process registry so routes/events can read
  // live state and route pause/resume / config-changed signals back to us.
  stageRegistry.register(stage.name, {
    targetVersion: stage.targetVersion,
    dependsOn: resolveStageDeps(stage.dependsOn),
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
    // The global idle cadence, unless a full batch (→ 0, drain backlog) or an
    // error (→ exponential backoff) overrides it. See `nextPollDelay`. geocode
    // throttles itself via its own token bucket, so the 0-delay path is
    // harmless there.
    let delay = POLL_INTERVAL_MS;
    try {
      const processedThisTick = await runOnce(
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
      // A full batch means there's almost certainly more backlog waiting —
      // re-poll immediately; otherwise fall back to the idle cadence.
      delay = nextPollDelay({
        claimed: processedThisTick,
        concurrency: config.concurrency,
        paused: config.paused,
        consecutiveErrors: 0,
      });
      // Surface a clean recovery via /api/workers/status — without this the
      // last poll-loop error would linger as `lastError` indefinitely.
      stageRegistry.clearError(stage.name);
      // Notify the stage's optional progress hook (e.g. face-embed → the
      // clustering coordinator). Skipped while paused — runOnce returns 0
      // immediately under pause, but the hook would still observe a
      // false "idle" edge every tick, so don't fire it at all. Best-effort:
      // a rejecting hook is logged, never allowed to stall the loop.
      if (stage.onProgress && !config.paused) {
        try {
          await stage.onProgress(processedThisTick, processedThisTick === 0);
        } catch (hookErr) {
          const m = hookErr instanceof Error ? hookErr.message : String(hookErr);
          log.warn({ err: hookErr, msg: m }, `${stage.name} onProgress hook threw`);
        }
      }
    } catch (err) {
      consecutiveErrors++;
      delay = nextPollDelay({
        claimed: 0,
        concurrency: config.concurrency,
        paused: config.paused,
        consecutiveErrors,
      });
      const msg = err instanceof Error ? err.message : String(err);
      // Publish into the registry so DB/claim-query failures show up on the
      // status route instead of being a silent log-only event with the stage
      // still reported as healthy.
      stageRegistry.recordError(stage.name, msg);
      // Pass the raw Error to pino so its serializer preserves the stack
      // and any structured driver fields (MongoDB error codes etc.) —
      // restores the contract established by #25.
      log.error({ err, retryInMs: delay }, `${stage.name} poll tick error`);
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

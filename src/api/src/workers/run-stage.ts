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
import { child as childLogger } from '../log.ts';
import { assetAbsPath, assetPrimaryFileInfo, isEnoentError } from '../indexer/images.repo.ts';
import { loadLibraryRoots } from '../indexer/libraries.cache.ts';
import { WorkerConfigRepo, type WorkerConfigDoc } from './worker-config.repo.ts';
import { ThroughputWindow } from './throughput-window.ts';
import { recordAndPublishAssetChange } from '../db/changes.repo.ts';
import { stageRegistry } from './registry.ts';
import { POLL_INTERVAL_MS, deriveBatchSize, nextPollDelay } from './loop-policy.ts';
import { tagMissingSince } from './tag-missing.ts';
import { tagDamaged } from './tag-damaged.ts';
import { dispatchPool } from './dispatch-pool.ts';
import { bootConfig, defineStage, resolveStageDeps, versionBumpReset } from './stage-config.ts';
import type {
  ImageDoc,
  StageConfig,
  StageContext,
  StageDep,
  StageResult,
  StageState,
  WorkerConfig,
} from './stage-config.ts';

// ---------------------------------------------------------------------------
// Stage-definition / config plumbing lives in `./stage-config.ts`. Re-exported
// here so the many stage files and tests that import these from `run-stage.ts`
// keep working unchanged (`import { defineStage, type ImageDoc } from
// './run-stage.ts'`, etc.).
// ---------------------------------------------------------------------------

export { bootConfig, defineStage, resolveStageDeps, versionBumpReset };
export type {
  ImageDoc,
  StageConfig,
  StageContext,
  StageDep,
  StageResult,
  StageState,
  WorkerConfig,
};

// Poll-loop timing policy lives in `./loop-policy.ts`. Re-exported here so the
// many stage files and tests that import these from `run-stage.ts` keep working.
export { POLL_INTERVAL_MS, BACKOFF_MS, deriveBatchSize, nextPollDelay } from './loop-policy.ts';

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
    // Skip assets tagged missing (`missing_since` is an ISO string while tagged,
    // absent/null otherwise): a tagged asset is parked for EVERY stage until the
    // missing-reaper resolves it (clears the tag, or hard-deletes the row).
    missing_since: { $not: { $type: 'string' } },
    // Skip assets tagged damaged (`damaged.since` is an ISO string while
    // tagged): the bytes are unreadable, so the file is parked for EVERY stage
    // until an operator clears the tag from the Workers UI. Same absent/null →
    // claimable shape as `missing_since`.
    'damaged.since': { $not: { $type: 'string' } },
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
      } else if ('damaged' in result) {
        // Deterministically-unreadable bytes (the handler already knows retries
        // are futile). Mark this stage dead after its single attempt and tag
        // the asset `damaged` so it parks out of every stage's claim query and
        // shows up in the Workers "Damaged" list. We record `attempts: 1` (it
        // was processed once and classified, not retried to exhaustion) and
        // rely on `dead: true` + the damaged tag to park it. We do NOT bump
        // version — if an operator clears the tag (which resets dead/attempts
        // on the damage-tagging stages), the asset reprocesses from here.
        // Guarded on `tagsDamagedOnDeadLetter` so a stage whose state the clear
        // path doesn't reset can't strand the asset.
        if (!stage.tagsDamagedOnDeadLetter) {
          throw new Error(
            `stage '${stage.name}' returned { damaged } but is not a damage-tagging stage`,
          );
        }
        await images.updateOne(
          { _id: id },
          {
            $set: {
              [`stages.${stage.name}.attempts`]: 1,
              [`stages.${stage.name}.last_error`]: result.damaged,
              [`stages.${stage.name}.dead`]: true,
            },
          },
        );
        await tagDamaged(images, id, stage.name, result.damaged);
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
        await tagMissingSince(images, id);
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
      // A file-reading stage that just exhausted its retries means the bytes
      // are unreadable (corrupt original, or an undecodable format). Tag the
      // asset `damaged` so the rest of the pipeline parks it instead of each
      // stage independently grinding to its own dead-letter — and so it
      // surfaces in the Workers "Damaged" list. The structured `asset.damaged`
      // log inside `tagDamaged` reaches SigNoz via the pino→OTel bridge.
      if (dead && stage.tagsDamagedOnDeadLetter) {
        await tagDamaged(images, id, stage.name, msg);
      }
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
// Extracted to ./throughput-window.ts to keep this file under the 600-line
// budget; re-exported so the existing import surface
// (`import { ThroughputWindow } from './run-stage.ts'`) is unchanged.
// ---------------------------------------------------------------------------

export { ThroughputWindow };

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

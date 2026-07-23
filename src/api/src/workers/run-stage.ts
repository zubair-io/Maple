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

import type { Collection, Filter, ObjectId } from 'mongodb';
import { child as childLogger } from '../log.ts';
import {
  assetAbsPath,
  assetPrimaryFileInfo,
  isEnoentError,
  liveFileInfoElemMatch,
} from '../indexer/images.repo.ts';
import { loadLibraryRoots } from '../indexer/libraries.cache.ts';
import { WorkerConfigRepo, type WorkerConfigDoc } from './worker-config.repo.ts';
import { ThroughputWindow } from './throughput-window.ts';
import { recordAndPublishAssetChange } from '../db/changes.repo.ts';
import { stageRegistry } from './registry.ts';
import { POLL_INTERVAL_MS, deriveBatchSize, nextPollDelay } from './loop-policy.ts';
import { confirmAndTagMissing } from './tag-missing.ts';
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
  claimFilter?: Filter<ImageDoc>,
): Filter<ImageDoc> {
  const filter: Filter<ImageDoc> = {
    $or: [
      { [`stages.${name}.version`]: { $lt: targetVersion } },
      { [`stages.${name}.version`]: { $exists: false } },
    ],
    [`stages.${name}.dead`]: { $ne: true },
    // Require at least one LIVE on-disk location. An asset whose every
    // `fileinfo` entry is non-live — `deleted_at` (bytes replaced) or
    // `missing_since` (file vanished) — has nothing to process and is parked
    // for EVERY stage until either the missing-reaper resolves it (recovers a
    // location, or `$pull`s the dead entries and deletes the record) or a
    // re-discover relinks a live location. Replaces the former root
    // `missing_since` park: per-entry `missing_since` now expresses "this
    // location is gone", and a row with no live entry is exactly the parked set.
    ...liveFileInfoElemMatch(),
    // Skip assets tagged damaged (`damaged.since` is an ISO string while
    // tagged): the bytes are unreadable, so the file is parked for EVERY stage
    // until an operator clears the tag from the Workers UI.
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
  // A stage-supplied predicate (e.g. transcribe's video/audio filename regex)
  // is AND-ed on so it can't collide with the base query's own `fileinfo` /
  // `$or` keys. Absent → the base query is returned unchanged.
  return claimFilter ? { $and: [filter, claimFilter] } : filter;
}

/**
 * `$set` keys that mark each stage in `names` stale (version 0, bookkeeping
 * cleared) — the runner folds these into the SAME atomic write as a patch
 * result's field values, so a crash can never land the new fields without
 * also marking the downstream stage stale (or vice versa). The writing
 * stage's own name is excluded: its state is owned by `stageState` in the
 * same write. See `StageResult`'s `invalidates` doc (#2172).
 */
function invalidationSets(
  names: readonly string[] | undefined,
  ownName: string,
): Record<string, unknown> {
  // Names are interpolated into `$set` paths — a `.`/`$`-bearing or empty
  // value would silently create unintended nested fields (or throw
  // mid-update). Stage names are compile-time constants, so any mismatch is
  // a programming error: fail the attempt loudly rather than write a
  // malformed update.
  const invalid = (names ?? []).filter((s) => !/^[a-z][a-z0-9_-]*$/.test(s));
  if (invalid.length > 0) {
    throw new Error(`invalid stage name in invalidates: ${invalid.join(', ')}`);
  }
  return Object.fromEntries(
    (names ?? [])
      .filter((s) => s !== ownName)
      .flatMap((s) => [
        [`stages.${s}.version`, 0],
        [`stages.${s}.attempts`, 0],
        [`stages.${s}.dead`, false],
        [`stages.${s}.last_error`, null],
        [`stages.${s}.processed_at`, null],
      ]),
  );
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
  const query = buildClaimQuery(
    stage.name,
    stage.targetVersion,
    resolvedDeps,
    claimSet,
    stage.claimFilter,
  );

  // Batch size is derived (5× concurrency), not a knob. With the
  // re-poll-on-full-batch loop, this only governs DB round-trip efficiency.
  const batchSize = deriveBatchSize(config.concurrency);
  const docs = await images.find(query).limit(batchSize).toArray();

  const stageKey = `stages.${stage.name}`;
  const priorAttempts = (d: ImageDoc): number => d.stages?.[stage.name]?.attempts ?? 0;

  // Crash-attributable claims (#897). The worker tier runs native code (onnx,
  // libraw, sharp) that can `abort()` the whole process mid-handler — an
  // UNCATCHABLE death the catch below never observes. A doc whose `attempts`
  // reached `maxAttempts` but was never marked done OR dead can only have got
  // there by aborting the worker on each claim (a normal throw dead-letters in
  // the catch). Reconcile it here — mark it dead (+ damaged on file-reading
  // stages) and DON'T re-dispatch — otherwise one poison asset re-claims on
  // every respawn forever and the whole tier never drains.
  const exhausted = docs.filter((d) => priorAttempts(d) >= config.maxAttempts);
  for (const doc of exhausted) {
    const id = (doc as { _id: ObjectId })._id;
    const reason = `claimed ${priorAttempts(doc)}× without completing — worker aborted mid-handler (uncatchable native crash)`;
    await images.updateOne(
      { _id: id },
      { $set: { [`${stageKey}.dead`]: true, [`${stageKey}.last_error`]: reason } },
    );
    if (stage.tagsDamagedOnDeadLetter) await tagDamaged(images, id, stage.name, reason);
  }
  const claimable = docs.filter((d) => priorAttempts(d) < config.maxAttempts);

  await dispatchPool(claimable, config.concurrency, async (doc) => {
    const id = (doc as { _id: ObjectId })._id;
    const idStr = String(id);
    const attemptNo = priorAttempts(doc) + 1;
    inFlightSet?.add(idStr);
    try {
      // Persist this attempt BEFORE running the handler so an uncatchable
      // process death (native SIGABRT/SIGSEGV) still counts toward maxAttempts.
      // A clean success — or a normal skip — resets attempts to 0; the catch
      // computes `dead` from `attemptNo` (already persisted) without re-reading
      // or re-incrementing; the park-for-reaper paths (ENOENT /
      // no-resolvable-location) roll this back to the prior count, since a
      // missing original was never genuinely attempted.
      await images.updateOne({ _id: id }, { $set: { [`${stageKey}.attempts`]: attemptNo } });
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
              ...invalidationSets(result.invalidates, stage.name),
              ...result.patch,
            },
          },
        );
        await publishUpdate(id, doc);
      } else if ('wrote' in result) {
        await images.updateOne({ _id: id }, { $set: { [`stages.${stage.name}`]: stageState } });
        await publishUpdate(id, doc);
      } else if ('skip' in result) {
        // A no-resolvable-location skip no longer needs a special
        // orphan-tagging branch. An asset whose every fileinfo entry is
        // non-live is now parked by `buildClaimQuery` (the live-entry
        // `$elemMatch`), so it is never claimed in the first place — and it
        // always carries a per-entry `missing_since` from whatever made it
        // non-live (the watcher `removed` handler, the modified-content guard's
        // orphan dual-flag, or the ENOENT catch below), so the missing-reaper
        // already sees it. Record the skip reason and move on; the stage state
        // resets attempts to 0 so this never dead-letters.
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
        // Roll back the claim's provisional attempt: a missing original was
        // never genuinely attempted — it's parked for the reaper via the tag.
        await images.updateOne({ _id: id }, { $set: { [`${stageKey}.attempts`]: attemptNo - 1 } });
        // Tag the PRIMARY entry — the one whose abs-path we just failed to
        // read — per location, but only after confirmAndTagMissing verifies
        // the library root is available and a re-stat confirms the ENOENT
        // (#2171: a race or an unmounted root must not tag a present file —
        // an unconfirmed miss just leaves the row claimable for a retry). If
        // it was the asset's only live entry the row drops out of reads +
        // claims (live-entry `$elemMatch`); the reaper re-stats it, recovers
        // if the file reappears, else `$pull`s it.
        const primary = assetPrimaryFileInfo(doc);
        const tagged = primary
          ? await confirmAndTagMissing(images, id, primary, `stage-enoent:${stage.name}`)
          : false;
        if (tagged) {
          log.debug({ _id: idStr }, `${stage.name}: original missing — tagged for reaper`);
        } else {
          log.warn(
            { _id: idStr },
            `${stage.name}: ENOENT not confirmed (root unavailable or file present) — not tagging, will retry`,
          );
        }
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      // `attempts` was already persisted at claim time (so an uncatchable death
      // still counts), so compute `dead` from `attemptNo` rather than re-reading
      // or re-incrementing.
      const dead = attemptNo >= config.maxAttempts;
      await images.updateOne(
        { _id: id },
        {
          $set: {
            [`${stageKey}.last_error`]: msg,
            [`${stageKey}.dead`]: dead,
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
  /** Timestamp of the most recent successful config read from Mongo (ms). */
  let lastConfigReadAt = 0;
  /** Minimum gap between worker_config Mongo reads in the poll loop (ms).
   * Keeps a drained backlog (nextPollDelay → 0) from hammering the DB with
   * per-tick findOne calls. Pause latency remains ≤ ~2 s. */
  const CONFIG_RELOAD_INTERVAL_MS = 2000;

  const poll = async (): Promise<void> => {
    if (shuttingDown) return;
    // Re-read config from Mongo so pause/resume written by the API process
    // (cross-process boundary) take effect without an IPC round-trip.
    // Throttled to at most once every CONFIG_RELOAD_INTERVAL_MS to avoid
    // hammering the DB when nextPollDelay() returns 0 on a drained backlog.
    // Best-effort: a failing load keeps the previous config rather than crashing.
    if (Date.now() - lastConfigReadAt >= CONFIG_RELOAD_INTERVAL_MS) {
      try {
        const updated = await repo.load(stage.name);
        if (updated) config = updated;
        lastConfigReadAt = Date.now();
      } catch {
        /* keep previous config on load failure */
      }
    }
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

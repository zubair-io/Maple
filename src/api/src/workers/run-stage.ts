/**
 * In-process stage runner: boot, poll loop, and the control surface the
 * Workers page drives.
 *
 * Replaces the deleted multi-process supervisor (`supervisor.ts`,
 * `runtime/main.ts`, `runtime/run-stage.ts`, `runtime/define-stage.ts`) — see
 * issue #135. Each stage file (`stages/<name>.ts`) exports a thin
 * `start<Name>Stage()` that calls `runStage(config)`; this module owns the
 * loop, the version-bump reset, the throughput counter and the
 * pause-via-config path, while one tick's claim / dispatch / writeback lives
 * in `./run-stage.dispatch.ts`.
 *
 * No child processes, no IPC. Pause/resume is "write `paused: true` to the
 * `worker_config` row; the running loop notices on its next tick", which after
 * the SQLite cutover (#3787) is a keyed read of one row rather than a document
 * fetch — the cross-process contract is unchanged.
 *
 * Status / control is published into the in-process `stageRegistry`
 * (`./registry.ts`) so `routes.ts` and `events.ts` can read live state.
 */

import { child as childLogger } from '../log.ts';
import { ThroughputWindow } from './throughput-window.ts';
import { stageRegistry } from './registry.ts';
import { POLL_INTERVAL_MS, nextPollDelay } from './loop-policy.ts';
import { WorkerConfigRepo } from '../db/sqlite/repos/worker-config.repo.ts';
import { runOnce } from './run-stage.dispatch.ts';
import {
  bootConfig,
  defineStage,
  invalidationSets,
  notifyConfigChange,
  resolveStageDeps,
  versionBumpReset,
} from './stage-config.ts';
import type {
  ImageDoc,
  StageConfig,
  StageContext,
  StageDep,
  StageResult,
  StageState,
  WorkerConfig,
} from './stage-config.ts';

export { bootConfig, defineStage, resolveStageDeps, versionBumpReset, invalidationSets };
export { runOnce } from './run-stage.dispatch.ts';
export type {
  ImageDoc,
  StageConfig,
  StageContext,
  StageDep,
  StageResult,
  StageState,
  WorkerConfig,
};

export { POLL_INTERVAL_MS, BACKOFF_MS, deriveBatchSize, nextPollDelay } from './loop-policy.ts';

// ---------------------------------------------------------------------------
// ThroughputWindow — rolling completion counter for the status API.
// Lives in ./throughput-window.ts; re-exported so the existing import surface
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
  /** Cancel the poll loop and wait for in-flight assets to drain. */
  stop: () => Promise<void>;
}

/**
 * Minimum gap between `worker_config` reads in the poll loop.
 *
 * Keeps a drained backlog (`nextPollDelay` → 0) from re-reading the row on
 * every tick. Pause latency stays ≤ ~2 s.
 */
const CONFIG_RELOAD_INTERVAL_MS = 2000;

/**
 * Boot and run a stage in the current process. Returns a handle whose `stop()`
 * cancels the loop and waits for in-flight work to drain.
 *
 * Behaviour preserved from the old supervisor + runtime:
 *   - bootConfig (seed-or-load with self-heal for partial PATCH rows)
 *   - version-bump re-queue of everything below the new target
 *   - poll loop with a per-tick claim + bounded worker pool
 *   - retry / dead-letter bookkeeping inside the tick
 *   - throughput window + in-flight set published to stageRegistry
 *   - pause: written to `worker_config`; re-read every tick
 *   - transient poll errors retried with exponential backoff (saturates at 30s)
 */
export async function runStage<TPatch>(stage: StageConfig<TPatch>): Promise<RunStageHandle> {
  const log = childLogger(`workers:${stage.name}`);
  const repo = new WorkerConfigRepo();
  const generic = stage as unknown as StageConfig;

  let config = await bootConfig(generic);
  log.info({ config }, `${stage.name} stage booted`);

  if (stage.targetVersion > config.last_seen_target_version) {
    const requeued = await versionBumpReset(generic, config.last_seen_target_version);
    log.info(
      { from: config.last_seen_target_version, to: stage.targetVersion, requeued },
      `${stage.name} version bump — re-queued assets below the new target`,
    );
    await repo.patch(stage.name, { last_seen_target_version: stage.targetVersion });
    config = { ...config, last_seen_target_version: stage.targetVersion };
  }

  const throughput = new ThroughputWindow();
  const inFlightSet = new Set<string>();
  const abortController = new AbortController();

  // Publish ourselves to the in-process registry so routes/events can read live
  // state and route pause/resume / config-changed signals back to us.
  stageRegistry.register(stage.name, {
    targetVersion: stage.targetVersion,
    dependsOn: resolveStageDeps(stage.dependsOn),
    getInFlight: () => inFlightSet.size,
    getThroughput: () => throughput.countInWindow(),
    getPaused: () => config.paused,
    reloadConfig: async () => {
      const updated = await repo.load(stage.name);
      if (updated) {
        notifyConfigChange(stage as StageConfig<unknown>, updated, config, log);
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
      config = { ...config, paused: false, pause_reason: null };
      log.info(`${stage.name} resumed`);
    },
  });

  let shuttingDown = false;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let consecutiveErrors = 0;
  /** Timestamp of the most recent successful config read (ms). */
  let lastConfigReadAt = 0;

  /**
   * Re-read the stage's config so a pause/resume written by the API process
   * takes effect without an IPC round-trip. Throttled, and best-effort: a
   * failing read keeps the previous config rather than crashing the loop.
   */
  const reloadConfigIfDue = async (): Promise<void> => {
    if (Date.now() - lastConfigReadAt < CONFIG_RELOAD_INTERVAL_MS) return;
    try {
      const updated = await repo.load(stage.name);
      if (updated) {
        notifyConfigChange(stage as StageConfig<unknown>, updated, config, log);
        config = updated;
      }
      lastConfigReadAt = Date.now();
    } catch {
      /* keep previous config on load failure */
    }
  };

  /**
   * Fire the stage's optional progress hook. Skipped while paused — the tick
   * returns 0 immediately under pause, and the hook would otherwise observe a
   * false "idle" edge every tick. Best-effort: a rejecting hook is logged,
   * never allowed to stall the loop.
   */
  const notifyProgress = async (processed: number): Promise<void> => {
    if (!stage.onProgress || config.paused) return;
    try {
      await stage.onProgress(processed, processed === 0);
    } catch (hookErr) {
      const msg = hookErr instanceof Error ? hookErr.message : String(hookErr);
      log.warn({ err: hookErr, msg }, `${stage.name} onProgress hook threw`);
    }
  };

  const poll = async (): Promise<void> => {
    if (shuttingDown) return;
    await reloadConfigIfDue();
    // The global idle cadence, unless a full batch (→ 0, drain the backlog) or
    // an error (→ exponential backoff) overrides it. See `nextPollDelay`.
    let delay = POLL_INTERVAL_MS;
    try {
      const processed = await runOnce(
        generic,
        config,
        undefined,
        abortController.signal,
        inFlightSet,
        throughput,
      );
      consecutiveErrors = 0;
      delay = nextPollDelay({
        claimed: processed,
        concurrency: config.concurrency,
        paused: config.paused,
        consecutiveErrors: 0,
      });
      // Surface a clean recovery via /api/workers/status — without this the
      // last poll-loop error would linger as `lastError` indefinitely.
      stageRegistry.clearError(stage.name);
      await notifyProgress(processed);
    } catch (err) {
      consecutiveErrors++;
      delay = nextPollDelay({
        claimed: 0,
        concurrency: config.concurrency,
        paused: config.paused,
        consecutiveErrors,
      });
      const msg = err instanceof Error ? err.message : String(err);
      // Published into the registry so claim/database failures show up on the
      // status route instead of being a log-only event with the stage still
      // reported as healthy.
      stageRegistry.recordError(stage.name, msg);
      log.error({ err, retryInMs: delay }, `${stage.name} poll tick error`);
    }
    if (!shuttingDown) pollTimer = setTimeout(poll, delay);
  };

  // First tick fires immediately so a freshly-booted stage doesn't wait a full
  // poll interval before doing any work.
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
    // Wait for in-flight handlers to finish. Bounded to 30s so a stuck handler
    // cannot block server shutdown indefinitely.
    const deadline = Date.now() + 30_000;
    while (inFlightSet.size > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    stageRegistry.unregister(stage.name);
    log.info(`${stage.name} shut down`);
  };

  return { stop };
}

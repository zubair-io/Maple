/**
 * In-process stage runner: boot, the slice Temporal schedules, and the control
 * surface the Workers page drives.
 *
 * Each stage file (`stages/<name>.ts`) exports a thin `start<Name>Stage()` that
 * calls `runStage(config)`. This module owns the version-bump reset, the
 * throughput counter, the stall watch and the pause-via-config path; one
 * batch's claim / dispatch / writeback lives in `./run-stage.dispatch.ts`.
 *
 * The runner owns no timer. The stage lane (`./stage-lane.ts`) asks each
 * booted stage, about once a second, whether it has work: if it does, a
 * `stage-<name>` workflow runs {@link RunStageHandle.runSlice} until the stage
 * drains; if it does not, the lane calls {@link RunStageHandle.idle} instead.
 *
 * Pause/resume is "write `paused: true` to the `worker_config` row"; the runner
 * re-reads that row at most every two seconds, from a slice or an idle call.
 * Status is published into the in-process `stageRegistry` (`./registry.ts`).
 */

import { setTimeout as sleep } from 'node:timers/promises';
import { child as childLogger } from '../log.ts';
import { ThroughputWindow } from './throughput-window.ts';
import { DEFAULT_STALL_AFTER_MINUTES, StallWatch } from './stall-watch.ts';
import { stageRegistry } from './registry.ts';
import { WorkerConfigRepo } from '../db/repos/worker-config.repo.ts';
import { stageHasWork } from '../db/repos/stage-claim.ts';
import { runOnce } from './run-stage.dispatch.ts';
import type { StageSlice } from './stage-workflow.ts';
import {
  bootConfig,
  defineStage,
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

export { defineStage, resolveStageDeps };
export { runOnce } from './run-stage.dispatch.ts';
export type {
  ImageDoc,
  StageConfig,
  StageContext,
  StageDep,
  StageResult,
  StageSlice,
  StageState,
  WorkerConfig,
};

export { deriveBatchSize } from './loop-policy.ts';
export { ThroughputWindow };

export const _test = { bootConfig, versionBumpReset, runOnce };

export interface RunStageHandle {
  readonly name: string;
  /** From the last config read, which is at most a couple of seconds old while the lane is calling. */
  readonly paused: boolean;
  /** A slice is running. */
  readonly busy: boolean;
  /**
   * Claims batches back to back until one comes back empty or about ten
   * seconds have passed. A second call while one runs gets the running one,
   * and once the runner has stopped it settles with an error even if a stuck
   * handler is still holding its batch.
   */
  runSlice: () => Promise<StageSlice>;
  /** Whether a claim would find anything, without claiming it. */
  hasWork: () => Promise<boolean>;
  /** What a claim that found nothing would have done: the stall watch, the config read, the idle hook. */
  idle: () => Promise<void>;
  /** Stops new slices and waits a bounded time for in-flight assets to drain. */
  stop: () => Promise<void>;
}

/** Keeps a draining backlog from re-reading the row on every batch; pause latency stays ≤ ~2 s. */
const CONFIG_RELOAD_INTERVAL_MS = 2000;

/** A slice gives way after this long so the workflow's history records progress; a batch is never cut short. */
const SLICE_MS = 10_000;

/** A handler that ignores its abort signal cannot hold up shutdown for longer than this. */
const DRAIN_MS = 30_000;

export class StageStoppedError extends Error {
  override name = 'StageStoppedError';
  constructor(stage: string) {
    super(`The ${stage} stage is shutting down`);
  }
}

/** Only tests shorten these. */
export interface RunStageOptions {
  sliceMs?: number;
  drainMs?: number;
}

/**
 * Boot a stage in the current process: seed or load its config, re-queue
 * everything below a new target version, and publish it to `stageRegistry`.
 * Nothing runs until the lane calls the returned handle.
 */
export async function runStage<TPatch>(
  stage: StageConfig<TPatch>,
  options: RunStageOptions = {},
): Promise<RunStageHandle> {
  const log = childLogger(`workers:${stage.name}`);
  const repo = new WorkerConfigRepo();
  const generic = stage as unknown as StageConfig;
  const deps = resolveStageDeps(stage.dependsOn);

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
  const stallWatch = new StallWatch(
    () => (config.stallAfterMinutes ?? DEFAULT_STALL_AFTER_MINUTES) * 60_000,
  );
  const inFlightSet = new Set<string>();
  const abortController = new AbortController();

  stageRegistry.register(stage.name, {
    targetVersion: stage.targetVersion,
    dependsOn: deps,
    getInFlight: () => inFlightSet.size,
    getThroughput: () => throughput.countInWindow(),
    getPaused: () => config.paused,
    getStalledForMs: () => stallWatch.stalledForMs(inFlightSet.size),
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
  let lastConfigReadAt = 0;
  let slice: Promise<StageSlice> | null = null;
  let idling: Promise<void> | null = null;
  const stopped = Promise.withResolvers<never>();
  stopped.promise.catch(() => {});

  /** Best-effort: a failing read keeps the previous config. */
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

  /** Skipped while paused, which would otherwise read as an idle edge on every call. */
  const notifyProgress = async (processed: number): Promise<void> => {
    if (!stage.onProgress || config.paused) return;
    try {
      await stage.onProgress(processed, processed === 0);
    } catch (hookErr) {
      const msg = hookErr instanceof Error ? hookErr.message : String(hookErr);
      log.warn({ err: hookErr, msg }, `${stage.name} onProgress hook threw`);
    }
  };

  const runBatch = async (): Promise<number> => {
    stallWatch.polled();
    try {
      const processed = await runOnce(
        generic,
        config,
        deps,
        abortController.signal,
        inFlightSet,
        throughput,
        undefined,
        stallWatch,
      );
      stageRegistry.clearError(stage.name);
      await notifyProgress(processed);
      return processed;
    } catch (err) {
      stageRegistry.recordError(stage.name, err instanceof Error ? err.message : String(err));
      log.error({ err }, `${stage.name} batch error`);
      throw err;
    }
  };

  const batchesUntil = async (deadline: number, claimed: number): Promise<StageSlice> => {
    const processed = await runBatch();
    const total = claimed + processed;
    if (processed === 0) return { claimed: total, drained: true };
    if (shuttingDown || Date.now() >= deadline) return { claimed: total, drained: false };
    return batchesUntil(deadline, total);
  };

  const startSlice = async (): Promise<StageSlice> => {
    await idling;
    await reloadConfigIfDue();
    return batchesUntil(Date.now() + (options.sliceMs ?? SLICE_MS), 0);
  };

  const runSlice = (): Promise<StageSlice> => {
    if (shuttingDown) return Promise.reject(new StageStoppedError(stage.name));
    slice ??= startSlice().finally(() => {
      slice = null;
    });
    return Promise.race([slice, stopped.promise]);
  };

  const idleOnce = async (): Promise<void> => {
    stallWatch.polled();
    await reloadConfigIfDue();
    await notifyProgress(0);
  };

  const idle = (): Promise<void> => {
    if (shuttingDown || slice !== null) return Promise.resolve();
    idling ??= idleOnce().finally(() => {
      idling = null;
    });
    return idling;
  };

  const hasWork = (): Promise<boolean> =>
    stageHasWork({
      stage: stage.name,
      targetVersion: stage.targetVersion,
      dependsOn: deps,
      inFlight: inFlightSet,
      residual: stage.claimResidual,
    });

  /** Bounded, so a handler that ignores its abort signal cannot hold shutdown, or Temporal's drain, open. */
  const drainSlice = async (): Promise<void> => {
    const settled = slice?.then(
      () => {},
      () => {},
    );
    if (settled === undefined) return;
    const timeout = new AbortController();
    await Promise.race([
      settled,
      sleep(options.drainMs ?? DRAIN_MS, undefined, { signal: timeout.signal }).catch(() => {}),
    ]);
    timeout.abort();
  };

  const stop = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`${stage.name} shutting down — draining`);
    abortController.abort();
    await drainSlice();
    stopped.reject(new StageStoppedError(stage.name));
    stageRegistry.unregister(stage.name);
    log.info(`${stage.name} shut down`);
  };

  return {
    name: stage.name,
    get paused() {
      return config.paused;
    },
    get busy() {
      return slice !== null;
    },
    runSlice,
    hasWork,
    idle,
    stop,
  };
}

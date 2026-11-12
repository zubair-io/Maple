/**
 * Persisted pause/resume and status for the maintenance workers that are NOT
 * `runStage()` stages — deduplicate, missing-reaper, migration.
 *
 * Their passes run as Temporal maintenance tasks (`workers/maintenance/`), so
 * no loop of their own keeps their paused flag fresh. Each one still appears
 * on Settings → Workers through the in-process `stageRegistry`: the entry
 * reports a pass as in flight while it runs, counts what passes processed for
 * throughput, and re-reads the stored `worker_config.<name>.paused` whenever
 * the status is read, at most every couple of seconds. What differs per
 * worker — the value used when the stored state can't be read, the first-boot
 * default, and the exact log lines — is passed in.
 */

import type { Logger } from 'pino';
import { stageRegistry } from './registry.ts';
import { ThroughputWindow } from './throughput-window.ts';
import { WorkerConfigRepo } from '../db/repos/worker-config.repo.ts';

const STATUS_REFRESH_MS = 2_000;

export interface PausableWorkerOptions {
  /** Registry / `worker_config` key, e.g. `deduplicate`. */
  name: string;
  log: Logger;
  /** Answered when the stored state can't be read. A worker whose pass is
   * destructive uses `true`, so a config-store blip can't run it against an
   * operator's prior pause. */
  unreadablePaused: boolean;
  /** Adopted when `worker_config` has no row for this worker yet (first
   * boot) — `true` makes the worker opt-in. */
  defaultPaused: boolean;
  messages: {
    /** Logged at `warn` when the persisted state can't be read. */
    loadFailed: string;
    /** Logged at `info` after a pause has been applied and persisted. */
    paused: string;
    /** Logged at `resumedLevel` after a resume has been applied and persisted. */
    resumed: string;
  };
  /** `warn` for workers whose resume unlocks a destructive pass. */
  resumedLevel: 'info' | 'warn';
}

/** What one pass did: how many items count toward throughput, and a problem to show on the Workers page. */
export interface PassOutcome {
  processed: number;
  problem?: string;
}

export interface RegisteredWorker {
  /** Resolves once the stored pause state has been adopted. */
  readonly ready: Promise<void>;
  stop: () => void;
}

export interface PausableWorker {
  readPaused: () => Promise<boolean>;
  /** Puts the worker on Settings → Workers until `stop()`. */
  register: () => RegisteredWorker;
  /** Runs one pass in view of the status entry; a crash is recorded, logged and rethrown. */
  runPass: (pass: () => Promise<PassOutcome>) => Promise<void>;
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export function pausableWorker(opts: PausableWorkerOptions): PausableWorker {
  const { name, log, messages } = opts;
  const repo = new WorkerConfigRepo();
  const throughput = new ThroughputWindow();
  const state = { paused: opts.unreadablePaused, inFlight: 0, refreshedAt: 0 };

  const readPaused = async (): Promise<boolean> => {
    try {
      return (await repo.load(name))?.paused ?? opts.defaultPaused;
    } catch (err) {
      log.warn({ err: errorText(err) }, messages.loadFailed);
      return opts.unreadablePaused;
    }
  };
  const adoptStored = async (): Promise<void> => {
    state.refreshedAt = Date.now();
    state.paused = await readPaused();
  };
  const persistPaused = async (value: boolean): Promise<void> => {
    state.paused = value;
    state.refreshedAt = Date.now();
    await repo.patch(name, { paused: value }).catch(() => {});
  };

  const register = (): RegisteredWorker => {
    stageRegistry.register(name, {
      targetVersion: 1,
      dependsOn: [],
      getInFlight: () => state.inFlight,
      getThroughput: () => throughput.countInWindow(),
      getPaused: () => {
        if (Date.now() - state.refreshedAt >= STATUS_REFRESH_MS) void adoptStored();
        return state.paused;
      },
      reloadConfig: adoptStored,
      pause: async () => {
        await persistPaused(true);
        log.info(messages.paused);
      },
      resume: async () => {
        await persistPaused(false);
        log[opts.resumedLevel](messages.resumed);
      },
    });
    return { ready: adoptStored(), stop: () => stageRegistry.unregister(name) };
  };

  const runPass = async (pass: () => Promise<PassOutcome>): Promise<void> => {
    state.inFlight += 1;
    try {
      const outcome = await pass();
      const now = new Date();
      for (let i = 0; i < outcome.processed; i++) throughput.record(now);
      if (outcome.problem) stageRegistry.recordError(name, outcome.problem);
      else stageRegistry.clearError(name);
    } catch (err) {
      stageRegistry.recordError(name, errorText(err));
      log.error({ err }, `${name} pass crashed`);
      throw err;
    } finally {
      state.inFlight -= 1;
    }
  };

  return { readPaused, register, runPass };
}

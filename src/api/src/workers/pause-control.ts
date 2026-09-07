/**
 * Persisted pause/resume control for the interval workers that are NOT
 * `runStage()` stages — deduplicate, missing-reaper, migration.
 *
 * Each of those workers keeps a `paused` flag in memory, adopts the stored
 * `worker_config.<name>.paused` shortly after boot, persists every
 * pause/resume so the operator's choice sticks across restarts, and
 * registers itself into the in-process `stageRegistry` so the standard
 * `/api/workers/:name/{status,pause,resume}` surface drives it. That
 * boilerplate was copied verbatim into all three (#1988); this is the one
 * copy. What differs per worker — the in-memory value before the store has
 * been read, the first-boot default, and the exact log lines — is passed in.
 *
 * The tick loop stays in the worker: it refreshes `paused` from the
 * cross-process poller (`paused-poller.ts`) and decides what a paused tick
 * means (skip entirely, or run the non-destructive half of the pass).
 */

import type { Logger } from 'pino';
import { stageRegistry } from './registry.ts';
import { WorkerConfigRepo, type WorkerConfigDoc } from './worker-config.repo.ts';

export interface PausableWorkerOptions {
  /** Registry / `worker_config` key, e.g. `deduplicate`. */
  name: string;
  log: Logger;
  /** In-memory value until the persisted state has been read. A worker
   * whose pass is destructive starts `true` so a config-store blip on boot
   * can't run it against an operator's prior pause. */
  initialPaused: boolean;
  /** Adopted when `worker_config` has no row for this worker yet (first
   * boot) — `true` makes the worker opt-in. */
  defaultPaused: boolean;
  getInFlight: () => number;
  getThroughput: () => number;
  messages: {
    /** Logged at `warn` when the persisted state can't be read; the
     * in-memory value is left as-is. */
    loadFailed: string;
    /** Logged at `info` after a pause has been applied and persisted. */
    paused: string;
    /** Logged at `resumedLevel` after a resume has been applied and persisted. */
    resumed: string;
  };
  /** `warn` for workers whose resume unlocks a destructive pass. */
  resumedLevel: 'info' | 'warn';
}

export interface WorkerPauseControl {
  /** Live in-memory paused flag. Written by pause/resume/reload here and
   * refreshed by the worker's own tick loop from the cross-process poller. */
  paused: boolean;
  /** Resolves once the persisted state has been adopted (or the read failed
   * and the initial value was kept). */
  readonly ready: Promise<void>;
}

/** Register `opts.name` into the `stageRegistry` with persisted
 * pause/resume, and kick off the first read of the stored state. Must be
 * paired with `stageRegistry.unregister(name)` in the worker's `stop()`. */
export function registerPausableWorker(opts: PausableWorkerOptions): WorkerPauseControl {
  const { name, log, messages } = opts;
  const state = { paused: opts.initialPaused };

  let repoPromise: Promise<WorkerConfigRepo> | null = null;
  const getRepo = (): Promise<WorkerConfigRepo> => {
    if (!repoPromise) {
      repoPromise = (async () => {
        const { getDb } = await import('../db/client.ts');
        const db = await getDb();
        return new WorkerConfigRepo(db.collection<WorkerConfigDoc>('worker_config'));
      })();
    }
    return repoPromise;
  };
  const loadPaused = async (): Promise<void> => {
    try {
      const cfg = await (await getRepo()).load(name);
      state.paused = cfg?.paused ?? opts.defaultPaused;
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : err }, messages.loadFailed);
    }
  };
  const persistPaused = async (value: boolean): Promise<void> => {
    try {
      const r = await getRepo();
      await r.patch(name, { paused: value });
    } catch {
      /* best-effort — in-memory state already applied; next boot re-reads */
    }
  };

  stageRegistry.register(name, {
    targetVersion: 1,
    // Not a claim stage — no upstream dependencies. The /status ready/blocked
    // split (and its buildClaimQuery) is gated to real claim stages anyway.
    dependsOn: [],
    getInFlight: opts.getInFlight,
    getThroughput: opts.getThroughput,
    getPaused: () => state.paused,
    reloadConfig: loadPaused,
    pause: async () => {
      state.paused = true;
      await persistPaused(true);
      log.info(messages.paused);
    },
    resume: async () => {
      state.paused = false;
      await persistPaused(false);
      log[opts.resumedLevel](messages.resumed);
    },
  });

  return Object.assign(state, { ready: loadPaused() });
}

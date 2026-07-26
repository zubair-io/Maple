/**
 * Migration worker — owns a registry of named, one-shot, library-wide
 * migrations (`workers/migration/`), each with its own operator toggle in
 * `/settings/workers`. Flipping a migration on runs it batch-by-batch across the
 * library, reports progress, then idles. Future migrations = add to the
 * registry; this worker is generic.
 *
 * Like `missing-reaper`, it is NOT a per-asset version-claim stage: it runs its
 * own interval loop (not `runStage()`) and registers into the in-process
 * `stageRegistry` so the existing `/api/workers/migration/{status,pause,resume}`
 * surface controls the worker as a whole. Per-migration `enabled` state +
 * progress live in `app_settings._id:"migration"` (`migration-config.repo.ts`);
 * the worker-level `paused` flag lives in `worker_config` like every stage.
 *
 * Started from `workers/maintenance.ts`.
 */

import { child as childLogger } from '../log.ts';
import { stageRegistry } from './registry.ts';
import { ThroughputWindow } from './run-stage.ts';
import { WorkerConfigRepo, type WorkerConfigDoc } from './worker-config.repo.ts';
import { makePausedPoller } from './paused-poller.ts';
import { MIGRATIONS } from './migration/index.ts';
import {
  loadAllMigrationStates,
  loadMigrationState,
  patchMigrationState,
  pruneUnknownMigrationStates,
  defaultMigrationState,
  type MigrationState,
} from './migration-config.repo.ts';

const log = childLogger('migration');

/** Registry / route key. Matches `/api/workers/migration/...`. */
export const MIGRATION_WORKER_NAME = 'migration';

const DEFAULT_INTERVAL_MS = 5_000;
/** Items per migration per tick. Moves are file-I/O heavy, so this is far
 * smaller than the reaper's pure-Mongo batch. */
const DEFAULT_BATCH = 50;

/** Sum of remaining work across all ENABLED migrations — surfaced as the
 * worker's `pending` count in `/api/workers/status`. */
export async function migrationPendingCount(): Promise<number> {
  // Load all per-migration state in ONE read, then only count enabled ones.
  let states: Record<string, MigrationState>;
  try {
    states = await loadAllMigrationStates();
  } catch {
    return 0; // best-effort for the status pill
  }
  let total = 0;
  for (const m of MIGRATIONS) {
    if (!(states[m.id] ?? defaultMigrationState()).enabled) continue;
    try {
      total += await m.countRemaining();
    } catch {
      /* best-effort */
    }
  }
  return total;
}

export interface MigrationHandle {
  stop: () => void;
  /** Resolves once the persisted pause state has been read on boot. Tests await
   * this so they observe the adopted state; production ignores it. */
  ready: Promise<void>;
}

export interface StartMigrationOptions {
  intervalMs?: number;
  batchSize?: number;
}

function resolveBatchSize(migration: Migration, defaultBatchSize: number): number {
  return migration.preferredBatchSize ?? defaultBatchSize;
}

/** Run every enabled, not-yet-done migration for one bounded batch. Returns the
 * total items processed this tick (so the caller can record throughput).
 * Exported for tests; the interval loop calls it each tick. */
export async function runMigrationTickOnce(batchSize: number, nowIso: string): Promise<number> {
  let processedThisTick = 0;
  for (const migration of MIGRATIONS) {
    const state = await loadMigrationState(migration.id);
    if (!state.enabled || state.status === 'done') continue;

    const remainingBefore = await migration.countRemaining();
    if (remainingBefore === 0) {
      // Done → also flip the operator toggle off, so a finished one-shot stops
      // contributing a countRemaining scan to the status pill (migrationPendingCount).
      await patchMigrationState(migration.id, {
        status: 'done',
        enabled: false,
        finished_at: nowIso,
      });
      log.info(
        { migration: migration.id },
        'migration complete — nothing remaining, auto-disabled',
      );
      continue;
    }

    let batch: { processed: number; errors: number };
    try {
      batch = await migration.runBatch(resolveBatchSize(migration, batchSize));
    } catch (err) {
      await patchMigrationState(migration.id, {
        status: 'error',
        last_error: err instanceof Error ? err.message : String(err),
      });
      log.error({ migration: migration.id, err }, 'migration batch crashed');
      continue;
    }

    processedThisTick += batch.processed;
    const remainingAfter = await migration.countRemaining();
    const next: Partial<MigrationState> = {
      processed: state.processed + batch.processed,
      errors: state.errors + batch.errors,
      status: remainingAfter === 0 ? 'done' : 'running',
      // Clear any stale crash message once a batch completes cleanly, so the UI
      // doesn't keep showing an old error after the migration has recovered.
      last_error: null,
    };
    if (remainingAfter === 0) {
      next.finished_at = nowIso;
      // Auto-disable a completed one-shot: stops its countRemaining scan from
      // riding the status pill, and a re-run is then an explicit operator re-enable.
      next.enabled = false;
    }
    await patchMigrationState(migration.id, next);
    log.info(
      { migration: migration.id, ...batch, remaining: remainingAfter },
      'migration batch complete',
    );
  }
  return processedThisTick;
}

/**
 * Start the migration worker's interval loop and register it with the stage
 * registry. Controlled exactly like every other worker — the worker-level
 * paused state persists in `worker_config.paused`. It RUNS by default (the real
 * gate is each migration's own `enabled` toggle, which defaults off), so an
 * idle worker simply does nothing until an operator enables a migration.
 */
export function startMigration(opts: StartMigrationOptions = {}): MigrationHandle {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const batchSize = opts.batchSize ?? DEFAULT_BATCH;

  let paused = false;
  let running = false;
  let stopped = false;
  const throughput = new ThroughputWindow();

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
      const cfg = await (await getRepo()).load(MIGRATION_WORKER_NAME);
      paused = cfg?.paused ?? false;
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : err },
        'migration: could not load persisted pause state — defaulting to running',
      );
    }
  };
  const persistPaused = async (value: boolean): Promise<void> => {
    try {
      const r = await getRepo();
      await r.patch(MIGRATION_WORKER_NAME, { paused: value });
    } catch {
      /* best-effort — in-memory state already applied; next boot re-reads */
    }
  };

  stageRegistry.register(MIGRATION_WORKER_NAME, {
    targetVersion: 1,
    dependsOn: [], // not a claim stage
    getInFlight: () => (running ? 1 : 0),
    getThroughput: () => throughput.countInWindow(),
    getPaused: () => paused,
    reloadConfig: loadPaused,
    pause: async () => {
      paused = true;
      await persistPaused(true);
      log.info('migration worker paused');
    },
    resume: async () => {
      paused = false;
      await persistPaused(false);
      log.info('migration worker resumed');
    },
  });

  const ready = loadPaused();

  // One-time hygiene: drop persisted state for any migration no longer in the
  // registry (e.g. the restructure-backup-* migrations this worker replaced) so
  // `app_settings.migrations` doesn't accumulate dead entries. Best-effort; safe
  // when Mongo is unreachable (the call swallows the error and returns []).
  void pruneUnknownMigrationStates(MIGRATIONS.map((m) => m.id));

  // Throttled cross-process pause poller: re-reads worker_config.paused from
  // Mongo at most once per 2s so a pause written by the API process takes
  // effect without IPC. Shares the same mechanism as missing-reaper.
  const pollPaused = makePausedPoller(MIGRATION_WORKER_NAME, paused);

  const tick = async (): Promise<void> => {
    if (stopped || running) return;
    running = true;
    try {
      // Re-read the paused flag from Mongo each tick (throttled) so a
      // cross-process pause written by the API process takes effect without IPC.
      paused = await pollPaused();
      // `return` here still runs the `finally` block below, so `running` is
      // cleared correctly even when we skip a paused tick.
      if (paused) return;
      const processed = await runMigrationTickOnce(batchSize, new Date().toISOString());
      for (let i = 0; i < processed; i++) throughput.record(new Date());
      stageRegistry.clearError(MIGRATION_WORKER_NAME);
    } catch (err) {
      stageRegistry.recordError(
        MIGRATION_WORKER_NAME,
        err instanceof Error ? err.message : String(err),
      );
      log.error({ err }, 'migration tick crashed');
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, intervalMs);

  log.info({ intervalMs }, 'migration worker started');

  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
      stageRegistry.unregister(MIGRATION_WORKER_NAME);
    },
    ready,
  };
}

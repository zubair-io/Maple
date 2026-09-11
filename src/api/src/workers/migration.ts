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
import { makePausedPoller } from './paused-poller.ts';
import { registerPausableWorker } from './pause-control.ts';
import { MIGRATIONS } from './migration/index.ts';
import {
  MigrationBlockedError,
  type Migration,
  type MigrationBatchResult,
} from './migration/types.ts';
import {
  loadMigrationState,
  patchMigrationState,
  pruneUnknownMigrationStates,
  type MigrationState,
} from './migration-config.repo.ts';

const log = childLogger('migration');

/** Registry / route key. Matches `/api/workers/migration/...`. */
export const MIGRATION_WORKER_NAME = 'migration';

const DEFAULT_INTERVAL_MS = 5_000;
/** Items per migration per tick. Moves are file-I/O heavy, so this is far
 * smaller than the reaper's pure-Mongo batch. */
const DEFAULT_BATCH = 50;

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

/** Persisted `remaining` fields — the Workers page reads these instead of
 * running `countRemaining()` itself (#3491). */
function remainingPatch(remaining: number, nowIso: string): Partial<MigrationState> {
  return { remaining, remaining_at: nowIso };
}

async function markMigrationDone(migration: Migration, nowIso: string): Promise<void> {
  await patchMigrationState(migration.id, {
    status: 'done',
    enabled: false,
    finished_at: nowIso,
    ...remainingPatch(0, nowIso),
  });
  log.info({ migration: migration.id }, 'migration complete — nothing remaining, auto-disabled');
}

async function runMigrationBatchSafely(
  migration: Migration,
  batchSize: number,
): Promise<MigrationBatchResult | null> {
  try {
    return await migration.runBatch(resolveBatchSize(migration, batchSize));
  } catch (error) {
    await patchMigrationState(migration.id, {
      status: 'error',
      ...(error instanceof MigrationBlockedError ? { enabled: false } : {}),
      last_error: error instanceof Error ? error.message : String(error),
    });
    log.error({ migration: migration.id, err: error }, 'migration batch crashed');
    return null;
  }
}

async function remainingAfterBatch(
  migration: Migration,
  batch: MigrationBatchResult,
): Promise<number> {
  if (migration.selfReportsCompletion && batch.complete === true) return 0;
  return migration.countRemaining();
}

/** Count outstanding work before a batch and persist it (#3491). Null for
 * cursor-backed migrations, which self-report completion instead. */
async function countRemainingBefore(migration: Migration, nowIso: string): Promise<number | null> {
  if (migration.selfReportsCompletion) return null;
  const remaining = await migration.countRemaining();
  if (remaining > 0) await patchMigrationState(migration.id, remainingPatch(remaining, nowIso));
  return remaining;
}

async function recordBatch(
  migration: Migration,
  state: MigrationState,
  batch: MigrationBatchResult,
  remaining: number,
  nowIso: string,
): Promise<void> {
  const complete = remaining === 0;
  await patchMigrationState(migration.id, {
    processed: state.processed + batch.processed,
    errors: state.errors + batch.errors,
    status: complete ? 'done' : 'running',
    last_error: null,
    ...remainingPatch(remaining, nowIso),
    ...(complete ? { enabled: false, finished_at: nowIso } : {}),
  });
  log.info({ migration: migration.id, ...batch, remaining }, 'migration batch complete');
}

async function runMigrationOnce(
  migration: Migration,
  batchSize: number,
  nowIso: string,
): Promise<number> {
  const state = await loadMigrationState(migration.id);
  if (!state.enabled || state.status === 'done') return 0;

  if ((await countRemainingBefore(migration, nowIso)) === 0) {
    await markMigrationDone(migration, nowIso);
    return 0;
  }

  const batch = await runMigrationBatchSafely(migration, batchSize);
  if (!batch) return 0;
  await recordBatch(migration, state, batch, await remainingAfterBatch(migration, batch), nowIso);
  return batch.processed;
}

export async function runMigrationTickOnce(batchSize: number, nowIso: string): Promise<number> {
  let processedThisTick = 0;
  for (const migration of MIGRATIONS) {
    processedThisTick += await runMigrationOnce(migration, batchSize, nowIso);
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

  let running = false;
  let stopped = false;
  const throughput = new ThroughputWindow();

  const control = registerPausableWorker({
    name: MIGRATION_WORKER_NAME,
    log,
    initialPaused: false,
    defaultPaused: false,
    getInFlight: () => (running ? 1 : 0),
    getThroughput: () => throughput.countInWindow(),
    messages: {
      loadFailed: 'migration: could not load persisted pause state — defaulting to running',
      paused: 'migration worker paused',
      resumed: 'migration worker resumed',
    },
    resumedLevel: 'info',
  });
  const { ready } = control;

  // One-time hygiene: drop persisted state for any migration no longer in the
  // registry (e.g. the restructure-backup-* migrations this worker replaced) so
  // `app_settings.migrations` doesn't accumulate dead entries. Best-effort; safe
  // when Mongo is unreachable (the call swallows the error and returns []).
  void pruneUnknownMigrationStates(MIGRATIONS.map((m) => m.id));

  // Throttled cross-process pause poller: re-reads worker_config.paused from
  // Mongo at most once per 2s so a pause written by the API process takes
  // effect without IPC. Shares the same mechanism as missing-reaper.
  const pollPaused = makePausedPoller(MIGRATION_WORKER_NAME, control.paused);

  const tick = async (): Promise<void> => {
    if (stopped || running) return;
    running = true;
    try {
      // Re-read the paused flag from Mongo each tick (throttled) so a
      // cross-process pause written by the API process takes effect without IPC.
      control.paused = await pollPaused();
      // `return` here still runs the `finally` block below, so `running` is
      // cleared correctly even when we skip a paused tick.
      if (control.paused) return;
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

/**
 * Migration worker — owns a registry of named, one-shot, library-wide
 * migrations (`workers/migration/`), each with its own operator toggle in
 * `/settings/workers`. Flipping a migration on runs it batch-by-batch across the
 * library, reports progress, then idles. Future migrations = add to the
 * registry; this worker is generic.
 *
 * Like `missing-reaper`, it is NOT a per-asset version-claim stage: its passes
 * run every five seconds as the `migration` maintenance task
 * (`workers/maintenance/`), paused whenever no enabled migration is left to
 * run, and it registers into the in-process
 * `stageRegistry` so the existing `/api/workers/migration/{status,pause,resume}`
 * surface controls the worker as a whole. Per-migration `enabled` state +
 * progress live in `app_settings._id:"migration"` (`migration-config.repo.ts`);
 * the worker-level `paused` flag lives in `worker_config` like every stage.
 */

import { child as childLogger } from '../log.ts';
import { pausableWorker, type RegisteredWorker } from './pause-control.ts';
import { MIGRATIONS } from './migration/index.ts';
import {
  MigrationBlockedError,
  type Migration,
  type MigrationBatchResult,
} from './migration/types.ts';
import {
  loadAllMigrationStates,
  loadMigrationState,
  patchMigrationState,
  pruneUnknownMigrationStates,
  type MigrationState,
} from './migration-config.repo.ts';

const log = childLogger('migration');

/** Registry / route key. Matches `/api/workers/migration/...`. */
export const MIGRATION_WORKER_NAME = 'migration';

/** Items per migration per pass. Moves are file-I/O heavy, so this is far
 * smaller than the reaper's pure-Mongo batch. */
const DEFAULT_BATCH = 50;

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

const migrationWorker = pausableWorker({
  name: MIGRATION_WORKER_NAME,
  log,
  unreadablePaused: false,
  defaultPaused: false,
  messages: {
    loadFailed: 'migration: could not load persisted pause state — defaulting to running',
    paused: 'migration worker paused',
    resumed: 'migration worker resumed',
  },
  resumedLevel: 'info',
});

/**
 * Puts the worker on Settings → Workers. It runs by default: the real gate is
 * each migration's own `enabled` toggle, which defaults off. Registering also
 * drops persisted state for migrations no longer in the registry, so
 * `app_settings.migrations` doesn't accumulate dead entries.
 */
export function registerMigration(): RegisteredWorker {
  void pruneUnknownMigrationStates(MIGRATIONS.map((m) => m.id));
  return migrationWorker.register();
}

/** Whether a pass has anything to do: the worker is running and some enabled migration has not finished. */
export async function migrationHasWork(): Promise<boolean> {
  if (await migrationWorker.readPaused()) return false;
  const states = await loadAllMigrationStates();
  return MIGRATIONS.some((m) => {
    const state = states[m.id];
    return state?.enabled === true && state.status !== 'done';
  });
}

/** One scheduled pass: a batch of every enabled migration, unless the worker is paused. */
export async function runMigrationPass(batchSize = DEFAULT_BATCH): Promise<void> {
  await migrationWorker.runPass(async () => {
    if (await migrationWorker.readPaused()) return { processed: 0 };
    return { processed: await runMigrationTickOnce(batchSize, new Date().toISOString()) };
  });
}

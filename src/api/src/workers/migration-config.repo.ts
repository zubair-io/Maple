/**
 * Persisted migration state. One document in `app_settings` keyed by
 * `_id: "migration"`, mirroring `missing-reaper-config.repo.ts`.
 *
 * The migration WORKER's pause/concurrency live in `worker_config` (the
 * standard surface, name `"migration"`). This doc holds the per-migration
 * registry state: the operator `enabled` toggle plus progress bookkeeping.
 *
 *   {
 *     _id: "migration",
 *     migrations: {
 *       "refile-backups": {
 *         enabled, status, processed, errors, last_error,
 *         started_at, finished_at
 *       }
 *     }
 *   }
 *
 * Done-detection is count-based (see the registry's `countRemaining()`), never
 * the `processed` counter — so a re-run after new data appears just works.
 */

import { getDb } from '../db/client.ts';
import { child as childLogger } from '../log.ts';
import { BACKFILL_MEILISEARCH_VECTORS_ID } from './migration/ids.ts';

const COLL = 'app_settings';
const DOC_ID = 'migration';
const log = childLogger('migration:config');

export type MigrationStatus = 'idle' | 'running' | 'done' | 'error';

export interface MigrationState {
  /** Operator toggle. A migration only runs while this is true. */
  enabled: boolean;
  status: MigrationStatus;
  /** Items moved/deduped since the migration was last enabled (cumulative). */
  processed: number;
  /** Items that errored during the current run (cumulative). */
  errors: number;
  last_error: string | null;
  /** ISO timestamp the migration was last enabled. */
  started_at: string | null;
  /** ISO timestamp the migration last reached `done`. */
  finished_at: string | null;
}

interface MigrationDoc {
  _id: string;
  migrations?: Record<string, Partial<MigrationState>>;
}

/** A migration that has never been touched. Disabled, idle, no progress. */
export function defaultMigrationState(): MigrationState {
  return {
    enabled: false,
    status: 'idle',
    processed: 0,
    errors: 0,
    last_error: null,
    started_at: null,
    finished_at: null,
  };
}

/** Merge a stored partial onto the defaults so callers always see every field. */
function hydrate(partial: Partial<MigrationState> | undefined): MigrationState {
  return { ...defaultMigrationState(), ...(partial ?? {}) };
}

/** Load every migration's persisted state, keyed by migration id. Missing
 * doc / DB error → empty map (callers fall back to per-id defaults). */
export async function loadAllMigrationStates(): Promise<Record<string, MigrationState>> {
  try {
    const db = await getDb();
    const doc = await db.collection<MigrationDoc>(COLL).findOne({ _id: DOC_ID });
    const out: Record<string, MigrationState> = {};
    for (const [id, partial] of Object.entries(doc?.migrations ?? {})) {
      out[id] = hydrate(partial);
    }
    return out;
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : err },
      'could not load migration states — treating as defaults',
    );
    return {};
  }
}

/** Load one migration's state, hydrated with defaults for any missing field. */
export async function loadMigrationState(id: string): Promise<MigrationState> {
  const all = await loadAllMigrationStates();
  return all[id] ?? defaultMigrationState();
}

/** Patch a subset of one migration's fields (`migrations.<id>.<field>`). */
export async function patchMigrationState(
  id: string,
  partial: Partial<MigrationState>,
): Promise<void> {
  const set: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(partial)) set[`migrations.${id}.${k}`] = v;
  if (Object.keys(set).length === 0) return;
  const db = await getDb();
  await db
    .collection<MigrationDoc>(COLL)
    .updateOne({ _id: DOC_ID }, { $set: set }, { upsert: true });
}

/**
 * Pure transition for the enable toggle. Enabling arms a fresh run: status →
 * `running`, `started_at` stamped, progress counters cleared. Disabling leaves
 * progress intact (so the UI can still show how far a paused run got) and
 * resets status to `idle` unless it already reached `done`. Extracted for
 * unit testing without a DB.
 */
export function computeEnabledTransition(
  prev: MigrationState,
  enabled: boolean,
  nowIso: string,
): MigrationState {
  return enabled
    ? {
        ...prev,
        enabled: true,
        status: 'running',
        processed: 0,
        errors: 0,
        last_error: null,
        started_at: nowIso,
        finished_at: null,
      }
    : {
        ...prev,
        enabled: false,
        status: prev.status === 'done' ? 'done' : 'idle',
      };
}

/** Flip a migration's `enabled` toggle (see `computeEnabledTransition`) and
 * persist the result. Returns the resulting state. */
export async function setMigrationEnabled(
  id: string,
  enabled: boolean,
  nowIso: string,
): Promise<MigrationState> {
  if (id === BACKFILL_MEILISEARCH_VECTORS_ID && enabled) {
    const { clearMeilisearchBackfillRetryState } =
      await import('../enrichment/meilisearch-backfill.ts');
    await clearMeilisearchBackfillRetryState();
  }
  const next = computeEnabledTransition(await loadMigrationState(id), enabled, nowIso);
  await patchMigrationState(id, next);
  return next;
}

/** Clear a migration back to a pristine disabled/idle state (operator "reset"). */
export async function resetMigrationState(id: string): Promise<MigrationState> {
  if (id === BACKFILL_MEILISEARCH_VECTORS_ID) {
    const { resetMeilisearchBackfillState } = await import('../enrichment/meilisearch-backfill.ts');
    await resetMeilisearchBackfillState();
  }
  const fresh = defaultMigrationState();
  await patchMigrationState(id, fresh);
  return fresh;
}

/**
 * Drop persisted state for migration ids no longer in the registry (a migration
 * removed in code). Keeps `app_settings.migrations` from accumulating dead entries:
 * harmless to the worker/routes — which only ever act on known ids — but stale
 * config otherwise. Idempotent, best-effort; returns the pruned ids. Run once at
 * worker startup with the live registry, so any future removal self-cleans too.
 */
export async function pruneUnknownMigrationStates(knownIds: readonly string[]): Promise<string[]> {
  try {
    const db = await getDb();
    const coll = db.collection<MigrationDoc>(COLL);
    const doc = await coll.findOne({ _id: DOC_ID }, { projection: { migrations: 1 } });
    const known = new Set(knownIds);
    const dead = Object.keys(doc?.migrations ?? {}).filter((id) => !known.has(id));
    if (dead.length === 0) return [];
    const unset: Record<string, ''> = {};
    for (const id of dead) unset[`migrations.${id}`] = '';
    await coll.updateOne({ _id: DOC_ID }, { $unset: unset });
    log.info({ pruned: dead }, 'pruned persisted state for migrations no longer in the registry');
    return dead;
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : err },
      'could not prune unknown migration states',
    );
    return [];
  }
}

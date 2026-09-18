/**
 * Re-arming a pipeline stage for one asset.
 *
 * Three mutations in this repository reset a stage as part of the same write
 * that changes something the stage's output depends on: the two metadata
 * overrides re-arm `meili` so the search document is rebuilt, and both trash
 * workflows re-arm `meili` plus the two path-keyed raster caches because
 * moving a file into or out of `.maple/trash/` is a relocate. The Mongo
 * originals are `MEILI_REARM_SET` (`people/people-search-reindex.ts`) and
 * `relocateCacheStageResetSet` (`db/relocate-cache-reset.ts`); the field lists
 * below mirror them exactly, including the one asymmetry — the meili re-arm
 * clears `processed_at` and the cache re-arm does not.
 *
 * ## Why an upsert and not an update
 *
 * `$set: { 'stages.meili.version': 0 }` creates the subdocument when it is
 * missing, so on Mongo a re-arm always lands. Stage rows here are seeded when
 * an asset is created, so the row normally exists — but "normally" is exactly
 * the assumption that produced #2177, where a stage silently never re-armed
 * because its bookkeeping was absent. `ON CONFLICT … DO UPDATE` makes the
 * write unconditional, and the `SELECT … FROM assets WHERE id = ?` source
 * keeps it from inserting a row for an asset that does not exist, which the
 * foreign key would reject and which would roll the whole transaction back.
 */

import type { SqlStatement } from '../protocol.ts';

/** The search-index stage: re-armed whenever an asset's indexed text changes. */
export const MEILI_STAGE = 'meili';

/**
 * The path-keyed raster caches. A relocate invalidates both, because their
 * cache key is derived from the file's path — see `docs/caching.md`. The
 * expensive per-image stages (describe / face / geocode) are deliberately not
 * in this list: the pixels did not change.
 */
export const RELOCATE_CACHE_STAGES = ['thumb', 'preview'] as const;

const REARM_INSERT = `
  INSERT INTO stage_state (asset_id, stage, version, attempts, last_error, processed_at, dead)
  SELECT id, ?, 0, 0, NULL, NULL, 0 FROM assets WHERE id = ?
  ON CONFLICT (asset_id, stage) DO UPDATE SET`;

const REARM_WITH_PROCESSED_AT = `${REARM_INSERT}
    version = 0, attempts = 0, last_error = NULL, processed_at = NULL, dead = 0`;

const REARM_KEEPING_PROCESSED_AT = `${REARM_INSERT}
    version = 0, attempts = 0, last_error = NULL, dead = 0`;

/**
 * Re-arm `meili` for one asset: version back to zero, retry bookkeeping and
 * `processed_at` cleared, dead-letter flag lifted.
 */
export function meiliRearmStatement(assetId: string): SqlStatement {
  return { sql: REARM_WITH_PROCESSED_AT, params: [MEILI_STAGE, assetId] };
}

/**
 * Re-arm the two path-keyed cache stages for one asset. `processed_at` is left
 * alone, matching the Mongo fragment this replaces.
 */
export function relocateCacheRearmStatements(assetId: string): SqlStatement[] {
  return RELOCATE_CACHE_STAGES.map((stage) => ({
    sql: REARM_KEEPING_PROCESSED_AT,
    params: [stage, assetId],
  }));
}

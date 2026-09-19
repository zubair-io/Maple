/**
 * Re-arming a pipeline stage for one asset.
 *
 * Three mutations in this repository reset a stage as part of the same write
 * that changes something the stage's output depends on: the two metadata
 * overrides re-arm `meili` so the search document is rebuilt, and both trash
 * workflows re-arm `meili` plus the two path-keyed raster caches because
 * moving a file into or out of `.maple/trash/` is a relocate. The Mongo
 * originals were `MEILI_REARM_SET` and `relocateCacheStageResetSet`
 * (`db/relocate-cache-reset.ts`, and a people module now deleted); the lists
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

import type { SqlStatement } from '../sqlite/protocol.ts';

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

/**
 * Re-arm an arbitrary list of stages for one asset — the full five-field reset
 * (`version`, `attempts`, `last_error`, `processed_at`, `dead`).
 *
 * This is what the operator-visible data migrations need. Each of them re-queues
 * a different handful of stages — `rearm-video-posters` takes six,
 * `clear-video-screenshot-flags` two, `apply-video-geo-backfill` one — and the
 * Mongo originals spelled the same five `$set` paths per stage by hand, in four
 * separate copies (a stage-config helper, `reArmCacheStages` in
 * `workers/dedupe.helpers.ts`, and one inline block per migration). Resetting `version` alone is the mistake those copies exist to
 * prevent: an asset that previously dead-lettered would stay `dead = 1` and
 * never be claimed again, and a stale `last_error` would keep showing on
 * Settings → Workers for a stage that is about to be retried clean.
 *
 * Takes stage names as data rather than a closed union because the caller's
 * list is already a `const` tuple it owns, and an unknown name here is a row
 * that is inserted and never claimed rather than a statement that misbehaves.
 */
export function stageRearmStatements(assetId: string, stages: readonly string[]): SqlStatement[] {
  return stages.map((stage) => ({ sql: REARM_WITH_PROCESSED_AT, params: [stage, assetId] }));
}

/**
 * The same five-field re-arm for a whole batch of assets at once, as one
 * statement per stage rather than one per (asset, stage) pair.
 *
 * The batch writers need this: a `.hidden` marker dropped on a directory of ten
 * thousand photos, or a migration's thousand-row sweep, would otherwise send
 * ten thousand statements through a single transaction to express one set
 * operation. `SELECT a.id FROM assets a WHERE a.id IN (…)` is also what keeps
 * the insert branch from being rejected by the foreign key when an id in the
 * list has been deleted since the caller read it.
 *
 * `guard` narrows that source further, and exists for the one caller that has
 * to re-assert its candidate predicate at write time: a row a worker re-stamped
 * between the migration's read and its write must not have that fresh state
 * reset. It is written against the alias `a`, so a guard reads the same here as
 * it does in the accompanying `UPDATE assets AS a`.
 */
export function stageRearmBatchStatement(
  assetIds: readonly string[],
  stage: string,
  guard?: { sql: string; params?: readonly (string | number)[] },
): SqlStatement {
  const list = assetIds.map(() => '?').join(', ');
  const also = guard === undefined ? '' : ` AND (${guard.sql})`;
  return {
    sql: `
      INSERT INTO stage_state (asset_id, stage, version, attempts, last_error, processed_at, dead)
      SELECT a.id, ?, 0, 0, NULL, NULL, 0 FROM assets a WHERE a.id IN (${list})${also}
      ON CONFLICT (asset_id, stage) DO UPDATE SET
        version = 0, attempts = 0, last_error = NULL, processed_at = NULL, dead = 0`,
    params: [stage, ...assetIds, ...(guard?.params ?? [])],
  };
}

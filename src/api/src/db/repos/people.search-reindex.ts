/**
 * Re-index trigger for person-name search (#3749).
 *
 * The meili stage folds each asset's named people into its search document, so
 * those tokens go stale the moment a person is renamed, merged, reassigned or
 * hidden. Rather than duplicate the stage's upsert logic, the affected assets'
 * `meili` stage version is reset to zero and the worker re-claims them on its
 * next tick — the same trick the Mongo original plays, against `stage_state`
 * instead of a `stages.meili` subdocument.
 *
 * ## One statement, not one per asset
 *
 * The Mongo version is a single `updateMany` keyed on `faces.person_id`, and
 * the point of it is that renaming a person with 4,000 photos is one round trip.
 * `meiliRearmStatement` in `assets.stage-rearm.ts` re-arms a named asset and is
 * the right tool for a single-asset mutation, but building 4,000 of those would
 * turn one write into 4,000 messages through the pool's writer. So the person-
 * wide form stays set-based: the `SELECT` feeding the upsert is the join that
 * used to be the `$in` filter.
 *
 * `ON CONFLICT … DO UPDATE` rather than a plain `UPDATE` for the reason
 * `assets.stage-rearm.ts` gives: a missing stage row must still re-arm, because
 * assuming it is there is what produced #2177.
 */

import type { ObjectId } from '../object-id.ts';
import { child as childLogger } from '../../log.ts';
import { peopleDb, type SqliteDb } from './db-handle.ts';
import { MEILI_STAGE } from './assets.stage-rearm.ts';
import { placeholders } from './values.ts';

const log = childLogger('people:search-reindex:sqlite');

const REARM_TAIL = `
  ON CONFLICT (asset_id, stage) DO UPDATE SET
    version = 0, attempts = 0, last_error = NULL, processed_at = NULL, dead = 0`;

/** Every asset carrying a face assigned to one of these people. */
function rearmByPersonSql(count: number): string {
  return `INSERT INTO stage_state
            (asset_id, stage, version, attempts, last_error, processed_at, dead)
          SELECT DISTINCT asset_id, ?, 0, 0, NULL, NULL, 0
            FROM faces WHERE person_id IN (${placeholders(count)})
          ${REARM_TAIL}`;
}

/** Named assets. The `SELECT … FROM assets` keeps an unknown id from inserting. */
function rearmByAssetSql(count: number): string {
  return `INSERT INTO stage_state
            (asset_id, stage, version, attempts, last_error, processed_at, dead)
          SELECT id, ?, 0, 0, NULL, NULL, 0
            FROM assets WHERE id IN (${placeholders(count)})
          ${REARM_TAIL}`;
}

/** Distinct, non-empty lowercase hex ids. */
function hexIds(ids: ReadonlyArray<ObjectId | string>): string[] {
  return [
    ...new Set(
      ids
        .map((id) => (typeof id === 'string' ? id : id.toHexString()))
        .filter((id) => id.length > 0),
    ),
  ];
}

/**
 * Re-arm `meili` on every asset holding a face assigned to one of `personIds`.
 * No-op when the list is empty. Returns the number of stage rows written.
 */
export async function markAssetsForMeiliReindex(
  personIds: Array<ObjectId | string>,
  dbOverride?: SqliteDb,
): Promise<number> {
  const ids = hexIds(personIds);
  if (ids.length === 0) return 0;
  const db = peopleDb(dbOverride);
  const result = await db.write(rearmByPersonSql(ids.length), [MEILI_STAGE, ...ids]);
  return result.changes;
}

/**
 * Fire-and-forget wrapper: a search-index hiccup must never fail the people
 * mutation that triggered it.
 */
export function markAssetsForMeiliReindexBestEffort(
  personIds: Array<ObjectId | string>,
  dbOverride?: SqliteDb,
): void {
  void markAssetsForMeiliReindex(personIds, dbOverride).catch((err) => {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'failed to mark assets for meili reindex',
    );
  });
}

/**
 * Like {@link markAssetsForMeiliReindex} but targets assets by id — used by the
 * single-asset face mutations and by clustering, which already know exactly
 * which assets changed. Re-arming a whole person's corpus there would re-queue
 * thousands of unchanged assets.
 */
export async function markAssetIdsForMeiliReindex(
  assetIds: ObjectId[],
  dbOverride?: SqliteDb,
): Promise<number> {
  const ids = hexIds(assetIds);
  if (ids.length === 0) return 0;
  const db = peopleDb(dbOverride);
  const result = await db.write(rearmByAssetSql(ids.length), [MEILI_STAGE, ...ids]);
  return result.changes;
}

/** Fire-and-forget wrapper for {@link markAssetIdsForMeiliReindex}. */
export function markAssetIdsForMeiliReindexBestEffort(
  assetIds: ObjectId[],
  dbOverride?: SqliteDb,
): void {
  void markAssetIdsForMeiliReindex(assetIds, dbOverride).catch((err) => {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'failed to mark assets for meili reindex',
    );
  });
}

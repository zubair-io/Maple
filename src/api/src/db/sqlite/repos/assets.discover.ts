/**
 * The discover producer's per-event verbs against `assets` and
 * `asset_locations` — the SQLite port of what `workers/discover/handle-event.ts`
 * used to spell as a Mongo `$elemMatch` over `fileinfo[]` (#3787).
 *
 * Three files make up the producer's storage surface, split by how often each
 * runs: this one is called once per discovered file, `./assets.discover.dedup.ts`
 * holds the content lookup and the insert it decides between, and
 * `./assets.discover.sweep.ts` holds what the sweep reads once per directory.
 *
 * ## A location is a row, so same-entry matching stops being subtle
 *
 * Every function here keys on `(library_id, path, filename)`, which is a UNIQUE
 * index. On Mongo the equivalent was `fileinfo: { $elemMatch: { … } }`, and the
 * difference between that and three dotted paths — conditions satisfied by
 * *different* array entries — was invisible at the call site and got written
 * wrong elsewhere in this repository. Here it cannot be expressed: a directory,
 * a filename and their liveness tags are columns of one row.
 *
 * ## `live_location_count` is not maintained here any more
 *
 * Every write that changes a location's liveness used to be followed by an
 * `updateLiveLocationCount(coll, id)` round trip, and forgetting one was how the
 * column drifted. The triggers in `ddl/asset-locations.ts` derive it now, so the
 * count is correct after each statement below without anyone asking, and
 * {@link tagLocationMissing} reads it back in the same breath to answer "was
 * that the asset's last live location".
 */

import type { ObjectId } from 'mongodb';
import { meiliRearmStatement } from './assets.stage-rearm.ts';
import { sqliteDb, type SqliteDb } from './db-handle.ts';
import { toHex, toObjectId } from './values.ts';

export type { SqliteDb } from './db-handle.ts';

/** A location addressed the way every statement here keys on one. */
export interface LocationKey {
  library_id: ObjectId;
  path: string;
  filename: string;
}

const ASSET_ID_AT_LOCATION_SQL = `
  SELECT asset_id FROM asset_locations
   WHERE library_id = ? AND path = ? AND filename = ?`;

function locationParams(key: LocationKey): [string, string, string] {
  return [toHex(key.library_id), key.path, key.filename];
}

/** The asset holding this location, whatever state the location is in. */
async function assetIdAt(db: SqliteDb, key: LocationKey): Promise<string | null> {
  const rows = await db.read<{ asset_id: string }>(ASSET_ID_AT_LOCATION_SQL, locationParams(key));
  return rows[0]?.asset_id ?? null;
}

/**
 * Tag one vanished location `missing_since` and report whether the asset has
 * any live location left.
 *
 * First detection wins: the `missing_since IS NULL` guard in the statement is
 * the Mongo `arrayFilters` condition, so a re-run of the same `removed` event
 * does not move the clock the missing-reaper's prune window is measured from.
 *
 * Only the vanished location is tagged, never the asset — a deduped asset with
 * copies elsewhere stays visible and claimable on its other entries. That is
 * why the answer is `fullyGone` rather than "deleted": the caller publishes a
 * `delete` to File Provider clients only when no live location survives, and an
 * `update` otherwise. Reading `live_location_count` back after the write is
 * also what makes the answer race-safe against a concurrent re-add, exactly as
 * the second `findOne` did on Mongo.
 *
 * Returns `null` when no row claims the location, which is the caller's "no
 * matching row — skipping".
 */
export async function tagLocationMissing(
  key: LocationKey,
  reason: string,
  at: string,
  dbOverride?: SqliteDb,
): Promise<{ assetId: ObjectId; fullyGone: boolean } | null> {
  const db = sqliteDb(dbOverride);
  const assetId = await assetIdAt(db, key);
  if (assetId === null) return null;
  await db.write(
    `UPDATE asset_locations SET missing_since = ?, missing_reason = ?
      WHERE library_id = ? AND path = ? AND filename = ? AND missing_since IS NULL`,
    [at, reason, ...locationParams(key)],
  );
  const rows = await db.read<{ n: number }>(
    `SELECT live_location_count AS n FROM assets WHERE id = ?`,
    [assetId],
  );
  return { assetId: toObjectId(assetId), fullyGone: (rows[0]?.n ?? 0) === 0 };
}

/**
 * Move a location to a new name in the same library, in place.
 *
 * A rename is not a new location, so the row is rewritten rather than added and
 * the asset's location count is unchanged. The non-live tags are cleared
 * because the renamed file is present: the Mongo version achieved the same
 * thing by overwriting the array element with a freshly built entry that simply
 * had no such keys.
 *
 * `filename` is the highest-weight lexical field in the Meilisearch index, so
 * the `meili` stage is re-armed in the same transaction — a rename that skipped
 * it leaves the search document permanently stale (#2357).
 *
 * Returns the asset, or `null` when nothing holds the old location.
 */
export async function renameLocation(
  from: LocationKey,
  to: { path: string; filename: string },
  indexedAt: string,
  dbOverride?: SqliteDb,
): Promise<ObjectId | null> {
  const db = sqliteDb(dbOverride);
  const assetId = await assetIdAt(db, from);
  if (assetId === null) return null;
  await db.transaction([
    {
      sql: `UPDATE asset_locations
               SET path = ?, filename = ?,
                   deleted_at = NULL, missing_since = NULL, missing_reason = NULL
             WHERE library_id = ? AND path = ? AND filename = ?`,
      params: [to.path, to.filename, ...locationParams(from)],
    },
    {
      sql: `UPDATE assets SET indexed_at = ?, deleted_at = NULL WHERE id = ?`,
      params: [indexedAt, assetId],
    },
    meiliRearmStatement(assetId),
  ]);
  return toObjectId(assetId);
}

/**
 * The asset recorded at this location and the content hash it was indexed with.
 *
 * The caller compares `sha1Head`, never `maple_id`, and the distinction is the
 * whole point of returning it: `maple_id` is rewritten in place by the exif
 * stage, so a mismatch there means "this row has been through the upgrade", not
 * "the file's bytes changed". `sha1_head` is invariant for the row's lifetime.
 */
export async function findAssetAtLocation(
  key: LocationKey,
  dbOverride?: SqliteDb,
): Promise<{ id: ObjectId; sha1Head: string | null } | null> {
  const rows = await sqliteDb(dbOverride).read<{ id: string; sha1_head: string | null }>(
    `SELECT a.id, a.sha1_head FROM assets a
       JOIN asset_locations l ON l.asset_id = a.id
      WHERE l.library_id = ? AND l.path = ? AND l.filename = ?`,
    locationParams(key),
  );
  const row = rows[0];
  return row === undefined ? null : { id: toObjectId(row.id), sha1Head: row.sha1_head };
}

/**
 * Adopt a computed hash onto a legacy row that predates content hashing.
 *
 * A row with no recorded hash carries no evidence that the file's content
 * changed, and treating the absence as a mismatch dual-flagged the present,
 * unchanged file and inserted a duplicate on every subsequent sweep (#2171).
 */
export async function adoptSha1Head(
  id: ObjectId,
  sha1Head: string,
  dbOverride?: SqliteDb,
): Promise<void> {
  await sqliteDb(dbOverride).write(`UPDATE assets SET sha1_head = ? WHERE id = ?`, [
    sha1Head,
    toHex(id),
  ]);
}

/**
 * Hand a location over when the file at it was modified to different content.
 *
 * ## This is a deliberate behaviour change, and the schema forces it
 *
 * The Mongo version *tagged* the entry — `deleted_at` to say this location no
 * longer holds the asset's content, and `missing_since` to park it for the
 * missing-reaper to prune after the cooldown — and left it in the array. It
 * could, because a Mongo unique index over the three fields was only ever
 * enforced when `ensureIndexes` had promoted it, and the promotion is skipped
 * whenever a duplicate already exists.
 *
 * `asset_locations_lib_path_name` is UNIQUE unconditionally and takes no
 * account of liveness, which is the stronger guarantee the schema set out to
 * make: two assets cannot claim the same file. A tagged row still occupies the
 * key, so with the tag-and-keep behaviour the very next statement — inserting
 * the asset for the file's *new* content — is refused by the index and no
 * discovery of a modified file could ever complete.
 *
 * Releasing the row is what "the path changed hands" means when a location is a
 * row. What is lost is the reaper's cooldown and the `content-changed`
 * provenance tag, and neither is load-bearing here: the cooldown exists to
 * protect against a transient `ENOENT` that might resolve itself, and this
 * caller is not guessing — it has read different bytes at that path. The old
 * asset's `live_location_count` falls through the trigger exactly as it would
 * have after the prune, so an asset with a surviving copy elsewhere stays live
 * and one without becomes hidden.
 *
 * The asset row itself is never touched. An original is soft state here: the
 * asset keeps its edits, its rating and its stage history, and only the claim
 * on a path that now holds someone else's bytes goes away.
 */
export async function releaseChangedLocation(
  key: LocationKey,
  dbOverride?: SqliteDb,
): Promise<void> {
  await sqliteDb(dbOverride).write(
    `DELETE FROM asset_locations WHERE library_id = ? AND path = ? AND filename = ?`,
    locationParams(key),
  );
}

/**
 * The discover producer's verbs against `assets` and `asset_locations` — the
 * SQLite port of everything `workers/discover/*` used to spell as a Mongo
 * `$elemMatch` over `fileinfo[]` (#3787).
 *
 * The sweep is the hottest write path in the server: one pass over a library
 * calls in here once per directory and once per discovered file. So the shapes
 * below are the ones the schema was designed around, and three of them are
 * worth knowing about before reading the code.
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
 * Every write in this module that changes a location's liveness used to be
 * followed by an `updateLiveLocationCount(coll, id)` round trip, and forgetting
 * one was how the column drifted. The triggers in `ddl/asset-locations.ts`
 * derive it now, so the count is correct after each statement below without
 * anyone asking, and {@link tagLocationMissing} can read it back in the same
 * breath to answer "was that the asset's last live location".
 *
 * ## The dedup probe is two lookups, and both of them matter
 *
 * {@link findAssetForContent} tries `maple_id` and then falls back to
 * `sha1_head`. That is not belt and braces: the exif stage rewrites `maple_id`
 * in place when it upgrades the fallback id to the primary form, so a duplicate
 * discovered after that upgrade does not match what `hashFileForId` computes
 * and the first lookup misses. `sha1_head` is written once at insert and never
 * rewritten, so it stays a stable join key across the upgrade — without the
 * fallback the second copy inserts a new row that the exif stage then tries to
 * upgrade into the same primary id, which is a unique-index violation.
 */

import { ObjectId } from 'mongodb';
import type { AssetExif, FileInfo } from '../../schema.ts';
import { newObjectIdHex } from '../object-id.ts';
import type { SqlStatement } from '../protocol.ts';
import { meiliRearmStatement, relocateCacheRearmStatements } from './assets.stage-rearm.ts';
import { seedStageRowStatements } from './stage-state.repo.ts';
import { sqliteDb, type SqliteDb } from './db-handle.ts';
import { toBool, toHex, toObjectId } from './values.ts';

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

/** An existing row for the same content, with the locations it already holds. */
export interface AssetForContent {
  id: ObjectId;
  /** Doc-level soft delete. A non-null value means a dedup hit revives the row. */
  deletedAt: string | null;
  locations: LocationKey[];
}

const CONTENT_LOCATIONS_SQL = `
  SELECT library_id, path, filename FROM asset_locations WHERE asset_id = ?`;

async function loadContentRow(
  db: SqliteDb,
  sql: string,
  param: string,
): Promise<AssetForContent | null> {
  const rows = await db.read<{ id: string; deleted_at: string | null }>(sql, [param]);
  const row = rows[0];
  if (row === undefined) return null;
  const locations = await db.read<{ library_id: string; path: string; filename: string }>(
    CONTENT_LOCATIONS_SQL,
    [row.id],
  );
  return {
    id: toObjectId(row.id),
    deletedAt: row.deleted_at,
    locations: locations.map((l) => ({
      library_id: toObjectId(l.library_id),
      path: l.path,
      filename: l.filename,
    })),
  };
}

/**
 * The row already holding this content, by dedup id and then by head hash.
 *
 * Both lookups repeat `IS NOT NULL` after the equality. That is not redundant:
 * `assets_maple_id` and `assets_sha1_head` are partial indexes over exactly
 * that predicate, and SQLite only uses a partial index when the query's own
 * `WHERE` provably implies the index's — which `maple_id = ?` alone does not,
 * because the bound value is unknown at planning time. Without it this becomes
 * a full table scan per discovered file, which is the cost the schema exists to
 * remove.
 */
export async function findAssetForContent(
  mapleId: string,
  sha1Head: string,
  dbOverride?: SqliteDb,
): Promise<AssetForContent | null> {
  const db = sqliteDb(dbOverride);
  const byMapleId = await loadContentRow(
    db,
    `SELECT id, deleted_at FROM assets WHERE maple_id = ? AND maple_id IS NOT NULL`,
    mapleId,
  );
  if (byMapleId !== null) return byMapleId;
  return loadContentRow(
    db,
    `SELECT id, deleted_at FROM assets WHERE sha1_head = ? AND sha1_head IS NOT NULL LIMIT 1`,
    sha1Head,
  );
}

/** The top-level fields every dedup hit refreshes. */
export interface DedupRefresh {
  indexedAt: string;
  mtime: number;
  size: number;
}

/**
 * The stat and liveness refresh a dedup hit applies to the asset itself.
 *
 * `deleted_reason` is cleared alongside `deleted_at` (#2977): a rediscovered
 * content match revives a row the reaper soft-deleted, and leaving the
 * discriminator behind would make a live asset read as reaped.
 */
function refreshAssetStatement(id: string, refresh: DedupRefresh): SqlStatement {
  return {
    sql: `UPDATE assets
             SET indexed_at = ?, deleted_at = NULL, deleted_reason = NULL, mtime = ?, size = ?
           WHERE id = ?`,
    params: [refresh.indexedAt, refresh.mtime, refresh.size, id],
  };
}

/**
 * Record this location on a row that already holds the same content: append it
 * when the row has never seen it, otherwise un-park the entry that is already
 * there. Returns which of the two happened, so the caller can log it.
 *
 * Neither path touches a user-edited field — rating, flag, colour label, the
 * sidecar mirror — because a second copy of a photo appearing on disk is not an
 * edit.
 *
 * **Append is `ON CONFLICT DO NOTHING`, and that replaces a conditional write.**
 * The Mongo version guarded its `$push` with `fileinfo: { $not: { $elemMatch: … } }`
 * so a concurrent worker that had read the same stale row and raced ahead made
 * this a silent no-op rather than a duplicated entry. The UNIQUE index over
 * `(library_id, path, filename)` is that guarantee from the other side, and the
 * conflict clause is what turns the violation back into the same silent no-op.
 *
 * **`keep` is only written on the refresh path when the caller supplies it.**
 * A `.keep` marker can be added or removed after first index, so the ordinary
 * dedup hit rewrites the flag; the race-loser fallback passes `undefined` and
 * leaves it alone, matching its pre-cutover behaviour.
 *
 * **A soft-deleted row re-arms `meili` in the same transaction.** Its search
 * document was tombstoned, so without the re-arm the revived asset stays
 * invisible in search until the next full backfill.
 */
export async function appendOrRefreshLocation(
  existing: AssetForContent,
  entry: LocationKey & { keep: boolean },
  refresh: DedupRefresh,
  keep: boolean | undefined,
  dbOverride?: SqliteDb,
): Promise<'append' | 'refresh'> {
  const db = sqliteDb(dbOverride);
  const id = toHex(existing.id);
  const revive = typeof existing.deletedAt === 'string' ? [meiliRearmStatement(id)] : [];
  const known = existing.locations.some(
    (l) =>
      l.library_id.equals(entry.library_id) &&
      l.path === entry.path &&
      l.filename === entry.filename,
  );

  if (!known) {
    await db.transaction([
      {
        sql: `INSERT INTO asset_locations
                (asset_id, ordinal, library_id, path, filename, keep)
              SELECT ?, COALESCE(MAX(ordinal) + 1, 0), ?, ?, ?, ?
                FROM asset_locations WHERE asset_id = ?
              ON CONFLICT DO NOTHING`,
        params: [id, ...locationParams(entry), entry.keep ? 1 : 0, id],
      },
      refreshAssetStatement(id, refresh),
      ...revive,
    ]);
    return 'append';
  }

  await db.transaction([
    {
      sql: `UPDATE asset_locations
               SET deleted_at = NULL, missing_since = NULL, missing_reason = NULL
                   ${keep === undefined ? '' : ', keep = ?'}
             WHERE library_id = ? AND path = ? AND filename = ?`,
      params: keep === undefined ? locationParams(entry) : [keep ? 1 : 0, ...locationParams(entry)],
    },
    refreshAssetStatement(id, refresh),
    ...revive,
  ]);
  return 'refresh';
}

/** Everything a freshly discovered file needs to become a row. */
export interface DiscoveredAsset {
  entry: LocationKey & { keep: boolean };
  mapleId: string;
  sha1Head: string;
  size: number;
  mtime: number;
  indexedAt: string;
  mediaKind: 'image' | 'video' | 'audio';
  /** Stage names to seed at version 0 — the `blankStagesSkeleton` equivalent. */
  stages: readonly string[];
}

/**
 * Insert a new asset, its first location, and its stage rows in one
 * transaction.
 *
 * All three together, because a location or a stage row for an asset that does
 * not exist is refused by the foreign key, and a half-written asset with no
 * location would violate the invariant that every live asset has at least one.
 *
 * Throws on a dedup-id collision, which is a worker racing this one between the
 * lookup and the insert — see {@link isMapleIdConflict} for the recovery.
 */
export async function insertDiscoveredAsset(
  asset: DiscoveredAsset,
  dbOverride?: SqliteDb,
): Promise<ObjectId> {
  const id = newObjectIdHex();
  await sqliteDb(dbOverride).transaction([
    {
      sql: `INSERT INTO assets
              (id, size, mtime, indexed_at, rating, flag, color_label, media_kind,
               maple_id, sha1_head, deleted_at, exif)
            VALUES (?, ?, ?, ?, 0, 0, '', ?, ?, ?, NULL, NULL)`,
      params: [
        id,
        asset.size,
        asset.mtime,
        asset.indexedAt,
        asset.mediaKind,
        asset.mapleId,
        asset.sha1Head,
      ],
    },
    {
      sql: `INSERT INTO asset_locations (asset_id, ordinal, library_id, path, filename, keep)
            VALUES (?, 0, ?, ?, ?, ?)`,
      params: [id, ...locationParams(asset.entry), asset.entry.keep ? 1 : 0],
    },
    ...seedStageRowStatements(id, asset.stages),
  ]);
  return toObjectId(id);
}

/**
 * Whether a failed insert lost a race for the same content.
 *
 * The Mongo equivalent was `err.code === 11000`, which covered every unique
 * index at once. Here the message names the column, and naming it is what keeps
 * a location collision — a genuinely different failure — from being recovered
 * as if it were a dedup race.
 */
export function isMapleIdConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /UNIQUE constraint failed:\s*assets\.maple_id/i.test(message);
}

/** One recorded location in a swept directory, with what a rename fingerprint needs. */
export interface RecordedInDirectory {
  assetId: ObjectId;
  fileinfo: FileInfo;
  size: number;
  exif: AssetExif | null;
}

/**
 * Every live-asset location recorded directly in one directory — the sweep's
 * single indexed read per visit, which drives both "what is new" and "what is
 * gone".
 *
 * `size` and `exif` ride along because the rename-reconcile pass fingerprints a
 * missing candidate from them and cannot re-read a file that is already gone.
 *
 * **One row per location, where Mongo returned one per asset.** The query this
 * replaces projected `fileinfo.$`, the *first* matching array entry, so an
 * asset holding two files in the same directory reported only one of them and
 * the second was permanently invisible to the sweep's diff — it would never be
 * detected as new and never confirmed as removed. A location is a row here, so
 * both come back.
 */
export async function listRecordedInDirectory(
  libraryId: ObjectId,
  path: string,
  dbOverride?: SqliteDb,
): Promise<RecordedInDirectory[]> {
  const rows = await sqliteDb(dbOverride).read<{
    asset_id: string;
    filename: string;
    deleted_at: string | null;
    missing_since: string | null;
    missing_reason: string | null;
    keep: number;
    size: number;
    exif: string | null;
  }>(
    `SELECT l.asset_id, l.filename, l.deleted_at, l.missing_since, l.missing_reason, l.keep,
            a.size, a.exif
       FROM asset_locations l
       JOIN assets a ON a.id = l.asset_id
      WHERE l.library_id = ? AND l.path = ? AND a.deleted_at IS NULL`,
    [toHex(libraryId), path],
  );
  return rows.map((row) => ({
    assetId: toObjectId(row.asset_id),
    fileinfo: {
      library_id: libraryId,
      path,
      filename: row.filename,
      deleted_at: row.deleted_at,
      missing_since: row.missing_since,
      missing_reason: row.missing_reason,
      keep: toBool(row.keep),
    },
    size: row.size,
    exif: row.exif === null ? null : (JSON.parse(row.exif) as AssetExif),
  }));
}

/**
 * Repoint a live location onto a new name, for the external-rename
 * reconciliation the sweep runs before it emits ordinary created/removed pairs.
 *
 * The old `(library, path, filename)` and its liveness are in the statement's
 * own `WHERE`, not just in the row lookup, and that is what makes the returned
 * boolean trustworthy. If a concurrent writer changed that exact location
 * between the caller's read and this write — another repoint, a trash, a dedupe
 * move — the update matches nothing and the caller declines instead of
 * attaching one photo's edit history to another.
 *
 * The decisive write is issued on its own and the follow-ups only once it has
 * won. They cannot share its transaction, because the guard is consumed by the
 * update itself: after it lands the old key no longer exists, so there is
 * nothing left for the other statements to be conditional on. A crash in the
 * gap leaves a correctly repointed row whose search document and path-keyed
 * caches re-arm on the next sweep instead of this one.
 */
export async function repointLocation(
  assetId: ObjectId,
  from: LocationKey,
  to: { path: string; filename: string },
  indexedAt: string,
  dbOverride?: SqliteDb,
): Promise<boolean> {
  const db = sqliteDb(dbOverride);
  const id = toHex(assetId);
  const moved = await db.write(
    `UPDATE asset_locations
        SET path = ?, filename = ?, missing_since = NULL, missing_reason = NULL
      WHERE asset_id = ? AND library_id = ? AND path = ? AND filename = ?
        AND deleted_at IS NULL`,
    [to.path, to.filename, id, ...locationParams(from)],
  );
  if (moved.changes === 0) return false;
  await db.transaction([
    { sql: `UPDATE assets SET indexed_at = ? WHERE id = ?`, params: [indexedAt, id] },
    meiliRearmStatement(id),
    ...relocateCacheRearmStatements(id),
  ]);
  return true;
}

/**
 * Put a repointed location back where it was, restoring its missing tags.
 *
 * The exact reverse of {@link repointLocation}, used only when the repoint
 * succeeded but the follow-on sidecar move then failed — the one ordering in
 * which the row and the sidecar's actual location would otherwise disagree.
 * Best-effort: the caller logs a failure and leaves the row pointing at a
 * location with no sidecar of its own, which is an orphaned-sidecar failure
 * rather than a misattributed-edits one.
 */
export async function restoreLocation(
  assetId: ObjectId,
  current: LocationKey,
  original: Pick<FileInfo, 'path' | 'filename' | 'missing_since' | 'missing_reason'>,
  dbOverride?: SqliteDb,
): Promise<boolean> {
  const result = await sqliteDb(dbOverride).write(
    `UPDATE asset_locations
        SET path = ?, filename = ?, missing_since = ?, missing_reason = ?
      WHERE asset_id = ? AND library_id = ? AND path = ? AND filename = ?
        AND deleted_at IS NULL`,
    [
      original.path,
      original.filename,
      original.missing_since ?? null,
      original.missing_reason ?? null,
      toHex(assetId),
      ...locationParams(current),
    ],
  );
  return result.changes > 0;
}

/**
 * Content dedup for the discover producer: finding the row that already holds a
 * file's bytes, recording another location on it, and inserting one when there
 * is none (#3787).
 *
 * ## The probe is two lookups, and both of them matter
 *
 * {@link findAssetForContent} tries `maple_id` and then falls back to
 * `sha1_head`. That is not belt and braces: the exif stage rewrites `maple_id`
 * in place when it upgrades the discover-time fallback id to the primary form,
 * so a duplicate discovered after that upgrade does not match what
 * `hashFileForId` computes and the first lookup misses. `sha1_head` is written
 * once at insert and never rewritten, so it stays a stable join key across the
 * upgrade — without the fallback the second copy inserts a new row that the exif
 * stage then tries to upgrade into the same primary id, which is a unique-index
 * violation that ends up dead-lettered.
 *
 * The dedup is consistent with how the id is built, too: both forms consume only
 * the first 64 KB of the file, which is exactly what `sha1_head` hashes, so two
 * files sharing a head hash are the same content from the pipeline's point of
 * view.
 */

import type { ObjectId } from '../object-id.ts';
import { newObjectIdHex } from '../object-id.ts';
import type { SqlStatement } from '../sqlite/protocol.ts';
import type { LocationKey } from './assets.discover.ts';
import { meiliRearmStatement } from './assets.stage-rearm.ts';
import { seedStageRowStatements } from './stage-state.repo.ts';
import { sqliteDb, type SqliteDb } from './db-handle.ts';
import { toHex, toObjectId } from './values.ts';

export type { SqliteDb } from './db-handle.ts';

/** The three bound values every location-keyed statement takes, in order. */
function locationParams(key: LocationKey): [string, string, string] {
  return [toHex(key.library_id), key.path, key.filename];
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

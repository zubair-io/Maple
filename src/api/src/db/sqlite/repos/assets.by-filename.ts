/**
 * Assets found by basename — the batch lookups behind the address-driven
 * routes (#3787).
 *
 * Four callers take a list of absolute paths they already resolved through the
 * library jail, and need the catalog rows behind them: the batch metadata
 * snapshot, the panorama path resolver, the relocate preview, and the directory
 * listing `/api/fs/dir` serves. None of them can key on `(library, directory,
 * filename)` directly, because the absolute path they hold was produced by
 * `realpath` and a library registered through a symlink resolves to a root the
 * stored one does not match textually. So they fetch by basename and reconcile
 * the full path themselves, which is what these functions feed.
 *
 * ## The filename list is deduplicated by the caller, and bounded by the route
 *
 * Every caller caps its input — 1000 addresses for the three address routes, one
 * page of a directory listing for browse — and passes a `Set`'s contents, so the
 * `IN (…)` list is small and the index seek per value is the whole cost. There
 * is no fallback for an unbounded list because no caller can produce one.
 *
 * ## An asset appears once, with all of its locations
 *
 * The match is "any location of this asset has one of these names", which is a
 * semi-join rather than a join: the callers then walk the asset's whole
 * `fileinfo` list to find the entry whose reconstructed absolute path is the one
 * they asked about. Returning a row per matching location would make them do
 * that work once per copy and report duplicates.
 */

import type { ObjectId } from 'mongodb';
import type { AssetExif, FileInfo, MetadataOverride } from '../../schema.ts';
import { json, toFileInfo, type LocationRow } from './assets.rows.ts';
import { locationsByAssetIdsSql } from './assets.sql.ts';
import { sqliteDb, type SqliteDb } from './db-handle.ts';
import { placeholders, toObjectId } from './values.ts';

export type { SqliteDb } from './db-handle.ts';

/** Asset ids holding a location with one of these basenames. */
async function idsByFilenames(
  db: SqliteDb,
  filenames: readonly string[],
): Promise<{ ids: string[]; locations: Map<string, LocationRow[]> }> {
  if (filenames.length === 0) return { ids: [], locations: new Map() };
  const rows = await db.read<{ asset_id: string }>(
    `SELECT DISTINCT asset_id FROM asset_locations
      WHERE filename IN (${placeholders(filenames.length)})`,
    [...filenames],
  );
  const ids = rows.map((row) => row.asset_id);
  if (ids.length === 0) return { ids, locations: new Map() };

  const locationRows = await db.read<LocationRow>(locationsByAssetIdsSql(ids.length), ids);
  const locations = new Map<string, LocationRow[]>();
  for (const location of locationRows) {
    const list = locations.get(location.asset_id);
    if (list === undefined) locations.set(location.asset_id, [location]);
    else list.push(location);
  }
  return { ids, locations };
}

/** An asset reduced to what a path reconciliation needs: its id and its copies. */
export interface AssetLocationsRow {
  _id: ObjectId;
  fileinfo: FileInfo[];
}

/**
 * Every asset holding a location with one of these basenames, as id plus
 * locations.
 *
 * `routes/pano.ts` uses this to turn a list of absolute paths into asset ids
 * before it queues a stitch.
 */
export async function findAssetLocationsByFilenames(
  filenames: readonly string[],
  dbOverride?: SqliteDb,
): Promise<AssetLocationsRow[]> {
  const db = sqliteDb(dbOverride);
  const { ids, locations } = await idsByFilenames(db, filenames);
  return ids.map((id) => ({ _id: toObjectId(id), fileinfo: toFileInfo(locations.get(id) ?? []) }));
}

/**
 * The sidecar-owned fields `POST /api/metadata/snapshots` reduces to an
 * effective XMP snapshot.
 *
 * `metadata_override` lives in `asset_detail` rather than on the grid row, so
 * this is the one lookup here that joins: a sparse user-edit overlay is detail
 * data by the schema's own rule, and an asset that has never been edited simply
 * has no row there.
 */
export interface MetadataSnapshotRow {
  _id: ObjectId;
  fileinfo: FileInfo[];
  exif: AssetExif | null;
  metadata_override: MetadataOverride | null;
  rating: number;
  /** The column is `CHECK (flag IN (-1, 0, 1))`, so the narrowing is a fact
   * about the schema rather than an assumption about the data. */
  flag: -1 | 0 | 1;
  color_label: string;
}

interface SnapshotAssetRow {
  id: string;
  rating: number;
  flag: number;
  color_label: string;
  exif: string | null;
  metadata_override: string | null;
}

/**
 * The metadata snapshot rows for a set of basenames.
 *
 * Returned in no particular order: the route keys the result by reconstructed
 * absolute path and answers in request order from that map.
 */
export async function findMetadataByFilenames(
  filenames: readonly string[],
  dbOverride?: SqliteDb,
): Promise<MetadataSnapshotRow[]> {
  const db = sqliteDb(dbOverride);
  const { ids, locations } = await idsByFilenames(db, filenames);
  if (ids.length === 0) return [];

  const rows = await db.read<SnapshotAssetRow>(
    `SELECT a.id AS id, a.rating AS rating, a.flag AS flag, a.color_label AS color_label,
            a.exif AS exif, d.metadata_override AS metadata_override
       FROM assets a
       LEFT JOIN asset_detail d ON d.asset_id = a.id
      WHERE a.id IN (${placeholders(ids.length)})`,
    ids,
  );

  return rows.map((row) => ({
    _id: toObjectId(row.id),
    fileinfo: toFileInfo(locations.get(row.id) ?? []),
    exif: json<AssetExif>(row.exif),
    metadata_override: json<MetadataOverride>(row.metadata_override),
    rating: row.rating,
    flag: row.flag as -1 | 0 | 1,
    color_label: row.color_label,
  }));
}

/**
 * One directory entry as `/api/fs/dir` renders it: the id it hands the client,
 * the EXIF the grid shows, and whether the asset is in the trash.
 */
export interface ListingAssetRow {
  _id: ObjectId;
  fileinfo: FileInfo[];
  exif: AssetExif | null;
  /** Non-null for a soft-deleted asset, which browse hides from the listing. */
  deleted_at: string | null;
}

/**
 * The rows behind one directory listing.
 *
 * `deleted_at` comes back rather than being filtered out because browse has to
 * do more than skip the row: a file whose asset is soft-deleted has either moved
 * into `.maple/trash/` or vanished, and its on-disk name must be removed from
 * the listing entirely. Filtering here would leave that name looking un-indexed
 * and browse would offer to index it again.
 */
export async function findListingAssetsByFilenames(
  filenames: readonly string[],
  dbOverride?: SqliteDb,
): Promise<ListingAssetRow[]> {
  const db = sqliteDb(dbOverride);
  const { ids, locations } = await idsByFilenames(db, filenames);
  if (ids.length === 0) return [];

  const rows = await db.read<{ id: string; exif: string | null; deleted_at: string | null }>(
    `SELECT id, exif, deleted_at FROM assets WHERE id IN (${placeholders(ids.length)})`,
    ids,
  );

  return rows.map((row) => ({
    _id: toObjectId(row.id),
    fileinfo: toFileInfo(locations.get(row.id) ?? []),
    exif: json<AssetExif>(row.exif),
    deleted_at: row.deleted_at,
  }));
}

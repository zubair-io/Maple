/**
 * Assets found by basename — the batch lookups behind the address-driven
 * routes (#3787).
 *
 * Four callers take a list of absolute paths they already resolved through the
 * library jail, and need the catalog rows behind them: the batch metadata
 * snapshot, the panorama path resolver, the relocate routes, and the directory
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

import type { ObjectId, WithId } from 'mongodb';
import type { AssetDoc, AssetExif, FileInfo, MetadataOverride, Place } from '../../schema.ts';
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

/**
 * The shape the three asset-row lookups below share: resolve the basenames
 * once, run one projection over exactly the ids that came back, and hand each
 * row its own `fileinfo[]`. (The fourth, {@link findAssetLocationsByFilenames},
 * needs no projection — the basename lookup already holds everything it
 * answers with.)
 *
 * That order is the semi-join rule from the module comment, made structural
 * rather than restated per function. The basename query is the only thing that
 * decides *which* assets are in the answer; everything after it can only fill
 * rows in. A projection that joined `asset_locations` a second time would
 * return a row per copy and quietly reintroduce the duplicates this module
 * exists to avoid, and no caller could tell from the outside.
 *
 * Nothing runs when the basenames match no asset. That is not just an
 * optimisation: the projections build their `IN` list from the id count, and
 * `IN ()` is a syntax error in SQLite.
 */
async function projectByFilenames<Row extends { id: string }, Result>(
  filenames: readonly string[],
  dbOverride: SqliteDb | undefined,
  project: (db: SqliteDb, ids: string[]) => Promise<Row[]>,
  build: (row: Row, fileinfo: FileInfo[]) => Result,
): Promise<Result[]> {
  const db = sqliteDb(dbOverride);
  const { ids, locations } = await idsByFilenames(db, filenames);
  if (ids.length === 0) return [];
  const rows = await project(db, ids);
  return rows.map((row) => build(row, toFileInfo(locations.get(row.id) ?? [])));
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

/** A snapshot row and its locations as the route reads them. */
function toMetadataSnapshotRow(row: SnapshotAssetRow, fileinfo: FileInfo[]): MetadataSnapshotRow {
  return {
    _id: toObjectId(row.id),
    fileinfo,
    exif: json<AssetExif>(row.exif),
    metadata_override: json<MetadataOverride>(row.metadata_override),
    rating: row.rating,
    flag: row.flag as -1 | 0 | 1,
    color_label: row.color_label,
  };
}

/**
 * The metadata snapshot rows for a set of basenames.
 *
 * Returned in no particular order: the route keys the result by reconstructed
 * absolute path and answers in request order from that map.
 */
export function findMetadataByFilenames(
  filenames: readonly string[],
  dbOverride?: SqliteDb,
): Promise<MetadataSnapshotRow[]> {
  return projectByFilenames(
    filenames,
    dbOverride,
    (db, ids) =>
      db.read<SnapshotAssetRow>(
        `SELECT a.id AS id, a.rating AS rating, a.flag AS flag, a.color_label AS color_label,
                a.exif AS exif, d.metadata_override AS metadata_override
           FROM assets a
           LEFT JOIN asset_detail d ON d.asset_id = a.id
          WHERE a.id IN (${placeholders(ids.length)})`,
        ids,
      ),
    toMetadataSnapshotRow,
  );
}

/**
 * A relocate candidate: the asset as the move helpers read it, plus how far the
 * sidecar reconcile has got on it.
 *
 * The document is the widest read in this module — the metadata snapshot's
 * projection plus `place`, `maple_id` and `apple_rendered_path` — because
 * `/api/library/relocate` does three separate things with it. It decides the
 * canonical folder (`place`, the override's `place_text`, the screenshot
 * verdict, the capture year), it moves the file and its Apple-rendered
 * companion, and it reclaims the emptied source folder's `.maple` cache entries
 * by `maple_id`.
 *
 * `sidecarStageVersion` rides along so the route can tell, without a second
 * query, which of these assets the `sidecar-metadata-index` stage has not
 * reached yet — those it reconciles on the spot rather than relocating against
 * a `place_text` the sidecar has already superseded.
 */
export interface RelocateCandidateRow {
  doc: WithId<AssetDoc>;
  /** The named stage's recorded version; 0 when it has never run. */
  sidecarStageVersion: number;
}

interface RelocateAssetRow {
  id: string;
  size: number;
  mtime: number;
  indexed_at: string;
  rating: number;
  flag: number;
  color_label: string;
  is_screenshot: number | null;
  maple_id: string | null;
  apple_rendered_path: string | null;
  exif: string | null;
  place: string | null;
  metadata_override: string | null;
  stage_version: number;
}

const RELOCATE_CANDIDATE_SQL = `
  SELECT a.id AS id, a.size AS size, a.mtime AS mtime, a.indexed_at AS indexed_at,
         a.rating AS rating, a.flag AS flag, a.color_label AS color_label,
         a.is_screenshot AS is_screenshot, a.maple_id AS maple_id,
         a.apple_rendered_path AS apple_rendered_path,
         a.exif AS exif, a.place AS place,
         d.metadata_override AS metadata_override,
         COALESCE(s.version, 0) AS stage_version
    FROM assets a
    LEFT JOIN asset_detail d ON d.asset_id = a.id
    LEFT JOIN stage_state s ON s.asset_id = a.id AND s.stage = ?`;

/** A relocate candidate row and its locations as `/api/library/relocate` reads them. */
function toRelocateCandidate(row: RelocateAssetRow, fileinfo: FileInfo[]): RelocateCandidateRow {
  return {
    sidecarStageVersion: row.stage_version,
    doc: {
      _id: toObjectId(row.id),
      fileinfo,
      size: row.size,
      mtime: row.mtime,
      indexed_at: row.indexed_at,
      rating: row.rating,
      flag: row.flag as -1 | 0 | 1,
      color_label: row.color_label,
      exif: json<AssetExif>(row.exif),
      place: json<Place>(row.place),
      metadata_override: json<MetadataOverride>(row.metadata_override),
      // Omitted rather than nulled when absent, because `geoDir` reads the
      // screenshot verdict as `override ?? row` and a `null` here would answer
      // the wrong question for an asset the describe stage has not classified.
      ...(row.is_screenshot === null ? {} : { is_screenshot: row.is_screenshot === 1 }),
      ...(row.maple_id === null ? {} : { maple_id: row.maple_id }),
      ...(row.apple_rendered_path === null ? {} : { apple_rendered_path: row.apple_rendered_path }),
    },
  };
}

/**
 * The relocate candidates behind a set of basenames, with the named stage's
 * version on each.
 *
 * `stage_state` is joined rather than queried separately, and `COALESCE(…, 0)`
 * is what makes a missing row read as "never run" — the same thing a missing
 * `stages.<name>` subdocument meant on Mongo. Stage rows are seeded densely, so
 * a missing one is rare, but reading it as "already at target" would silently
 * skip the reconcile the route exists to do.
 */
export function findRelocateCandidatesByFilenames(
  filenames: readonly string[],
  stage: string,
  dbOverride?: SqliteDb,
): Promise<RelocateCandidateRow[]> {
  return projectByFilenames(
    filenames,
    dbOverride,
    (db, ids) =>
      db.read<RelocateAssetRow>(
        `${RELOCATE_CANDIDATE_SQL}\n   WHERE a.id IN (${placeholders(ids.length)})`,
        [stage, ...ids],
      ),
    toRelocateCandidate,
  );
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

interface ListingRow {
  id: string;
  exif: string | null;
  deleted_at: string | null;
}

/** A listing row and its locations as `/api/fs/dir` reads them. */
function toListingAssetRow(row: ListingRow, fileinfo: FileInfo[]): ListingAssetRow {
  return {
    _id: toObjectId(row.id),
    fileinfo,
    exif: json<AssetExif>(row.exif),
    deleted_at: row.deleted_at,
  };
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
export function findListingAssetsByFilenames(
  filenames: readonly string[],
  dbOverride?: SqliteDb,
): Promise<ListingAssetRow[]> {
  return projectByFilenames(
    filenames,
    dbOverride,
    (db, ids) =>
      db.read<ListingRow>(
        `SELECT id, exif, deleted_at FROM assets WHERE id IN (${placeholders(ids.length)})`,
        ids,
      ),
    toListingAssetRow,
  );
}

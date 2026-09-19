/**
 * Location-shaped reads of the `assets` / `asset_locations` pair (#3787).
 *
 * Five queries that the file-management orchestrators, the job handlers and the
 * import placer used to spell inline against the `assets` collection. They have
 * one thing in common: the answer is about *where an asset's bytes are*, which
 * on Mongo meant an `$elemMatch` over `fileinfo[]` and here means a row of
 * `asset_locations`.
 *
 * A separate module from `assets.repo.ts` because that one is the DTO surface —
 * detail views, list pages, address lookups — and this is the filesystem side:
 * the callers want a path to move, not a document to serialise.
 *
 * ## Same-entry matching stops being a rule and becomes the shape of the query
 *
 * `{ fileinfo: { $elemMatch: { library_id, path, filename } } }` and
 * `{ 'fileinfo.library_id': …, 'fileinfo.path': … }` differ in whether one
 * entry has to satisfy every condition, and nothing at a Mongo call site makes
 * the difference visible. An entry is a row here, so `WHERE library_id = ? AND
 * path = ?` can only ever mean the first.
 *
 * ## Why the folder queries return the matched entry
 *
 * The Mongo versions return whole documents and then re-derive, in memory,
 * which `fileinfo` entry the query matched on — `pickFolderEntry` in
 * `library/folder-trash.ts` re-implements the predicate a second time, and its
 * caller has a "matched the query but found nothing" branch for when the two
 * disagree. The row IS the entry, so it comes back with the asset id and that
 * branch has nothing left to guard.
 */

import type { ObjectId } from '../../object-id.ts';
import * as path from 'node:path';
import type { FileInfo } from '../../schema.ts';
import { sqliteDb, type SqliteDb } from './db-handle.ts';
import { toFileInfo, type LocationRow } from './assets.rows.ts';
import { bucketedIds, locationsByAssetIdsSql } from './assets.sql.ts';
import { placeholders, toHex, toObjectId } from './values.ts';

/**
 * What every caller that resolves an asset to a file on disk actually reads:
 * the location array, and the capture time two of them place photos by.
 *
 * `capturedAt` rides along because the alternative is a second query per asset
 * for one string — `job-runner/handlers/batch-jpeg-export.ts` and
 * `library/batch-rename.ts` both need it beside the path, and it is a generated
 * column on the row the locations already join to.
 */
export interface AssetLocationView {
  fileinfo: FileInfo[];
  capturedAt: string | null;
}

/** One asset id with the single location a folder query matched on. */
export interface FolderLocationMatch {
  assetId: ObjectId;
  path: string;
  filename: string;
}

/** A candidate for the import placer's nearest-folder match. */
export interface NearbyAssetCandidate {
  capturedAtMs: number;
  folderPath: string;
}

/**
 * LIKE-safe form of a stored path, so a directory containing `%` or `_` cannot
 * match its siblings.
 *
 * The backslash is escaped first; escaping it after the wildcards would escape
 * the escapes this function just introduced.
 */
function likePrefix(value: string): string {
  return `${value.replace(/[\\%_]/g, (character) => `\\${character}`)}/%`;
}

/**
 * Locations and capture time for a batch of asset ids.
 *
 * Two statements regardless of how many ids there are: a handler exporting
 * 2,000 photos issues the same pair a handler exporting two does. The id list
 * is padded to a power of two by `bucketedIds` so a varying batch size does not
 * churn the worker's prepared-statement cache — see `assets.sql.ts`.
 *
 * An id with no row in `assets` is absent from the map, which is how every
 * caller already distinguishes "no such asset" from "an asset with no live
 * location".
 */
export async function loadAssetLocationViews(
  ids: readonly ObjectId[],
  dbOverride?: SqliteDb,
): Promise<Map<string, AssetLocationView>> {
  if (ids.length === 0) return new Map();
  const db = sqliteDb(dbOverride);
  const hexes = ids.map(toHex);
  const bound = bucketedIds(hexes);
  const [locations, captured] = await Promise.all([
    db.read<LocationRow>(locationsByAssetIdsSql(bound.length), bound),
    db.read<{ id: string; captured_at: string | null }>(
      `SELECT id, captured_at FROM assets WHERE id IN (${placeholders(bound.length)})`,
      bound,
    ),
  ]);

  const byAsset = new Map<string, LocationRow[]>();
  for (const row of locations) {
    const existing = byAsset.get(row.asset_id);
    if (existing) existing.push(row);
    else byAsset.set(row.asset_id, [row]);
  }
  return new Map(
    captured.map((row) => [
      row.id,
      { fileinfo: toFileInfo(byAsset.get(row.id) ?? []), capturedAt: row.captured_at },
    ]),
  );
}

/** {@link loadAssetLocationViews} for one asset, or `null` when there is none. */
export async function loadAssetLocationView(
  id: ObjectId,
  dbOverride?: SqliteDb,
): Promise<AssetLocationView | null> {
  const views = await loadAssetLocationViews([id], dbOverride);
  return views.get(toHex(id)) ?? null;
}

/**
 * Every live asset with a location under `(folderId, relPath)`, recursively,
 * with the location that put it there.
 *
 * "Under" is the directory itself or any descendant of it, and the two branches
 * are spelled separately rather than as one prefix test so a sibling whose name
 * merely starts with the same characters cannot match — `photos` must not pull
 * in `photos2`. That is the `^relPath(/|$)` regex the Mongo version built, minus
 * the regex.
 *
 * "Live" is the asset's own `deleted_at` (it is not in the trash) and the
 * entry's (its bytes have not been replaced in place). A `missing_since` tag is
 * deliberately *not* excluded, matching the Mongo query: a file the watcher has
 * not seen lately is still a file this folder owns.
 */
export async function listLiveAssetLocationsUnderFolder(
  folderId: ObjectId,
  relPath: string,
  dbOverride?: SqliteDb,
): Promise<FolderLocationMatch[]> {
  const rows = await sqliteDb(dbOverride).read<{
    asset_id: string;
    path: string;
    filename: string;
  }>(
    `SELECT l.asset_id, l.path, l.filename
       FROM asset_locations l
       JOIN assets a ON a.id = l.asset_id
      WHERE l.library_id = ?
        AND l.deleted_at IS NULL
        AND (l.path = ? OR l.path LIKE ? ESCAPE '\\')
        AND a.deleted_at IS NULL
      ORDER BY l.asset_id, l.ordinal`,
    [toHex(folderId), relPath, likePrefix(relPath)],
  );
  return firstPerAsset(rows);
}

/**
 * Every trashed asset whose recorded `original_path` was under
 * `folderRoot/relPath`, with the location in `folderId` that trash repointed.
 *
 * The entry is matched on its library alone, with no liveness test, because a
 * trashed entry stays live by the per-entry definition — trash stamps the
 * asset's own `deleted_at` and rewrites the entry's address to the
 * `.maple/trash/` copy. Testing the entry would exclude exactly the rows this
 * query exists to find.
 */
export async function listTrashedAssetLocationsUnderFolder(
  folderId: ObjectId,
  folderRoot: string,
  relPath: string,
  dbOverride?: SqliteDb,
): Promise<FolderLocationMatch[]> {
  const absFolderPath = relPath === '' ? folderRoot : path.join(folderRoot, relPath);
  const rows = await sqliteDb(dbOverride).read<{
    asset_id: string;
    path: string;
    filename: string;
  }>(
    `SELECT l.asset_id, l.path, l.filename
       FROM asset_locations l
       JOIN assets a ON a.id = l.asset_id
      WHERE l.library_id = ?
        AND a.deleted_at IS NOT NULL
        AND (a.original_path = ? OR a.original_path LIKE ? ESCAPE '\\')
      ORDER BY l.asset_id, l.ordinal`,
    [toHex(folderId), absFolderPath, likePrefix(absFolderPath)],
  );
  return firstPerAsset(rows);
}

/**
 * One match per asset, the lowest `ordinal` winning.
 *
 * The rows arrive ordered by `(asset_id, ordinal)`, so the first row of each
 * group is the canonical entry — the same one `Array.prototype.find` returned
 * from a `fileinfo[]` in array order. An asset with two locations under the
 * same folder is trashed or restored once, not twice.
 */
function firstPerAsset(
  rows: ReadonlyArray<{ asset_id: string; path: string; filename: string }>,
): FolderLocationMatch[] {
  const seen = new Set<string>();
  const matches: FolderLocationMatch[] = [];
  for (const row of rows) {
    if (seen.has(row.asset_id)) continue;
    seen.add(row.asset_id);
    matches.push({ assetId: toObjectId(row.asset_id), path: row.path, filename: row.filename });
  }
  return matches;
}

/**
 * Hard cap on candidates pulled into memory for one `buildImportFiles` call.
 *
 * An import batch spanning years — a folder mixing decades-old scans with new
 * photos — would otherwise load every asset captured across that whole span.
 * A safety valve rather than a correctness requirement: hitting it means some
 * files fall back to the shot-folder default instead of a nearby-asset match,
 * never data loss.
 */
export const NEARBY_CANDIDATE_CAP = 20_000;

/**
 * Already-indexed assets in `libraryId` whose capture time falls in
 * `[minMs, maxMs]`, for the in-memory nearest-match lookup in
 * `imports/dest.ts`.
 *
 * ONE range query for a whole import batch, not one per file: the caller passes
 * the min and max mtime across every file it is about to place, already padded
 * by the proximity window, so an import of thousands of files costs one query.
 *
 * `captured_at` is a generated column over `exif.captured_at`, holding a UTC ISO
 * string, so the range is a lexicographic compare — the same trick the Mongo
 * query played against the `exif.captured_at` index. The live predicate is
 * spelled the way `db/sqlite/ddl/assets.ts` spells it so the partial index over
 * capture time stays usable; it is implied by the location join anyway, and
 * SQLite's implication test is textual.
 *
 * `MIN(ordinal)` with a bare `path` beside it is SQLite's documented
 * bare-column rule: the row the aggregate came from supplies the other columns.
 * It is what keeps one row per asset, matching the positional `fileinfo.$`
 * projection the Mongo query used.
 */
export async function loadNearbyAssetCandidateRows(
  libraryId: ObjectId,
  minMs: number,
  maxMs: number,
  dbOverride?: SqliteDb,
): Promise<{ candidates: NearbyAssetCandidate[]; truncated: boolean }> {
  const rows = await sqliteDb(dbOverride).read<{ captured_at: string; path: string }>(
    `SELECT a.captured_at AS captured_at, l.path AS path, MIN(l.ordinal) AS ordinal
       FROM assets a
       JOIN asset_locations l ON l.asset_id = a.id
      WHERE a.captured_at >= ? AND a.captured_at <= ?
        AND a.deleted_at IS NULL AND a.live_location_count > 0
        AND l.library_id = ?
        AND l.deleted_at IS NULL AND l.missing_since IS NULL
      GROUP BY a.id
      LIMIT ?`,
    [
      new Date(minMs).toISOString(),
      new Date(maxMs).toISOString(),
      toHex(libraryId),
      NEARBY_CANDIDATE_CAP + 1,
    ],
  );
  const truncated = rows.length > NEARBY_CANDIDATE_CAP;
  return {
    candidates: rows
      .slice(0, NEARBY_CANDIDATE_CAP)
      .map((row) => ({ capturedAtMs: new Date(row.captured_at).getTime(), folderPath: row.path })),
    truncated,
  };
}

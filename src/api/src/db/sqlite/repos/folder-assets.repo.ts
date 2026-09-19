/**
 * The library-scoped asset queries behind `/api/folders/:id/*` (#3787).
 *
 * Three reads and one write, all of them "every asset that lives in this
 * library": the paged file list the folder view renders, the trash page, and
 * the rescan button's stage re-arm. They were spelled inline in
 * `routes/folders.ts` because `folders` had no repository module; they are here
 * rather than in `assets.repo.ts` because every one of them leads with
 * `asset_locations` scoped to a library, which is a different access shape from
 * the id-keyed and grid-ordered reads that file owns.
 *
 * ## Library membership is a semi-join, and an asset appears once
 *
 * `{'fileinfo.library_id': id}` on Mongo matches a *document* through any of
 * its array entries, so an asset with two copies in one library still comes
 * back once. A plain join to `asset_locations` would return it twice, which
 * would silently corrupt both the page and its total. `GROUP BY assets.id` on
 * the list and `COUNT(DISTINCT asset_id)` on the total are what preserve the
 * document-shaped answer.
 *
 * ## The filename a listing reports is this library's
 *
 * The Mongo projection picks the first *live* `fileinfo` entry regardless of
 * which library it points at, so a deduplicated asset whose live copy is in
 * another library reported that other library's filename in this library's
 * listing. Grouping over the library-scoped rows makes the reported name one of
 * the names this library actually holds. `MIN(filename)` picks deterministically
 * among the (rare) several copies in one library, where the array order Mongo
 * followed was itself arbitrary.
 */

import type { ObjectId } from '../../object-id.ts';
import type { FileInfo } from '../../schema.ts';
import { toFileInfo, type LocationRow } from './assets.rows.ts';
import { locationsByAssetIdsSql } from './assets.sql.ts';
import { sqliteDb, type SqliteDb } from './db-handle.ts';
import { toObjectId } from './values.ts';

export type { SqliteDb } from './db-handle.ts';

/** One row of `GET /api/folders/:id/assets`. */
export interface FolderAssetRow {
  id: string;
  filename: string;
  size: number;
  mtime: number;
  rating: number;
  flag: number;
  color_label: string;
  indexed_at: string;
  has_xmp: number;
}

/** A page of a library's assets, and how many there are in total. */
export interface FolderAssetPage {
  total: number;
  items: FolderAssetRow[];
}

const FOLDER_ASSETS_SQL = `
  SELECT a.id AS id, MIN(l.filename) AS filename, a.size AS size, a.mtime AS mtime,
         a.rating AS rating, a.flag AS flag, a.color_label AS color_label,
         a.indexed_at AS indexed_at, a.has_xmp AS has_xmp
    FROM asset_locations l
    JOIN assets a ON a.id = l.asset_id
   WHERE l.library_id = ?
   GROUP BY a.id
   ORDER BY filename ASC, a.id ASC
   LIMIT ? OFFSET ?`;

const FOLDER_ASSET_COUNT_SQL = `
  SELECT COUNT(DISTINCT asset_id) AS n FROM asset_locations WHERE library_id = ?`;

/**
 * One page of a library's assets, name-ordered, with the total beside it.
 *
 * The page and the count are issued together: they read the same table with the
 * same predicate, so a grid that shows "412 photos" over a page cannot be
 * looking at two different answers.
 */
export async function listFolderAssets(
  libraryId: ObjectId,
  page: { skip: number; limit: number },
  dbOverride?: SqliteDb,
): Promise<FolderAssetPage> {
  const db = sqliteDb(dbOverride);
  const hex = libraryId.toHexString();
  const [items, counts] = await Promise.all([
    db.read<FolderAssetRow>(FOLDER_ASSETS_SQL, [hex, page.limit, page.skip]),
    db.read<{ n: number }>(FOLDER_ASSET_COUNT_SQL, [hex]),
  ]);
  return { total: counts[0]?.n ?? 0, items };
}

const FOLDER_STAGE_RESET_SQL = `
  UPDATE stage_state
     SET version = 0, dead = 0, attempts = 0, last_error = NULL
   WHERE asset_id IN (SELECT asset_id FROM asset_locations WHERE library_id = ?)`;

/**
 * Re-arm every stage on every asset in a library — the `POST /:id/rescan`
 * button — and report how many assets that covered.
 *
 * The count is assets rather than stage rows, because that is the number the
 * route puts on the wire and the number an operator reads as "photos
 * re-queued": Mongo's `updateMany` over `assets` reported one per document
 * where twelve stage rows change here.
 *
 * `next_attempt_at` is deliberately untouched, matching the `$set` this
 * replaces and matching `versionBumpReset` — clearing it would revoke a claim
 * a worker is still holding, and a backoff gate expires on its own anyway.
 */
export async function resetFolderStages(
  libraryId: ObjectId,
  dbOverride?: SqliteDb,
): Promise<number> {
  const db = sqliteDb(dbOverride);
  const hex = libraryId.toHexString();
  const counts = await db.read<{ n: number }>(FOLDER_ASSET_COUNT_SQL, [hex]);
  await db.write(FOLDER_STAGE_RESET_SQL, [hex]);
  return counts[0]?.n ?? 0;
}

/** One trashed asset, as `GET /api/folders/:id/trash` needs to render it. */
export interface FolderTrashRow {
  _id: ObjectId;
  size: number;
  mtime: number;
  deleted_at: string;
  deleted_reason: string | null;
  original_path: string | null;
  fileinfo: FileInfo[];
}

interface TrashAssetRow {
  id: string;
  size: number;
  mtime: number;
  deleted_at: string;
  deleted_reason: string | null;
  original_path: string | null;
}

/**
 * The trash page's predicate.
 *
 * `deleted_at IS NOT NULL` is the whole of what Mongo spelled as
 * `{ $type: 'string', $ne: null }`. That spelling was not stylistic — it was
 * what let the planner match the `deleted_at_1` partial index — and the same
 * concern applies here for the same reason, which is why `assets_trashed` is
 * partial over exactly this text.
 *
 * The second clause keeps watcher-reaped rows visible while excluding assets
 * that simply vanished: a user trash always recorded where the file came from,
 * and a reaped row (#2977) has no copy to restore but announces itself through
 * its discriminator.
 */
const TRASH_BASE_PREDICATE = `
  a.deleted_at IS NOT NULL
      AND (a.original_path IS NOT NULL OR a.deleted_reason = 'reaped')
      AND EXISTS (SELECT 1 FROM asset_locations l WHERE l.asset_id = a.id AND l.library_id = ?)`;

const TRASH_COLUMNS = `a.id, a.size, a.mtime, a.deleted_at, a.deleted_reason, a.original_path`;

/**
 * The keyset cursor, as a tuple comparison over the sort key.
 *
 * `(deleted_at, id)` descending is the page order, so "after the previous
 * page's last row" is "strictly smaller in that tuple". Written as the plain
 * two-branch disjunction rather than SQLite's row-value syntax because the
 * planner uses `assets_trashed` for the leading term either way and the
 * explicit form is what the Mongo cursor said.
 */
function trashCursorPredicate(cursor: string | null): {
  sql: string;
  params: string[];
} | null {
  if (cursor === null || cursor === '') return null;
  const separator = cursor.lastIndexOf('|');
  if (separator <= 0) return null;
  const iso = cursor.slice(0, separator);
  const hex = cursor.slice(separator + 1);
  if (!/^[0-9a-fA-F]{24}$/.test(hex)) return null;
  return {
    sql: `(a.deleted_at < ? OR (a.deleted_at = ? AND a.id < ?))`,
    params: [iso, iso, hex],
  };
}

/**
 * The trash page as a statement and its bound values.
 *
 * Separated from the read so `folders.trash-list.test.ts` can put it through
 * `EXPLAIN QUERY PLAN`. That file exists because the Mongo predicate silently
 * lost its partial index once (#83) and the regression was invisible except in
 * a plan; the SQLite spelling can lose `assets_trashed` exactly the same way,
 * so the same test still has something to assert.
 */
export function folderTrashStatement(
  libraryId: ObjectId,
  options: { cursor: string | null; limit: number },
): { sql: string; params: Array<string | number> } {
  const seek = trashCursorPredicate(options.cursor);
  return {
    sql: `
    SELECT ${TRASH_COLUMNS}
      FROM assets a
     WHERE ${TRASH_BASE_PREDICATE}${seek === null ? '' : `\n      AND ${seek.sql}`}
     ORDER BY a.deleted_at DESC, a.id DESC
     LIMIT ?`,
    params: [libraryId.toHexString(), ...(seek?.params ?? []), options.limit],
  };
}

/**
 * One page of a library's trash, newest-deleted first.
 *
 * Returns up to `limit` rows; the route asks for one more than it will show and
 * uses the extra to decide whether to mint a next cursor, exactly as it did
 * against Mongo.
 */
export async function listFolderTrash(
  libraryId: ObjectId,
  options: { cursor: string | null; limit: number },
  dbOverride?: SqliteDb,
): Promise<FolderTrashRow[]> {
  const db = sqliteDb(dbOverride);
  const statement = folderTrashStatement(libraryId, options);
  const rows = await db.read<TrashAssetRow>(statement.sql, statement.params);
  if (rows.length === 0) return [];

  const ids = rows.map((row) => row.id);
  const locations = await db.read<LocationRow>(locationsByAssetIdsSql(ids.length), ids);
  const byAsset = new Map<string, LocationRow[]>();
  for (const location of locations) {
    const list = byAsset.get(location.asset_id);
    if (list === undefined) byAsset.set(location.asset_id, [location]);
    else list.push(location);
  }

  return rows.map((row) => ({
    _id: toObjectId(row.id),
    size: row.size,
    mtime: row.mtime,
    deleted_at: row.deleted_at,
    deleted_reason: row.deleted_reason,
    original_path: row.original_path,
    fileinfo: toFileInfo(byAsset.get(row.id) ?? []),
  }));
}

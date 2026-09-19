// The blocks this shares with `db/assets.repo.ts` are the ones that do not
// touch a database at all — the same DTO assembled from rows instead of from a
// document. Factoring them into a shared helper would couple the two
// implementations together shortly before one of them is deleted, which is the
// opposite of what this migration's beside-then-switch shape is for. The
// duplication ends when the Mongo module goes (#3785).
// fallow-ignore-file code-duplication

/**
 * Assets repository — the SQLite port of `db/assets.repo.ts` (#3746).
 *
 * Every function the Mongo repo exports has an equivalent here with the same
 * name, the same parameters and the same return type, so the cutover (#3752)
 * changes the import path in each route and nothing else. The one substitution
 * is the optional trailing `dbOverride`: it accepts a SQLite handle instead of
 * a Mongo `Db`. No route passes it — it is the tests' seam, and it was already
 * that on the Mongo side.
 *
 * ## Why both repositories exist right now
 *
 * MongoDB is still the live database. This module is not wired into any route
 * yet and the Mongo repo is untouched and still serving every request. That is
 * deliberate staged work, tracked by the cutover ticket, and it is the same
 * shape the connection pool (#3742) and the schema (#3743) landed in: build
 * the replacement beside the original, prove it, then switch the imports in
 * one reviewable commit. There is deliberately no runtime switch, no config
 * flag and no factory choosing between the two — a toggle would be a third
 * thing to reason about and would outlive its usefulness by exactly one PR.
 *
 * ## Layout
 *
 *   - `assets.sql.ts`        every statement, with the index each one uses
 *   - `assets.rows.ts`       row shapes and column → value conversions
 *   - `assets.dto.ts`        rows → the three wire DTOs
 *   - `assets.read.ts`       batch loaders for the tables a DTO draws on
 *   - `assets.repo.ts`       the read verbs (this file)
 *   - `assets.mutations.ts`  the non-trash writes
 *   - `assets.trash.ts`      soft delete, hard delete, restore
 *
 * ## Two defects fixed rather than reproduced
 *
 * `findListItems` selects seven columns. The Mongo query it replaces is a
 * `find` with no projection at all, so a 1000-row page returns whole
 * documents — vision payloads, transcripts and face embeddings included.
 *
 * The backup-sidecar fallback becomes a keyed lookup. See
 * {@link findLiveAssetIdByPhassetLink}.
 */

import { ObjectId } from '../object-id.ts';
import { toCoreInfo, toDetailDto, toListItemDto, EMPTY_BUNDLE } from './assets.dto.ts';
import { loadBundles, loadCoreBundle, loadLibraries, loadLocations } from './assets.read.ts';
import type { AssetCoreRow, ListItemRow } from './assets.rows.ts';
import {
  ASSET_CORE_BY_ID_SQL,
  ASSET_ID_BY_ADDRESS_SQL,
  ASSET_ID_BY_MAPLE_ID_SQL,
  ASSET_ID_BY_PHASSET_LINK_SQL,
  assetCoreByIdsSql,
  bucketedIds,
  listItemsSql,
} from './assets.sql.ts';
import { sqliteDb, type SqliteDb } from './db-handle.ts';
import type { AssetCoreInfo, AssetDetailDto, AssetListItemDto } from '../assets.transform.ts';

export type { AssetCoreInfo, AssetDetailDto, AssetListItemDto };
export type { SqliteDb } from './db-handle.ts';
export { requeueEnrichmentStage, setHasXmp, setPlaceOverride } from './assets.mutations.ts';
export { hardDelete, markSoftDeleted, restoreFromTrash } from './assets.trash.ts';

/**
 * Parse a hex string into an ObjectId, or `null` when it is malformed, so a
 * route can answer 400 without catching.
 *
 * ObjectId survives the migration on purpose. The schema stores the same
 * 24-character hex strings MongoDB minted, because those strings are already
 * on the wire and in every client's cache keys; `docs/sqlite-schema.md` § keys
 * has the argument. This function is therefore unchanged, down to the
 * exception it swallows.
 */
export function parseAssetId(id: string): ObjectId | null {
  try {
    return new ObjectId(id);
  } catch {
    return null;
  }
}

/** One asset's narrow row, or `null` when there is no such asset. */
async function readCoreRow(db: SqliteDb, hex: string): Promise<AssetCoreRow | null> {
  const rows = await db.read<AssetCoreRow>(ASSET_CORE_BY_ID_SQL, [hex]);
  return rows[0] ?? null;
}

/** Single asset, full detail DTO (used by `GET /api/assets/:id`). */
export async function findDetailById(
  id: ObjectId,
  dbOverride?: SqliteDb,
): Promise<AssetDetailDto | null> {
  const db = sqliteDb(dbOverride);
  const hex = id.toHexString();
  const row = await readCoreRow(db, hex);
  if (!row) return null;
  const [libraries, bundles] = await Promise.all([loadLibraries(db), loadBundles(db, [hex])]);
  return toDetailDto(row, bundles.get(hex) ?? EMPTY_BUNDLE, libraries);
}

/**
 * Bulk variant of {@link findDetailById} for the File Provider's change-batch
 * resolution: one query per table instead of one round trip per asset.
 * Unknown ids are simply absent from the result — the caller maps absence to
 * "deleted", mirroring the single route's 404.
 */
export async function findDetailsByIds(
  ids: ObjectId[],
  dbOverride?: SqliteDb,
): Promise<AssetDetailDto[]> {
  if (ids.length === 0) return [];
  const db = sqliteDb(dbOverride);
  const hexes = bucketedIds(ids.map((id) => id.toHexString()));
  const rows = await db.read<AssetCoreRow>(assetCoreByIdsSql(hexes.length), hexes);
  if (rows.length === 0) return [];
  const found = rows.map((row) => row.id);
  const [libraries, bundles] = await Promise.all([loadLibraries(db), loadBundles(db, found)]);
  return rows.map((row) => toDetailDto(row, bundles.get(row.id) ?? EMPTY_BUNDLE, libraries));
}

/**
 * Single asset resolved by its library and library-relative path rather than
 * by id. Backs `GET /api/assets/by-address`.
 *
 * The browse grid lists directories through `/api/fs/dir-fast`, a pure
 * filesystem walk that deliberately carries no database id, so its assets are
 * keyed by the `slug:relPath` address and the enrichment pane needs a way to
 * reach a detail DTO from that address alone.
 *
 * `relPath` is POSIX, library-root-relative and includes the filename
 * (`"vacation/2024/IMG_1.dng"`, or `"root.dng"` at the library root). The
 * lookup is keyed on the UNIQUE `(library_id, path, filename)` index, which is
 * also what makes it unambiguous: two assets cannot claim the same file.
 */
export async function findDetailByAddress(
  libraryId: ObjectId,
  relPath: string,
  dbOverride?: SqliteDb,
): Promise<AssetDetailDto | null> {
  const normalised = relPath.replace(/^\/+/, '');
  const lastSlash = normalised.lastIndexOf('/');
  // `asset_locations.path` holds the directory only ("" at the library root)
  // and `filename` the basename — split the address the same way.
  const dirPath = lastSlash === -1 ? '' : normalised.slice(0, lastSlash);
  const filename = lastSlash === -1 ? normalised : normalised.slice(lastSlash + 1);
  if (filename === '') return null;

  const db = sqliteDb(dbOverride);
  const matches = await db.read<{ asset_id: string }>(ASSET_ID_BY_ADDRESS_SQL, [
    libraryId.toHexString(),
    dirPath,
    filename,
  ]);
  const assetId = matches[0]?.asset_id;
  if (assetId === undefined) return null;
  return findDetailById(new ObjectId(assetId), db);
}

/**
 * Single asset, minimal info used by routes that drive filesystem or
 * change-feed side effects rather than shipping the full DTO.
 *
 * Reads four tables rather than seven: `assets`, `asset_locations`,
 * `asset_detail` and `folders`, where {@link findDetailById} adds `faces`,
 * the `people` it joins for the display name, and `enrichment_state`. This
 * shape carries neither faces nor enrichment, and it is the hottest read
 * here — every `/api/assets/:id` sub-route resolves through it before it
 * touches disk.
 */
export async function findCoreInfoById(
  id: ObjectId,
  dbOverride?: SqliteDb,
): Promise<AssetCoreInfo | null> {
  const db = sqliteDb(dbOverride);
  const hex = id.toHexString();
  const row = await readCoreRow(db, hex);
  if (!row) return null;
  const [libraries, bundle] = await Promise.all([loadLibraries(db), loadCoreBundle(db, hex)]);
  return toCoreInfo(row, bundle, libraries);
}

/**
 * Filter shape accepted by {@link findListItems}. All fields are optional —
 * routes assemble the subset they need and the repo defaults the rest.
 *
 * ## Two fields mean something different here than on Mongo
 *
 * Both are deliberate and both are pinned by tests in `assets.list.test.ts`;
 * they are written down because an identical signature returning a different
 * set of rows is the worst way to find this out.
 */
export interface ListFilter {
  /**
   * When true (the default), return only *live* assets: not soft-deleted, and
   * holding at least one location that is neither replaced in place
   * (`deleted_at`) nor gone from disk (`missing_since`).
   *
   * The Mongo repo's `findListItems` filters on `deleted_at: null` alone, so
   * it also returns assets whose every location has been tagged missing. That
   * is the outlier, not this: `LIVE_ASSET_FILTER` in
   * `enrichment/meilisearch-vector-coverage.ts` — the definition the search
   * index, the facets and the coverage counts all use — is
   * `deleted_at: null` PLUS `fileinfo: { $elemMatch: { deleted_at: null,
   * missing_since: null } }`, which is exactly the predicate here. The list
   * endpoint was the one live surface disagreeing with the rest of the
   * product, and a working-set enumerator that hands the File Provider files
   * confirmed gone from disk cannot materialise them anyway.
   *
   * The predicate is also load-bearing for the plan: `assets_live_captured` is
   * partial over it, and SQLite only uses a partial index when the query's own
   * `WHERE` provably implies the index's. Relaxing it to `deleted_at IS NULL`
   * costs the ordered index scan, not just the extra rows.
   */
  liveOnly?: boolean;
  /**
   * `has_xmp = 1` or `has_xmp = 0`. `false` matches more rows than Mongo's
   * `{ has_xmp: false }` does, which does not match a document missing the key
   * at all; the column is `NOT NULL DEFAULT 0`, so an asset that never had the
   * field reads as `0` and now matches. That is the more useful answer to "no
   * sidecar", and the schema cannot express the third state without a nullable
   * column — an instance of the tri-state pattern audited in #3778. No route
   * passes `false` today.
   */
  hasXmp?: boolean;
  ratingGte?: number;
  capturedAfterIso?: string;
}

/**
 * The residual predicates and their bound values, in matching order.
 *
 * Built as one pass over the filter rather than by mutating a pair of arrays
 * through successive `if`s, so the SQL fragment and its parameter can never
 * drift apart.
 */
function listResiduals(filter: ListFilter): { clauses: string[]; params: Array<string | number> } {
  const predicates: Array<{ sql: string; value: string | number }> = [
    ...(filter.hasXmp === undefined ? [] : [{ sql: 'has_xmp = ?', value: filter.hasXmp ? 1 : 0 }]),
    ...(filter.ratingGte === undefined ? [] : [{ sql: 'rating >= ?', value: filter.ratingGte }]),
    ...(filter.capturedAfterIso === undefined
      ? []
      : [{ sql: 'captured_at > ?', value: filter.capturedAfterIso }]),
  ];
  return {
    clauses: predicates.map((p) => p.sql),
    params: predicates.map((p) => p.value),
  };
}

/**
 * Bounded list query used by `GET /api/assets`, returning wire DTOs.
 *
 * This is the first of the ticket's two defects. The Mongo version issues a
 * `find` with no projection, so a 1000-row page hands back whole documents:
 * measured at 10 MB of JSON for a page whose DTO needs about 100 KB, because
 * the vision payloads, transcripts and face embeddings ride along and are then
 * discarded by the transform. Here the asset half of the page is seven
 * columns, and the locations are fetched by key for exactly the ids the first
 * query returned.
 *
 * `limit` is clamped to `[1, 20000]` so the route does not have to duplicate
 * the bounds check, and a non-finite `limit` falls back to the default before
 * clamping — `Math.min(Math.max(NaN, 1), 20000)` is NaN, which would otherwise
 * reach the statement as a bind parameter.
 *
 * **A truncated page does not reach an asset with no capture date (#3779).**
 * The page is ordered newest capture first, and `captured_at` is NULL for an
 * asset whose EXIF carries no `DateTimeOriginal` or `CreateDate` — a scan, or
 * a video from a camera that writes neither. SQLite sorts NULL lowest, so
 * those rows sit behind every dated row and a page smaller than the live set
 * never includes them, where the Mongo repo's unsorted `find().limit()` gave
 * them a chance. Fixing it needs a sort key that is never NULL, which is a
 * generated column and an index rather than a change here; #3779 carries the
 * proposal and its query plans. The sort itself stays: an unsorted limited
 * find returns a different subset on every call and cannot be paged at all.
 */
export async function findListItems(
  filter: ListFilter,
  limit: number,
  dbOverride?: SqliteDb,
): Promise<AssetListItemDto[]> {
  const db = sqliteDb(dbOverride);
  const { clauses, params } = listResiduals(filter);
  const safeLimit = Number.isFinite(limit) && limit >= 1 ? limit : 1000;
  const clamped = Math.min(Math.max(safeLimit, 1), 20000);
  const sql = listItemsSql(clauses, filter.liveOnly !== false);
  const rows = await db.read<ListItemRow>(sql, [...params, clamped]);
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);
  const [libraries, locations] = await Promise.all([loadLibraries(db), loadLocations(db, ids)]);
  return rows.map((row) => toListItemDto(row, locations.get(row.id) ?? [], libraries));
}

/**
 * The backup-sidecar primary lookup: an asset with this content-dedup id that
 * still holds a live location in this library.
 *
 * `POST /api/backup/sidecar` resolves the asset it is writing a sidecar for
 * this way first, because a content-duplicate photo — already uploaded from
 * another device, or re-imported under a new PHAsset local id — carries no
 * link for the device now asking, so the fallback below misses even though the
 * asset and its bytes exist.
 */
export async function findLiveAssetIdByMapleId(
  mapleId: string,
  libraryId: ObjectId,
  dbOverride?: SqliteDb,
): Promise<ObjectId | null> {
  const db = sqliteDb(dbOverride);
  const rows = await db.read<{ id: string }>(ASSET_ID_BY_MAPLE_ID_SQL, [
    mapleId,
    libraryId.toHexString(),
  ]);
  const id = rows[0]?.id;
  return id === undefined ? null : new ObjectId(id);
}

/**
 * The backup-sidecar fallback lookup — the second of the ticket's two defects,
 * and both halves of it are fixed by the table rather than by this function.
 *
 * On Mongo the same lookup is two dotted paths over `phasset_links[]` with no
 * index behind either, which the slow-query log recorded scanning 288,000
 * documents for 3 to 6 seconds. `asset_phasset_links` indexes the pair, so it
 * becomes a seek — measured under 0.01 ms at every library size the schema
 * benchmark generates, and pinned by a query-plan assertion rather than by a
 * timing, because a timing on a small database proves nothing.
 *
 * Dotted paths also let *different* array entries satisfy the two conditions,
 * so an asset linked to `(deviceA, id1)` and `(deviceB, id2)` answers a lookup
 * for `(deviceA, id2)` today — every sibling route uses `$elemMatch` and this
 * one does not. A device and a local id are columns of one row here, so that
 * mismatch cannot be expressed.
 */
export async function findLiveAssetIdByPhassetLink(
  deviceId: string,
  phassetLocalId: string,
  libraryId: ObjectId,
  dbOverride?: SqliteDb,
): Promise<ObjectId | null> {
  const db = sqliteDb(dbOverride);
  const rows = await db.read<{ id: string }>(ASSET_ID_BY_PHASSET_LINK_SQL, [
    deviceId,
    phassetLocalId,
    libraryId.toHexString(),
  ]);
  const id = rows[0]?.id;
  return id === undefined ? null : new ObjectId(id);
}

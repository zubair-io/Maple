/**
 * Every statement the ported assets repository runs, in one place.
 *
 * The SQL is separated from the functions that call it for one reason: the
 * shape of these queries is the performance argument, and a reviewer should be
 * able to read all of it at once and check it against
 * `docs/sqlite-schema.md`'s query-to-index map without stepping through
 * TypeScript. Three shapes in here are load-bearing.
 *
 * **The list query is narrow.** {@link LIST_ITEMS_SQL} names seven columns.
 * The Mongo query it replaces is a `find` with no projection, so a 1000-row
 * page returns whole documents — measured at 10 MB of JSON, most of it vision
 * payloads and face embeddings the list DTO never looks at. Because `assets`
 * declares its two JSON columns last and neither is named here, SQLite stops
 * reading each row before it reaches them.
 *
 * **Anything that filters assets by a location is a semi-join.** `EXISTS`
 * keeps `assets` (or, for the phasset lookup, the link table) as the outer
 * loop, so an ordered index scan can terminate at the limit. Written as an
 * inner join the planner is free to lead with `asset_locations`, scan a whole
 * library and sort every row of it to return a page: measured at 51.3 ms
 * against 0.36 ms on 60,000 assets.
 *
 * **The live predicate is spelled exactly one way.** SQLite only uses a
 * partial index when the query's own `WHERE` provably implies the index's, and
 * the implication test is textual enough that a paraphrase silently loses the
 * index. {@link LIVE_ASSET_PREDICATE} is imported from the DDL rather than
 * retyped here so the two cannot drift.
 */

import { LIVE_ASSET_PREDICATE } from '../ddl/assets.ts';
import { placeholders } from './values.ts';

/**
 * The id list a batch loader binds, padded so its length is a power of two.
 *
 * A positional `IN (…)` puts the id count into the SQL *text*, so a loader
 * called with 37 ids and then 38 prepares two statements. The worker keeps
 * `STATEMENT_CACHE_LIMIT` of them (`../protocol.ts`) and finalises the rest,
 * so a change-batch endpoint whose page size varies with the data would churn
 * the cache and re-prepare a statement per call — including, at the list
 * query's ceiling, one holding 20,000 placeholders.
 *
 * Rounding the count up to a power of two caps each loader at sixteen distinct
 * texts over the whole 1-to-32,768 range, which fits the cache with room for
 * every other statement in the module. The padding repeats the last id, and `IN` is set
 * membership, so neither the rows returned nor their order changes — the
 * loaders group by `asset_id` afterwards regardless. `bun:sqlite` binds well
 * past the 32,768 the largest bucket needs (checked at 40,000).
 */
export function bucketedIds(ids: readonly string[]): string[] {
  const last = ids.at(-1);
  if (last === undefined) return [];
  const size = 2 ** Math.ceil(Math.log2(ids.length));
  return [...ids, ...Array.from({ length: size - ids.length }, () => last)];
}

/**
 * The asset row behind the detail and core-info DTOs.
 *
 * `exif` and `place` come last because the table declares them last: SQLite
 * reads a row's columns in declaration order and stops once the statement has
 * what it asked for, so naming them last is what keeps their overflow pages
 * out of the queries that do not need them.
 */
const ASSET_CORE_COLUMNS = `
  id, size, mtime, indexed_at,
  rating, flag, color_label, has_xmp, sidecar_ver,
  hidden, hidden_reason, hidden_ack, is_screenshot,
  deleted_at, deleted_reason, original_path, maple_id,
  exif, place`;

export const ASSET_CORE_BY_ID_SQL = `SELECT ${ASSET_CORE_COLUMNS} FROM assets WHERE id = ?`;

export function assetCoreByIdsSql(count: number): string {
  return `SELECT ${ASSET_CORE_COLUMNS} FROM assets WHERE id IN (${placeholders(count)}) ORDER BY id`;
}

/**
 * The narrow list projection — defect (1) of the ticket, fixed rather than
 * reproduced.
 *
 * `ORDER BY captured_at DESC, id` is what lets `assets_live_captured` serve
 * the page: an ordered partial index the scan can abandon at the limit,
 * instead of a table scan that reads every live row before applying one. The
 * Mongo query has no sort at all and therefore returns documents in whatever
 * order the storage engine hands them over, so imposing this one makes the
 * endpoint's output stable across calls as well as cheaper.
 *
 * It also costs something, and the cost is not obvious: SQLite sorts NULL
 * lowest, so an asset whose EXIF carries no capture date sits behind every
 * dated row and a page smaller than the live set never reaches it. #3779
 * tracks the fix — a `COALESCE(captured_at, indexed_at)` generated column and
 * a partial index over it, which is DDL and so belongs to the schema PR.
 *
 * `residuals` carries the optional `has_xmp` / `rating` / `captured_at`
 * filters. They are interpolated as fixed SQL fragments with their values
 * bound, so the statement text stays inside the worker's prepared-statement
 * cache.
 *
 * `INDEXED BY` is a deliberate instruction to the planner, not a hint it may
 * ignore, and it is here because without it a filtered page takes the wrong
 * plan. Given `has_xmp = ?` the planner prefers `assets_live` — a range seek
 * on `live_location_count > 0` — and then sorts the entire live set to satisfy
 * the ORDER BY. Walking the ordered index and stopping at the limit is what
 * makes a page cost the page rather than the library. The directive is applied
 * only when the live predicate is present, because the index is partial and
 * would be unusable otherwise; SQLite fails the statement outright if the
 * named index ever stops existing, which is the failure worth having.
 */
export function listItemsSql(residuals: readonly string[], liveOnly: boolean): string {
  const live = liveOnly ? [LIVE_ASSET_PREDICATE] : [];
  const clauses = [...live, ...residuals];
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const indexedBy = liveOnly ? 'INDEXED BY assets_live_captured' : '';
  return `
    SELECT id, mtime, rating, has_xmp, hidden, hidden_reason, hidden_ack
      FROM assets ${indexedBy}
      ${where}
     ORDER BY captured_at DESC, id
     LIMIT ?`;
}

/**
 * Every location of every asset in the batch, in array order.
 *
 * Keyed on `asset_id` for a set of ids the caller already has, which is the
 * probe half of the semi-join: `assets` decided which rows to return, and this
 * fills in their `fileinfo` arrays. It never influences which assets come back.
 */
export function locationsByAssetIdsSql(count: number): string {
  return `
    SELECT asset_id, ordinal, library_id, path, filename,
           deleted_at, missing_since, missing_reason, keep
      FROM asset_locations
     WHERE asset_id IN (${placeholders(count)})
     ORDER BY asset_id, ordinal`;
}

/**
 * Faces with their person's display name already resolved.
 *
 * One statement where the Mongo repo needs two round trips — the document,
 * then an `$in` over `people` for the ids its faces referenced.
 *
 * That repo also has to canonicalise the id's case and discard malformed hex
 * before building the `$in`, because `faces[].person_id` is a free-form string
 * on Mongo and one bad value would throw for the whole asset. Here it is a
 * foreign key into `people`, so a value that does not name a real person
 * cannot be stored at all and the join needs no defence.
 */
export function facesByAssetIdsSql(count: number): string {
  return `
    SELECT f.asset_id, f.face_index, f.person_id, f.confidence,
           f.bbox_x, f.bbox_y, f.bbox_w, f.bbox_h, f.hidden,
           f.landmarks, f.embedding, f.embedding_version,
           p.name AS person_name
      FROM faces f
      LEFT JOIN people p ON p.id = f.person_id
     WHERE f.asset_id IN (${placeholders(count)})
     ORDER BY f.asset_id, f.face_index`;
}

/**
 * `metadata_override` rides along with the describe-stage payloads because the
 * `sidecar-metadata-index` handler compares the stored override's coordinates
 * against the ones it just parsed, and re-arms `geocode` only when they differ.
 * Without the column that comparison always sees "no stored coordinates" and
 * re-geocodes on every reconcile. It costs nothing to carry: the row is already
 * being read for the columns beside it.
 */
export function detailByAssetIdsSql(count: number): string {
  return `
    SELECT asset_id, description, description_meta, ocr_text, ocr_meta,
           vision, vision_meta, transcript, video_description, video_description_meta,
           metadata_override
      FROM asset_detail
     WHERE asset_id IN (${placeholders(count)})`;
}

export function enrichmentByAssetIdsSql(count: number): string {
  return `
    SELECT asset_id, stage, done_at, locked_by, lease_expires_at,
           attempts, last_error, version, dead_letter_at
      FROM enrichment_state
     WHERE asset_id IN (${placeholders(count)})`;
}

/** Library roots, for resolving a location into an absolute path. */
export const LIBRARY_ROOTS_SQL = `SELECT id, path FROM folders`;

/**
 * One asset addressed by `(library, directory, filename)`.
 *
 * A keyed lookup on the UNIQUE `asset_locations_lib_path_name` index, which is
 * also what makes the answer unambiguous: two assets cannot claim the same
 * file, so there is at most one row and no "first match wins" rule to get
 * wrong. Liveness is deliberately not part of the predicate — the Mongo
 * `$elemMatch` it replaces does not filter on it either, so a trashed location
 * still resolves its asset.
 */
export const ASSET_ID_BY_ADDRESS_SQL = `
  SELECT asset_id FROM asset_locations
   WHERE library_id = ? AND path = ? AND filename = ?
   LIMIT 1`;

/**
 * The backup-sidecar primary lookup: a content-dedup id, scoped to a library
 * the asset still has a live location in.
 *
 * `assets_maple_id` answers the first predicate; the library scope is an
 * `EXISTS` rather than a join so the planner probes one location per candidate
 * instead of leading with the location table.
 *
 * The `IS NOT NULL` after the equality is not redundant. `assets_maple_id` is
 * a UNIQUE partial index over `maple_id IS NOT NULL` — skeleton rows carry no
 * dedup key and must not collide with each other — and SQLite only uses a
 * partial index when the query's own `WHERE` provably implies the index's.
 * `maple_id = ?` alone does not, because the bound value is unknown when the
 * statement is planned, so without it this lookup is a table scan.
 *
 * "Non-empty" is deliberately *not* repeated here. The schema moved that half
 * of the guarantee to a CHECK on the column, precisely so the index predicate
 * stays to what a query's `WHERE` will contain verbatim; see
 * `docs/sqlite-schema.md` § "The implication test is textual".
 */
export const ASSET_ID_BY_MAPLE_ID_SQL = `
  SELECT a.id FROM assets a
   WHERE a.maple_id = ? AND a.maple_id IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM asset_locations l
        WHERE l.asset_id = a.id AND l.library_id = ? AND l.deleted_at IS NULL)
   LIMIT 1`;

/**
 * The backup-sidecar fallback lookup — defect (2) of the ticket.
 *
 * On Mongo this is `{ 'phasset_links.device_id': …, 'phasset_links.phasset_local_id': … }`:
 * two dotted paths over an array with no index behind either, which the slow
 * query log recorded scanning 288,000 documents for 3 to 6 seconds. It is also
 * wrong, because dotted paths let *different* array entries satisfy the two
 * conditions — an asset linked to `(deviceA, id1)` and `(deviceB, id2)`
 * answers a lookup for `(deviceA, id2)`.
 *
 * As rows both problems disappear at once. The two columns are one index
 * (`asset_phasset_links_device_local`), so the lookup is a seek; and a device
 * and a local id are columns of the same row, so the mismatch cannot be
 * expressed. The library scope stays an `EXISTS` so the seek still leads.
 */
export const ASSET_ID_BY_PHASSET_LINK_SQL = `
  SELECT p.asset_id AS id FROM asset_phasset_links p
   WHERE p.device_id = ? AND p.phasset_local_id = ?
     AND EXISTS (
       SELECT 1 FROM asset_locations l
        WHERE l.asset_id = p.asset_id AND l.library_id = ? AND l.deleted_at IS NULL)
   LIMIT 1`;

/** The three text sources and the month the search blob is recomposed from. */
export const SEARCH_BLOB_INPUTS_SQL = `
  SELECT json_extract(a.place, '$.search_blob') AS place_search_blob,
         a.captured_month AS captured_month,
         d.description AS description,
         d.ocr_text AS ocr_text
    FROM assets a
    LEFT JOIN asset_detail d ON d.asset_id = a.id
   WHERE a.id = ?`;

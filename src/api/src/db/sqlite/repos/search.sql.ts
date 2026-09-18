/**
 * Every statement the ported search and facet queries run, in one place.
 *
 * Separated from the functions that call them for the same reason
 * `assets.sql.ts` is: the shape of these queries *is* the performance argument,
 * and a reviewer should be able to read all of it at once and check it against
 * the query-to-index map in `docs/sqlite-schema.md` without stepping through
 * TypeScript.
 *
 * ## What each facet costs, and why
 *
 * Facet counts are the slowest thing the API does today — 4.7 to 5.7 seconds
 * each on production, warm or cold, because `assets` occupies 8.8 GB against a
 * 1.5 GB cache and every pass reads from disk. Three things make them
 * milliseconds here:
 *
 *  1. **The group keys are the index.** `assets_facet_camera` is
 *     `(camera_make, camera_model)` over live rows, so the camera facet is an
 *     index-only scan that never reads an asset row at all. Same for lens,
 *     place and screenshot.
 *  2. **`live_location_count` is a column.** Every facet's base predicate is
 *     the live one, and as a column it folds into each partial index's `WHERE`.
 *     Written as an `EXISTS` sub-select instead, the same count costs 151 ms at
 *     335k rows and 460 ms at 1M, against 3.7 ms and 13.4 ms — which is why
 *     that column survived the migration.
 *  3. **They run on readers.** `SqlitePool.read` picks the least busy reader
 *     thread, so twelve concurrent aggregates cannot delay a grid page on the
 *     writer. This is the reason the pool has readers at all.
 *
 * Three facets cannot be index-only, and it is worth knowing which. Extensions
 * must reach `asset_locations` for a filename; scene and activity must reach
 * `asset_detail`; people must scan `faces`. Each of those is a keyed probe into
 * an index built for it, not a scan.
 *
 * ## The one rule a change here can silently break
 *
 * A grid page filtered by a location must stay a semi-join. An inner join lets
 * the planner lead with `asset_locations` and sort a whole library to return
 * 200 rows: measured at 50.18 ms against 0.07 ms. The clauses that do this live
 * in `search.where.ts`; what lives here is the other half — the explicit
 * `INDEXED BY` on the page query. See {@link pageSql}.
 */

import { placeholders } from './assets.sql.ts';
import { FTS_RANK_ORDER, FTS_RANK_SQL } from './search.fts.ts';
import {
  QUALIFIED_LIVE_PREDICATE,
  searchWhereSql,
  type BoundPredicate,
  type SearchWhere,
} from './search.where.ts';
import type { SqlValue } from '../protocol.ts';

/** A complete statement and its bound values. */
export interface BoundStatement {
  sql: string;
  params: SqlValue[];
}

/**
 * The tables a search reads from.
 *
 * Without a text query that is `assets` alone. With one, FTS5 leads: the
 * inverted index is by far the most selective thing in the query, and joining
 * outward from it to `asset_search` and then to `assets` by primary key is two
 * keyed probes per hit. This is the one place an inner join is right, and it is
 * right for the same reason the semi-join is right elsewhere — the smallest
 * driving set goes first.
 */
function fromClause(where: SearchWhere): string {
  if (where.match === null) return 'FROM assets';
  return `FROM assets_fts
      JOIN asset_search ON asset_search.rowid = assets_fts.rowid
      JOIN assets ON assets.id = asset_search.asset_id`;
}

/** `SELECT <projection> FROM … WHERE …`, with `suffix` appended verbatim. */
function statement(
  projection: string,
  where: SearchWhere,
  suffix = '',
  extra?: BoundPredicate,
  extraParams: readonly SqlValue[] = [],
  from = fromClause(where),
): BoundStatement {
  const bound = searchWhereSql(where, extra);
  return {
    sql: `SELECT ${projection}\n    ${from}\n   ${bound.sql}\n   ${suffix}`,
    params: [...bound.params, ...extraParams],
  };
}

/**
 * How many live assets match — the `total` on every search response, the facet
 * total, and the Meili branch's live count.
 *
 * Counts exactly the `FROM` and `WHERE` the page query uses. That identity is
 * not a tidiness argument: the Meilisearch branch once post-filtered a single
 * page and reported a count from a different predicate, which showed the user a
 * large number beside an empty grid. Sharing one composition makes the two
 * unable to disagree, and the tests hold every filter combination to it.
 */
export function countSql(where: SearchWhere): BoundStatement {
  return statement('COUNT(*) AS n', where);
}

/**
 * Sort tokens the wire accepts, as `ORDER BY` bodies.
 *
 * `name` reads the canonical entry's filename through a correlated sub-query
 * rather than a join. The probe is index-only on `asset_locations_primary_entry`
 * — partial over `ordinal = 0`, covering `(asset_id, library_id, path,
 * filename)` — and, unlike a join, it cannot multiply a row that has several
 * locations. It also answers a question Mongo could not: the multikey sort it
 * uses orders by the *smallest* filename in the array, which is not the
 * canonical entry whenever an asset has been deduplicated across locations.
 */
const ORDER_BY: Readonly<Record<string, string>> = {
  captured_desc: 'assets.captured_at DESC, assets.id',
  captured_asc: 'assets.captured_at ASC, assets.id',
  rating: 'assets.rating DESC, assets.captured_at DESC, assets.id',
  name: `(SELECT l.filename FROM asset_locations l
             WHERE l.asset_id = assets.id AND l.ordinal = 0), assets.id`,
};

/**
 * Sorts whose `ORDER BY` the live capture index can serve directly, and which
 * therefore want the explicit `INDEXED BY` below.
 */
const CAPTURE_SORTS = new Set(['captured_desc', 'captured_asc']);

/** The narrow asset projection a search result row is built from. */
const PAGE_COLUMNS = `assets.id, assets.size, assets.mtime, assets.indexed_at,
           assets.rating, assets.flag, assets.color_label, assets.has_xmp, assets.hidden,
           assets.exif, assets.place`;

/**
 * One page of the grid.
 *
 * `INDEXED BY assets_live_captured` is a deliberate instruction to the planner,
 * not a hint it may ignore, and it is here because without it a *filtered* page
 * takes the wrong plan. Given a residual the planner likes — `has_xmp = ?` was
 * the one that surfaced this during #3746 — it prefers a different partial
 * index, seeks on that, and then sorts the entire live set to satisfy the
 * `ORDER BY`. Walking the ordered index and stopping at the limit is what makes
 * a page cost the page rather than the library.
 *
 * It is applied only when the plan it names is actually available: the index is
 * partial over the live predicate, and it cannot serve a text query, whose
 * order is a computed rank rather than a stored column. SQLite fails the
 * statement outright if the named index ever stops existing, which is the
 * failure worth having.
 */
export function pageSql(
  where: SearchWhere,
  sort: string,
  limit: number,
  offset: number,
  seek?: BoundPredicate,
): BoundStatement {
  const ranked = where.match !== null;
  const projection = ranked ? `${PAGE_COLUMNS},\n           ${FTS_RANK_SQL}` : PAGE_COLUMNS;
  const order = ranked
    ? `${FTS_RANK_ORDER}, assets.captured_at DESC, assets.id`
    : (ORDER_BY[sort] ?? ORDER_BY.captured_desc!);
  const from =
    !ranked && CAPTURE_SORTS.has(sort)
      ? 'FROM assets INDEXED BY assets_live_captured'
      : fromClause(where);
  return statement(
    projection,
    where,
    `ORDER BY ${order}\n   LIMIT ? OFFSET ?`,
    seek,
    [limit, offset],
    from,
  );
}

/**
 * The seek predicate that resumes iteration after a cursor, in the same order
 * `pageSql` imposes.
 *
 * Assets with no capture date form one contiguous group, and both engines put
 * it in the same place: MongoDB because BSON sorts Null below String, SQLite
 * because it sorts NULL first ascending and last descending. So the group is
 * the tail of a descending page and the head of an ascending one, and the
 * predicate has to span that boundary exactly once — hence the extra
 * `IS NULL` arm when descending out of the dated rows, and the extra
 * `IS NOT NULL` arm when ascending out of the undated ones.
 *
 * `cursor.i` is a validated 24-character hex string by the time it arrives
 * (`decodeCursor` in `routes/search/cursor.ts`), and it is bound rather than
 * interpolated regardless.
 */
export function seekPredicate(cursor: {
  v: string | null;
  i: string;
  d: 'asc' | 'desc';
}): BoundPredicate {
  if (cursor.v === null) {
    return cursor.d === 'desc'
      ? { sql: '(assets.captured_at IS NULL AND assets.id > ?)', params: [cursor.i] }
      : {
          sql: `((assets.captured_at IS NULL AND assets.id > ?)
             OR assets.captured_at IS NOT NULL)`,
          params: [cursor.i],
        };
  }
  const beyond = cursor.d === 'desc' ? 'assets.captured_at < ?' : 'assets.captured_at > ?';
  const tail = cursor.d === 'desc' ? ' OR assets.captured_at IS NULL' : '';
  return {
    sql: `(${beyond}
         OR (assets.captured_at = ? AND assets.id > ?)${tail})`,
    params: [cursor.v, cursor.v, cursor.i],
  };
}

/**
 * The twelve facet aggregations, in the order the route destructures them.
 *
 * Each is a separate statement rather than one pass with twelve counters,
 * because each wants its own index and the pool can run them concurrently on
 * different readers. That is also how the Mongo route does it, so the shapes
 * line up one to one.
 */
export function facetStatements(where: SearchWhere): Record<FacetName, BoundStatement> {
  return {
    total: countSql(where),
    cameras: statement(
      'assets.camera_make AS make, assets.camera_model AS model, COUNT(*) AS count',
      where,
      'GROUP BY assets.camera_make, assets.camera_model ORDER BY count DESC LIMIT 50',
    ),
    lenses: statement(
      'assets.lens AS value, COUNT(*) AS count',
      where,
      'GROUP BY assets.lens ORDER BY count DESC LIMIT 50',
    ),
    // The one facet that must read a filename. `rtrim`/`replace` is the
    // standard SQLite idiom for "text after the last dot", and it degenerates
    // the same way `$split` + `$arrayElemAt: -1` does: a name with no dot
    // reports itself, a name ending in one reports the empty string, and the
    // HAVING drops the latter exactly as the Mongo `$nin: [null, '']` did.
    extensions: statement(
      `lower(replace(l.filename, rtrim(l.filename, replace(l.filename, '.', '')), '')) AS value,
           COUNT(*) AS count`,
      where,
      `GROUP BY value HAVING value <> '' ORDER BY count DESC LIMIT 50`,
      undefined,
      [],
      `${fromClause(where)}\n      JOIN asset_locations l ON l.asset_id = assets.id AND l.ordinal = 0`,
    ),
    iso_range: statement('MIN(assets.iso) AS min, MAX(assets.iso) AS max', where),
    // `min`/`max` rather than the `from`/`to` the wire uses: both are SQL
    // keywords, and the caller has to rename one pair or quote the other.
    capture_range: statement(
      'MIN(assets.captured_at) AS min, MAX(assets.captured_at) AS max',
      where,
    ),
    scene_types: detailFacetSql(where, 'vision_scene_type', 20),
    activities: detailFacetSql(where, 'vision_activity', 50),
    subjects: statement(
      'subject.value AS value, COUNT(*) AS count',
      where,
      `GROUP BY value HAVING value <> '' ORDER BY count DESC LIMIT 50`,
      undefined,
      [],
      `${fromClause(where)}
      JOIN asset_detail d ON d.asset_id = assets.id,
           json_each(COALESCE(json_extract(d.vision, '$.subjects'), '[]')) AS subject`,
    ),
    // Two buckets, not three. The column is NOT NULL DEFAULT 0, so "never
    // classified" and "classified as not a screenshot" are one value; the route
    // reports `unknown: 0`. Tracked as #3761 — if that ticket makes the column
    // nullable, a third group appears here and the route's mapping already has
    // a place to put it.
    is_screenshot: statement(
      'assets.is_screenshot AS bucket, COUNT(*) AS count',
      where,
      'GROUP BY assets.is_screenshot',
    ),
    // Counts assets per person, not faces: a group shot with the same person
    // detected twice counts once, which is what `$setUnion` gave on Mongo.
    // `faces` leads because it is the smaller table and `faces_person` is
    // `(person_id, asset_id)` partial over assigned, unhidden faces — so the
    // scan is index-only and the probe into `assets` is by primary key.
    people: statement(
      'f.person_id AS id, COUNT(DISTINCT f.asset_id) AS count',
      where,
      'GROUP BY f.person_id ORDER BY count DESC LIMIT 100',
      { sql: 'f.person_id IS NOT NULL AND f.hidden = 0', params: [] },
      [],
      `FROM faces f\n      JOIN assets ON assets.id = f.asset_id${
        where.match === null
          ? ''
          : `\n      JOIN asset_search ON asset_search.asset_id = assets.id
      JOIN assets_fts ON assets_fts.rowid = asset_search.rowid`
      }`,
    ),
    places: statement(
      'assets.place_locality AS locality, assets.place_region AS region, COUNT(*) AS count',
      where,
      `GROUP BY assets.place_locality, assets.place_region ORDER BY count DESC LIMIT 100`,
      {
        sql: `((assets.place_locality IS NOT NULL AND assets.place_locality <> '')
          OR (assets.place_region IS NOT NULL AND assets.place_region <> ''))`,
        params: [],
      },
    ),
  };
}

/** The two `asset_detail` facets, which differ only in column and cap. */
function detailFacetSql(
  where: SearchWhere,
  column: 'vision_scene_type' | 'vision_activity',
  limit: number,
): BoundStatement {
  return statement(
    `d.${column} AS value, COUNT(*) AS count`,
    where,
    `GROUP BY value ORDER BY count DESC LIMIT ${limit}`,
    { sql: `d.${column} IS NOT NULL AND d.${column} <> ''`, params: [] },
    [],
    `${fromClause(where)}\n      JOIN asset_detail d ON d.asset_id = assets.id`,
  );
}

/** The keys of {@link facetStatements}, which are the response's own fields. */
export type FacetName =
  | 'total'
  | 'cameras'
  | 'lenses'
  | 'extensions'
  | 'iso_range'
  | 'capture_range'
  | 'scene_types'
  | 'activities'
  | 'subjects'
  | 'is_screenshot'
  | 'people'
  | 'places';

/**
 * The timeline histogram: one row per (year, month) that has photos in it.
 *
 * `captured_year` and `captured_month` are pre-extracted by the EXIF stage and
 * indexed as a pair, so this groups an index rather than parsing a date per
 * row — the same reason the Mongo pipeline groups the pre-computed fields
 * instead of calling `$dateFromString`.
 */
export function timedBucketsSql(where: SearchWhere): BoundStatement {
  return statement(
    'assets.captured_year AS year, assets.captured_month AS month, COUNT(*) AS count',
    where,
    `GROUP BY assets.captured_year, assets.captured_month
    ORDER BY year DESC, month DESC`,
    { sql: 'assets.captured_year IS NOT NULL', params: [] },
  );
}

/** How many matching assets carry no capture date at all. */
export function untimedCountSql(where: SearchWhere): BoundStatement {
  return statement('COUNT(*) AS n', where, '', {
    sql: 'assets.captured_at IS NULL',
    params: [],
  });
}

/**
 * The caption for a page of assets, and nothing else from `asset_detail`.
 *
 * Deliberately not `detailByAssetIdsSql`, which names ten columns including
 * `vision` and `transcript`. `asset_detail` is the largest table in the
 * database and a search result carries one string out of it, so this reads two
 * columns and stops — the same reasoning that put the table on the far side of
 * a join in the first place.
 */
export function descriptionsByAssetIdsSql(count: number): string {
  return `SELECT asset_id, description FROM asset_detail
           WHERE asset_id IN (${placeholders(count)})`;
}

/**
 * The PhotoKit links a search result carries, in the order they were added.
 *
 * `ORDER BY id` is the array order the former `phasset_links[]` had, since the
 * rowid is assigned on insert; the merged timeline reads the set rather than a
 * position, but a stable order keeps a response byte-identical across calls.
 */
export function phassetLinksByAssetIdsSql(count: number): string {
  return `SELECT asset_id, device_id, phasset_local_id, phasset_cloud_id, first_seen
            FROM asset_phasset_links
           WHERE asset_id IN (${placeholders(count)})
           ORDER BY asset_id, id`;
}

/**
 * The service search route's ranked fallback, which has its own filter shape
 * rather than the `/api/search` query string.
 *
 * It answers with `maple_id` rather than an asset id, because that is the
 * identifier the Meilisearch index it stands in for is keyed on. Assets with no
 * `maple_id` are dropped here rather than in the caller — the Mongo version
 * projects the field and filters out non-strings afterwards, which is the same
 * set.
 */
export function serviceTextSearchSql(scope: string): string {
  return `
  SELECT assets.maple_id AS maple_id, ${FTS_RANK_SQL}
    FROM assets_fts
    JOIN asset_search ON asset_search.rowid = assets_fts.rowid
    JOIN assets ON assets.id = asset_search.asset_id
   WHERE assets_fts MATCH ?
     AND ${QUALIFIED_LIVE_PREDICATE}
     AND assets.maple_id IS NOT NULL AND assets.maple_id <> ''${scope}
   ORDER BY ${FTS_RANK_ORDER}
   LIMIT ?`;
}

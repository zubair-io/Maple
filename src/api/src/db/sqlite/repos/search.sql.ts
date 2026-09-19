/**
 * The page, the count and the seek — every statement a search runs that is not
 * a facet.
 *
 * Separated from the functions that call them for the same reason
 * `assets.sql.ts` is: the shape of these queries *is* the performance argument,
 * and a reviewer should be able to read all of it at once and check it against
 * the query-to-index map in `docs/sqlite-schema.md` without stepping through
 * TypeScript. The twelve facet aggregations were here too until #3768 gave six
 * of them a second shape; they are in `search.facets.sql.ts` now, and the three
 * composition helpers below are exported for it.
 *
 * ## Why the count is milliseconds
 *
 * Counting live assets is the slowest thing the API does on MongoDB — 4.7 to
 * 5.7 seconds, warm or cold, because `assets` occupies 8.8 GB against a 1.5 GB
 * cache and every pass reads from disk. Two things make it 6 ms here.
 * `live_location_count` is a column, so the live predicate folds into a partial
 * index's `WHERE`; written as an `EXISTS` sub-select the same count costs
 * 151 ms at 335k rows and 460 ms at 1M, against 3.7 ms and 13.4 ms. And it runs
 * on a reader — `SqlitePool.read` picks the least busy reader thread, so a
 * dozen concurrent aggregates cannot delay a grid page on the writer, which is
 * the reason the pool has readers at all.
 *
 * ## The one rule a change here can silently break
 *
 * A grid page filtered by a location must stay a semi-join. An inner join lets
 * the planner lead with `asset_locations` and sort a whole library to return
 * 200 rows: measured at 50.18 ms against 0.07 ms. The clauses that do this live
 * in `search.where.ts`; what lives here is the other half — the explicit
 * `INDEXED BY` on the page query. See {@link pageSql}.
 */

import { placeholders } from './values.ts';
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
 *
 * A text query no row can satisfy also leads with `assets`: there is no
 * expression to hand `MATCH`, the `WHERE` is the constant `0`, and joining an
 * inverted index to prove that is work for nothing.
 */
export function fromClause(where: SearchWhere): string {
  if (where.match.kind !== 'match') return 'FROM assets';
  return `FROM assets_fts
      JOIN asset_search ON asset_search.rowid = assets_fts.rowid
      JOIN assets ON assets.id = asset_search.asset_id`;
}

/**
 * Whether the page and the range facets may name their index.
 *
 * `INDEXED BY` is an instruction the planner must be able to honour, and it
 * cannot honour one on a statement whose `WHERE` it has already folded to
 * false — it fails to prepare with "no query solution". So an unmatchable text
 * query gives up the hint, which costs nothing: the statement returns no rows
 * either way.
 */
export function canNameIndex(where: SearchWhere): boolean {
  return where.match.kind === 'none';
}

/**
 * `SELECT <projection> FROM … WHERE …`, with `suffix` appended verbatim.
 *
 * The one place a search statement is assembled, so every one of them carries
 * the live predicate, the visibility filter and the residuals in the same order
 * with their parameters bound in the order the placeholders appear. A facet
 * that composed its own `WHERE` could disagree with the count about which
 * assets exist, which is the defect `search.facets.test.ts` exists to catch.
 */
export function statement(
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
  const ranked = where.match.kind === 'match';
  const projection = ranked ? `${PAGE_COLUMNS},\n           ${FTS_RANK_SQL}` : PAGE_COLUMNS;
  const order = ranked
    ? `${FTS_RANK_ORDER}, assets.captured_at DESC, assets.id`
    : (ORDER_BY[sort] ?? ORDER_BY.captured_desc!);
  const from =
    canNameIndex(where) && CAPTURE_SORTS.has(sort)
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
 * The assets behind one page of Meilisearch hits.
 *
 * Meilisearch answers with `maple_id`s ranked by relevance, and the row behind
 * each one still has to come from here — the sidecar holds an index, not the
 * source of truth. So this is the page query with the ordering, the limit and
 * the offset taken off it: Meilisearch already decided which assets and in what
 * order, and re-imposing a capture-date sort would throw that away.
 *
 * `maple_id` rides along in the projection because the caller has to put the
 * rows back into the sidecar's order, and the id is the only thing the two
 * sides share.
 *
 * The `where` arriving here never carries a text match — {@link searchByMapleIds}
 * strips it, for the reason that function records — so the `FROM` is the plain
 * `assets` one and the structured filters apply exactly as they do on the
 * database path.
 */
export function mapleIdPageSql(where: SearchWhere, mapleIds: readonly string[]): BoundStatement {
  return statement(`${PAGE_COLUMNS},\n           assets.maple_id`, where, '', {
    sql: `assets.maple_id IN (${placeholders(mapleIds.length)})`,
    params: [...mapleIds],
  });
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

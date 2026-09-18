/**
 * Search repository — the SQLite port of the `/api/search*` route family's data
 * layer and of the two `$text` call sites (#3750).
 *
 * ## Why both implementations exist right now
 *
 * MongoDB is still the live database. Nothing here is wired into a route yet
 * and the Mongo code is untouched and still serving every request. That is the
 * same staged shape the connection pool (#3742), the schema (#3743), the test
 * harness (#3745) and the assets repository (#3746) landed in: build the
 * replacement beside the original, prove it, then switch the imports in one
 * reviewable commit (#3752). There is deliberately no runtime switch, no config
 * flag and no factory choosing between the two.
 *
 * ## What the cutover will do
 *
 * The Mongo routes build a filter once and use it several times:
 *
 * ```ts
 * const filter = buildFilter(query, dropIds, peopleIds);   // or { error }
 * const finalFilter = applyLiveFilter(filter);
 * coll.countDocuments(finalFilter);  coll.aggregate([{ $match: finalFilter }, …]);
 * ```
 *
 * The SQLite shape is the same sentence with two names changed:
 *
 * ```ts
 * const where = buildSearchWhere(query, dropIds, peopleIds);  // or { error }
 * searchCount(where);  searchFacets(where);  searchPage(where, { sort, limit, skip });
 * ```
 *
 * The two person-id lists still come from the caller, because resolving them
 * reads the `people` collection and that is a different slice. `projectAsset`
 * is unchanged and still does the wire projection, so a result row cannot drift
 * during the cutover.
 *
 * ## Layout
 *
 *   - `search.where.ts`    the query string as a `WHERE` clause and parameters
 *   - `search.fts.ts`      free text as an FTS5 `MATCH` expression, and bm25
 *   - `search.sql.ts`      every statement, with the index each one uses
 *   - `search.facets.ts`   the twelve facet aggregations
 *   - `search.page.ts`     one page of the grid, and the total beside it
 *   - `search.buckets.ts`  the Timeline histogram
 *   - `search.service.ts`  the service route's ranked lexical fallback
 *   - `search.repo.ts`     the entry point (this file)
 *
 * ## The three things a change here can silently break
 *
 * A location filter must stay a semi-join: as an inner join the planner leads
 * with `asset_locations` and sorts a whole library to return 200 rows, measured
 * at 50.18 ms against 0.07 ms. The page query must keep its explicit
 * `INDEXED BY assets_live_captured`, or a residual sends the planner to a
 * different index and a sort over the whole live set. And every facet's base
 * predicate must keep reading the `live_location_count` column rather than an
 * `EXISTS` sub-select, which costs 151 ms instead of 3.7 ms at production's row
 * count. All three are recorded in `docs/sqlite-schema.md`.
 */

export { buildSearchWhere, searchWhereSql } from './search.where.ts';
export type { BoundPredicate, SearchWhere, SearchWhereResult } from './search.where.ts';

export { toMatchExpression } from './search.fts.ts';

export { searchFacets } from './search.facets.ts';
export type { SearchFacets, ValueBucket } from './search.facets.ts';

export { searchCount, searchPage } from './search.page.ts';
export type { PageOptions, SeekPosition } from './search.page.ts';

export { searchBuckets } from './search.buckets.ts';
export type { SearchBuckets, TimelineBucket } from './search.buckets.ts';

export { serviceLexicalSearch } from './search.service.ts';
export type { ServiceMediaType, ServiceSearchHits, ServiceSearchScope } from './search.service.ts';

export type { SqliteDb } from './db-handle.ts';

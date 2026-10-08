/**
 * `GET /api/search/facets` on SQLite — the slice's headline speed-up.
 *
 * ## What changes, in one paragraph
 *
 * The route fires twelve aggregations over every live asset for each faceted
 * search. On production MongoDB each of those reads the whole 8.8 GB `assets`
 * collection past a 1.5 GB cache, so each takes about five seconds warm or cold
 * and the route needs a ten-second timeout to stay up. Here each one groups a
 * partial index whose keys *are* the group keys, over a table narrow enough to
 * stay in the page cache: measured at 3.7 ms for the count and 15.5 ms for the
 * camera facet at production's row count.
 *
 * ## What this function does not do
 *
 * It returns person *ids*, not names. Resolving them drops the people who are
 * hidden or merged away and reads the `people` collection, which this slice
 * does not port — so the join stays in the route, exactly where it is today,
 * and the shape below says so. Everything else is the response body verbatim.
 *
 * It also does not parse the query string. `buildSearchWhere` does that, once,
 * and the route passes the result here and to `searchCount`/`searchPage` — the
 * same shape as `buildFilter` + `applyLiveFilter` feeding several operations
 * today, and what keeps a facet total and a grid page from disagreeing.
 */

import { facetStatements, type BoundStatement, type FacetName } from './search.facets.sql.ts';
import { facetRowsOf } from './search.facets.top.ts';
import type { SearchWhere } from './search.where.ts';
import { firstRanked, mapleIdRowsSql, someMatchesSql, type RankedAsset } from './search.ranked.ts';
import { textCount, textOnly } from './search.text-count.ts';
import { cachedFacets } from './search.facets.cache.ts';
import { assetsDb, readBulk, type SqliteDb } from './db-handle.ts';
import type { SqlRow } from '../sqlite/protocol.ts';

/** A `{ value, count }` bucket — the shape most facets return on the wire. */
export interface ValueBucket {
  value: string;
  count: number;
}

/**
 * Everything `GET /api/search/facets` answers with, except that `people`
 * carries ids awaiting their display names.
 */
export interface SearchFacets {
  total: number;
  cameras: Array<{ make: string | null; model: string | null; count: number }>;
  lenses: Array<{ value: string | null; count: number }>;
  extensions: ValueBucket[];
  iso_range: { min: number; max: number } | null;
  capture_range: { from: string; to: string } | null;
  scene_types: ValueBucket[];
  activities: ValueBucket[];
  subjects: ValueBucket[];
  /**
   * Two of the three states the Mongo pipeline reports. `unknown` is always
   * zero because the column collapses "never classified" into `false` — see
   * #3761, and `search.sql.ts`'s note on the screenshot facet.
   */
  is_screenshot: { true: number; false: number; unknown: number };
  /** Person id → assets showing them. The route resolves ids to names. */
  people: Array<{ id: string; count: number }>;
  places: ValueBucket[];
  owners: Array<{ id: string; count: number }>;
  /** Which matches the buckets above count. See {@link FacetScope}. */
  scope: FacetScope;
}

/**
 * The most relevant matches a broad text search's facets describe (#4431).
 *
 * A text query matching more assets than this is faceted over its first
 * `FACET_TOP_MATCHES` results in the list's own order — best `bm25()` score,
 * then newest capture, then id — rather than over every match. Counting every
 * match of "group of people standing in front of the ocean" meant reading
 * 98,635 asset rows per facet on production, about six seconds in all; the
 * best two thousand cost a few milliseconds per facet.
 *
 * The trade-off, plainly: for such a query the buckets say "among the 2,000
 * best matches, 312 were shot on a Canon", not "312 of all 98,635 matches
 * were". A camera, place or person that appears only among the weaker matches
 * gets no bucket. `total` stays the exact number of matches, so a client can
 * tell the two apart through {@link FacetScope}. A query matching this many or
 * fewer is faceted over every match, exactly as before.
 */
export const FACET_TOP_MATCHES = 2_000;

/**
 * Another engine's ranking of a text search's matches — Meilisearch's, when it
 * serves the list — for the facets to describe instead of the database's
 * (#4431): its best matches by `maple_id`, best first, and its own count of
 * every match.
 */
export interface ExternalRanking {
  mapleIds: readonly string[];
  total: number;
}

/** How a text search's facets choose the matches they describe. */
export interface FacetOptions {
  /** How many of the most relevant matches; the tests cross it on small libraries. */
  topMatches?: number;
  /** The list's own ranking when another engine serves it; null falls back to the database's. */
  ranking?: () => Promise<ExternalRanking | null>;
}

/**
 * What the facet buckets count.
 *
 * `all` — every match, which is every search without text and every text
 * search with at most {@link FACET_TOP_MATCHES} matches. `top` — only the
 * first `limit` results of `of` matches. Clients that do not read the field
 * see the shape they always did; one that does should label the buckets
 * "in the 2,000 most relevant of 98,635 results".
 */
export type FacetScope = { kind: 'all' } | { kind: 'top'; limit: number; of: number };

/** A non-empty string, or `null` — the filter every text bucket applies. */
function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Buckets whose key must be a non-empty string to be reported at all. */
function valueBuckets(rows: Array<{ value: unknown; count: number }>): ValueBucket[] {
  return rows
    .map((row) => ({ value: nonEmpty(row.value), count: row.count }))
    .filter((row): row is ValueBucket => row.value !== null);
}

/**
 * The label for one place bucket, and the exact wire value the `place` filter
 * parses back.
 *
 * Must stay the inverse of `placeLabelTerm` in `search.where.ts`: a label this
 * emits that does not parse back into its own tuple is a filter chip returning
 * nothing. `''` normalises to blank the same way that clause treats it, so a
 * label can never be the empty string.
 */
function placeLabel(locality: string | null, region: string | null): string | null {
  const loc = nonEmpty(locality);
  const reg = nonEmpty(region);
  if (loc !== null && reg !== null) return `${loc}, ${reg}`;
  return loc ?? reg;
}

/**
 * Place tuples as labelled buckets, counts merged where two tuples label
 * identically.
 *
 * A region-less locality and a locality-less region carrying the same text
 * produce one label, and the filter clause built from that label matches both —
 * so reporting them as two buckets would show the user two chips that return
 * the same photos, and a count neither of them delivers on its own.
 */
function placeBuckets(
  rows: Array<{ locality: string | null; region: string | null; count: number }>,
): ValueBucket[] {
  const merged = new Map<string, number>();
  for (const row of rows) {
    const label = placeLabel(row.locality, row.region);
    if (label === null) continue;
    merged.set(label, (merged.get(label) ?? 0) + row.count);
  }
  return [...merged.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count);
}

/** A `MIN`/`MAX` pair, or `null` when the matching set had no values. */
function range<T extends number | string>(
  row: { min?: unknown; max?: unknown } | undefined,
  kind: 'number' | 'string',
): { min: T; max: T } | null {
  if (!row || typeof row.min !== kind || typeof row.max !== kind) return null;
  return { min: row.min as T, max: row.max as T };
}

/**
 * Runs every facet statement concurrently, through the pool's bulk lane so they
 * leave a reader free for the grid page the same search is waiting on.
 */
async function runFacets<K extends FacetName>(
  db: SqliteDb,
  statements: Record<K, BoundStatement>,
): Promise<Record<K, SqlRow[]>> {
  const names = Object.keys(statements) as K[];
  const results = await Promise.all(
    names.map((name) => readBulk(db, statements[name].sql, statements[name].params)),
  );
  return Object.fromEntries(names.map((name, index) => [name, results[index]!])) as Record<
    K,
    SqlRow[]
  >;
}

/**
 * Every facet's rows, with a text query's matches resolved once rather than
 * once per facet, and a broad one cut to its most relevant matches.
 *
 * A full-text search reaches every facet through the same join — the inverted
 * index, `asset_search`, then `assets` — and that join was the whole cost of a
 * facet (#4413), so the assets to group are resolved once and each grouping
 * becomes a keyed probe per asset. Resolving every match stopped paying off at
 * around a hundred thousand of them, where the probes themselves cost seconds,
 * so the set is now the first {@link FACET_TOP_MATCHES} results of the list
 * (#4431) — which, for a search with no more matches than that, is every
 * match, exactly the set it always was. The total is the exact match count.
 *
 * A search without text keeps the statements as they were: each of them
 * already reads one index, or one join the planner has been measured on.
 */
async function facetRows(
  db: SqliteDb,
  where: SearchWhere,
  options: FacetOptions,
): Promise<{ rows: Record<FacetName, SqlRow[]>; scope: FacetScope }> {
  if (where.match.kind !== 'match') {
    return { rows: await runFacets(db, facetStatements(where)), scope: { kind: 'all' } };
  }
  const topMatches = options.topMatches ?? FACET_TOP_MATCHES;
  const external = options.ranking ? await options.ranking() : null;
  if (external) return externallyRankedRows(db, where, external);
  if (!textOnly(where)) {
    const few = await fewMatches(db, where, topMatches);
    if (few) {
      return {
        rows: { ...(await facetRowsOf(db, few)), total: [{ n: few.length }] },
        scope: { kind: 'all' },
      };
    }
  }
  // The count runs beside the ranking: the first rows of the list are every
  // match when there are no more than `topMatches`, so it only decides the label.
  const [total, rows] = await Promise.all([
    textCount(db, where),
    firstRanked(db, where, topMatches).then((ranked) => facetRowsOf(db, ranked)),
  ]);
  return {
    rows: { ...rows, total: [{ n: total }] },
    scope: total > topMatches ? { kind: 'top', limit: topMatches, of: total } : { kind: 'all' },
  };
}

/**
 * The facets of another engine's best matches, its own count as the total.
 *
 * The ids are mapped back to rows with every filter of the search but its
 * text, exactly as the list's Meilisearch page is: the sidecar did the text
 * half, typo-tolerantly, and a database `MATCH` over its hits would reject the
 * very rows it found. Ids with no surviving row drop out.
 *
 * The cut is however many ids the engine returned, never the number asked
 * for: Meilisearch answers at most `pagination.maxTotalHits` hits (1,000 by
 * default), so a request for 2,000 can come back with 1,000, and the scope —
 * which clients print — has to say 1,000. The `of` is the engine's own
 * estimate of every match, the same number the list shows as its total.
 */
async function externallyRankedRows(
  db: SqliteDb,
  where: SearchWhere,
  ranking: ExternalRanking,
): Promise<{ rows: Record<FacetName, SqlRow[]>; scope: FacetScope }> {
  const ids = mapleIdRowsSql(where, ranking.mapleIds);
  const assets =
    ranking.mapleIds.length === 0 ? [] : await readBulk<RankedAsset>(db, ids.sql, ids.params);
  const rows = await facetRowsOf(db, assets);
  const cut = ranking.total > ranking.mapleIds.length;
  return {
    rows: { ...rows, total: [{ n: ranking.total }] },
    scope: cut
      ? { kind: 'top', limit: ranking.mapleIds.length, of: ranking.total }
      : { kind: 'all' },
  };
}

/**
 * Every match of a filtered text search, when there are at most `limit` —
 * otherwise null, and the search is broad enough to rank. See `someMatchesSql`.
 */
async function fewMatches(
  db: SqliteDb,
  where: SearchWhere,
  limit: number,
): Promise<RankedAsset[] | null> {
  const some = someMatchesSql(where, limit + 1);
  const rows = await readBulk<RankedAsset>(db, some.sql, some.params);
  return rows.length <= limit ? rows : null;
}

/**
 * Every facet for one translated search.
 *
 * The twelve statements are issued together rather than in sequence: they share
 * no state, and `SqlitePool.read` hands each to the least busy reader thread,
 * so the route waits for the slowest rather than for the sum. That is the whole
 * reason the pool has readers — a facet aggregation must never be able to delay
 * a grid page, and on the writer thread it would.
 *
 * A text search's answer is cached briefly — see `search.facets.cache.ts` —
 * keyed apart by whether another engine ranked it. See {@link FacetOptions}.
 */
export async function searchFacets(
  where: SearchWhere,
  dbOverride?: SqliteDb,
  options: FacetOptions = {},
): Promise<SearchFacets> {
  const db = assetsDb(dbOverride);
  const topMatches = options.topMatches ?? FACET_TOP_MATCHES;
  const source = options.ranking ? 'external' : 'database';
  return where.match.kind === 'match'
    ? cachedFacets(db, [where, topMatches, source], () => computeFacets(db, where, options))
    : computeFacets(db, where, options);
}

/** The facets themselves, uncached. */
async function computeFacets(
  db: SqliteDb,
  where: SearchWhere,
  options: FacetOptions,
): Promise<SearchFacets> {
  const { rows, scope } = await facetRows(db, where, options);
  const as = <T>(name: FacetName): T[] => rows[name] as unknown as T[];

  const screenshot = as<{ bucket: number; count: number }>('is_screenshot');
  const bucket = (value: number): number =>
    screenshot.find((row) => row.bucket === value)?.count ?? 0;

  return {
    total: (as<{ n: number }>('total')[0]?.n ?? 0) as number,
    cameras: as<{ make: string | null; model: string | null; count: number }>('cameras').map(
      (row) => ({ make: row.make ?? null, model: row.model ?? null, count: row.count }),
    ),
    lenses: as<{ value: string | null; count: number }>('lenses').map((row) => ({
      value: row.value ?? null,
      count: row.count,
    })),
    extensions: valueBuckets(as('extensions')),
    iso_range: range<number>(as<{ min: unknown; max: unknown }>('iso_range')[0], 'number'),
    capture_range: ((bounds) => (bounds === null ? null : { from: bounds.min, to: bounds.max }))(
      range<string>(as<{ min: unknown; max: unknown }>('capture_range')[0], 'string'),
    ),
    scene_types: valueBuckets(as('scene_types')),
    activities: valueBuckets(as('activities')),
    subjects: valueBuckets(as('subjects')),
    is_screenshot: { true: bucket(1), false: bucket(0), unknown: 0 },
    people: as<{ id: string | null; count: number }>('people')
      .filter((row): row is { id: string; count: number } => typeof row.id === 'string')
      .map((row) => ({ id: row.id, count: row.count })),
    places: placeBuckets(as('places')),
    owners: as<{ id: string | null; count: number }>('owners')
      .filter((row): row is { id: string; count: number } => typeof row.id === 'string')
      .map((row) => ({ id: row.id, count: row.count })),
    scope,
  };
}

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
import type { SearchWhere } from './search.where.ts';
import { assetsDb, type SqliteDb } from './db-handle.ts';
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
}

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

/** Runs every facet statement concurrently, on whichever readers are free. */
async function runFacets(
  db: SqliteDb,
  statements: Record<FacetName, BoundStatement>,
): Promise<Record<FacetName, SqlRow[]>> {
  const names = Object.keys(statements) as FacetName[];
  const results = await Promise.all(
    names.map((name) => db.read(statements[name]!.sql, statements[name]!.params)),
  );
  return Object.fromEntries(names.map((name, index) => [name, results[index]!])) as Record<
    FacetName,
    SqlRow[]
  >;
}

/**
 * Every facet for one translated search.
 *
 * The twelve statements are issued together rather than in sequence: they share
 * no state, and `SqlitePool.read` hands each to the least busy reader thread,
 * so the route waits for the slowest rather than for the sum. That is the whole
 * reason the pool has readers — a facet aggregation must never be able to delay
 * a grid page, and on the writer thread it would.
 */
export async function searchFacets(
  where: SearchWhere,
  dbOverride?: SqliteDb,
): Promise<SearchFacets> {
  const db = assetsDb(dbOverride);
  const rows = await runFacets(db, facetStatements(where));
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
  };
}

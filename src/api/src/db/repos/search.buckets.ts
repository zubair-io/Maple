/**
 * `GET /api/search/buckets` on SQLite — the Timeline view's year/month
 * histogram.
 *
 * Two statements rather than one pass with a conditional, because the two
 * halves want different indexes: the dated rows group
 * `assets_live_captured_ym`, a partial index whose keys are exactly the group
 * keys, and the undated ones are a count over the live index. That is also how
 * the Mongo route splits it, so the shapes line up one to one.
 *
 * The route's own 30-second response cache is untouched by this file and stays
 * where it is. It is keyed on the query string, which this function does not
 * see.
 */

import { timedBucketsSql, untimedCountSql } from './search.sql.ts';
import type { SearchWhere } from './search.where.ts';
import type { RankedAsset } from './search.ranked.ts';
import { assetsDb, readBulk, type SqliteDb } from './db-handle.ts';

/** One month that has photos in it. */
export interface TimelineBucket {
  year: number;
  month: number;
  count: number;
}

/** The histogram response body, verbatim. */
export interface SearchBuckets {
  total: number;
  buckets: TimelineBucket[];
  untimed_count: number;
}

/**
 * The histogram for one search.
 *
 * `total` is the sum of the dated buckets and deliberately excludes the undated
 * count, matching the Mongo route: the Timeline draws a bar per month, and a
 * total that included rows no bar can represent would not add up on screen.
 */
export async function searchBuckets(
  where: SearchWhere,
  dbOverride?: SqliteDb,
): Promise<SearchBuckets> {
  const db = assetsDb(dbOverride);
  const timed = timedBucketsSql(where);
  const untimed = untimedCountSql(where);
  const [buckets, untimedRows] = await Promise.all([
    db.read<TimelineBucket>(timed.sql, timed.params),
    db.read<{ n: number }>(untimed.sql, untimed.params),
  ]);
  return {
    total: buckets.reduce((sum, bucket) => sum + bucket.count, 0),
    buckets,
    untimed_count: untimedRows[0]?.n ?? 0,
  };
}

const WINDOW_ROWS = 'assets.rowid IN (SELECT value FROM json_each(?))';

/**
 * The histogram of a text search's ranked window (`search.ranked.ts`, #4514): the rows the list
 * shows, already filtered, grouped by key. Never a grouping of the whole match set.
 */
export async function windowBuckets(
  rows: readonly RankedAsset[],
  dbOverride?: SqliteDb,
): Promise<SearchBuckets> {
  if (rows.length === 0) return { total: 0, buckets: [], untimed_count: 0 };
  const db = assetsDb(dbOverride);
  const ids = [JSON.stringify(rows.map((row) => row.r))];
  const [buckets, untimedRows] = await Promise.all([
    readBulk<TimelineBucket>(
      db,
      `SELECT assets.captured_year AS year, assets.captured_month AS month, COUNT(*) AS count
         FROM assets WHERE ${WINDOW_ROWS} AND assets.captured_year IS NOT NULL
        GROUP BY assets.captured_year, assets.captured_month
        ORDER BY year DESC, month DESC`,
      ids,
    ),
    readBulk<{ n: number }>(
      db,
      `SELECT COUNT(*) AS n FROM assets WHERE ${WINDOW_ROWS} AND assets.captured_at IS NULL`,
      ids,
    ),
  ]);
  return {
    total: buckets.reduce((sum, bucket) => sum + bucket.count, 0),
    buckets,
    untimed_count: untimedRows[0]?.n ?? 0,
  };
}

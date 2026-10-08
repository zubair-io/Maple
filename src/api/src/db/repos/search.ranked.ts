/**
 * The first rows of a text search's result order, found without joining every
 * match (#4431).
 *
 * A broad caption-style query such as "group of people standing in front of
 * the ocean" matches a third of a library — 98,635 live assets on production —
 * and any statement that joins each match to `asset_search` and `assets` to ask
 * whether it is live, visible and passes the filters pays a row read per
 * match: about a second on production.
 *
 * The result order is `bm25()` first, so the rows that can open the list are
 * among the best-scored matches before any filter runs. One statement ranks
 * the matches on the inverted index alone and keeps the best `k`; below the
 * score at which it stopped, those are every match there is. Joining just them
 * and taking the first rows of the result order — score, then newest capture,
 * then id — gives exactly the rows the full join would, at the cost of a few
 * thousand row reads instead of a hundred thousand. When the filters leave too
 * few of them it ranks again with more, sized by how many survived, and after
 * {@link MAX_PASSES} passes it falls back to the full predicate, which is exact
 * for any filter.
 */

import { FTS_RANK_ORDER, FTS_RANK_SQL } from './search.fts.ts';
import { rankedPageSql, type BoundStatement } from './search.sql.ts';
import { monthNarrowing, searchWhereSql, type SearchWhere } from './search.where.ts';
import { readBulk, type SqliteDb } from './db-handle.ts';

/** A full-text match before any join: its `asset_search` rowid and its score. */
interface Hit {
  sr: number;
  rank: number;
}

/**
 * How many more best-scored matches than rows wanted the score-only pass keeps,
 * so the hidden, trashed and filtered-out assets among them rarely leave the
 * answer short. Finding the best `k` costs about the same whatever `k` is —
 * every match is scored either way — and it is the join after it that grows.
 */
const OVERFETCH = 2;

/** The best `k` matches by score alone, the month narrowing applied. */
export function bestHitsSql(where: SearchWhere, k: number): BoundStatement {
  if (where.match.kind !== 'match') throw new Error('bestHitsSql: not a text query');
  const narrowing = monthNarrowing(where);
  return {
    sql: `SELECT assets_fts.rowid AS sr, ${FTS_RANK_SQL}
    FROM assets_fts
   WHERE assets_fts MATCH ?${narrowing ? `\n     AND ${narrowing.sql}` : ''}
   ORDER BY ${FTS_RANK_ORDER}
   LIMIT ?`,
    params: [where.match.expression, ...(narrowing?.params ?? []), k],
  };
}

/**
 * The hits that pass the rest of the query, in result order, `limit` at most.
 *
 * Everything but the text match applies here — liveness, visibility, filters,
 * excluded people — over the hits rather than the whole match set. `CROSS
 * JOIN` pins the hits as the outer loop; left to itself the planner may walk a
 * live index over the library and probe the hits instead.
 */
export function hitRowsSql(
  where: SearchWhere,
  hits: readonly Hit[],
  projection: string,
  limit: number,
): BoundStatement {
  const rest = searchWhereSql({ ...where, match: { kind: 'none' } });
  return {
    sql: `WITH hit(sr, rank) AS (
      SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]') FROM json_each(?))
  SELECT ${projection}
    FROM hit
    CROSS JOIN asset_search ON asset_search.rowid = hit.sr
    CROSS JOIN assets ON assets.id = asset_search.asset_id
   ${rest.sql}
   ORDER BY hit.rank ASC, assets.captured_at DESC, assets.id
   LIMIT ?`,
    params: [JSON.stringify(hits.map((hit) => [hit.sr, hit.rank])), ...rest.params, limit],
  };
}

/**
 * The hits scoring strictly better than the last one returned, or all of them
 * when fewer than `k` came back — in which case they are every match. Ties at
 * the last score are left out rather than half-included: a match the
 * statement did not return may share it.
 */
function completeBelowLast(hits: Hit[], k: number): { hits: Hit[]; complete: boolean } {
  if (hits.length < k) return { hits, complete: true };
  const stop = hits[k - 1]!.rank;
  return { hits: hits.filter((hit) => hit.rank < stop), complete: false };
}

/**
 * How many score-only passes to try before giving up on them, and how much
 * margin each widening adds over the survival rate the last pass measured.
 * A filter that keeps a third of the matches (`rating >= 4`) is answered by
 * the second pass; one that keeps almost none goes to the full predicate.
 */
const MAX_PASSES = 3;
const WIDENING_MARGIN = 1.5;

/** The first `limit` rows from score-only passes, or null when they fell short. */
async function scoreFirstRowids(
  db: SqliteDb,
  where: SearchWhere,
  limit: number,
  k: number,
  pass: number,
): Promise<number[] | null> {
  const best = bestHitsSql(where, k);
  const { hits, complete } = completeBelowLast(await readBulk<Hit>(db, best.sql, best.params), k);
  const joined = hitRowsSql(where, hits, 'assets.rowid AS r', limit);
  const rows =
    hits.length === 0 ? [] : await readBulk<{ r: number }>(db, joined.sql, joined.params);
  if (rows.length === limit || complete) return rows.map((row) => row.r);
  if (pass === MAX_PASSES) return null;
  const survivors = Math.max(rows.length, limit / 16);
  const widened = Math.ceil((k * limit * WIDENING_MARGIN) / survivors);
  return scoreFirstRowids(db, where, limit, widened, pass + 1);
}

/**
 * The `assets.rowid`s of the first `limit` rows of a text search's result
 * order: the same rows, in the same order, that the result list shows first.
 *
 * `hidden=only` goes straight to the full predicate: the score-only pass
 * assumes most of the best matches survive the visibility filter, which holds
 * for the default and for `hidden=all` but not when only hidden assets count.
 */
export async function firstRankedRowids(
  db: SqliteDb,
  where: SearchWhere,
  limit: number,
): Promise<number[]> {
  const scored =
    where.hidden === 1 ? null : await scoreFirstRowids(db, where, limit, OVERFETCH * limit, 1);
  if (scored) return scored;
  const projection = 'assets.rowid AS r';
  const page = rankedPageSql(where, limit, 0, undefined, projection);
  const rows = await readBulk<{ r: number }>(db, page.sql, page.params);
  return rows.map((row) => row.r);
}

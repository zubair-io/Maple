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
 * among the best-scored matches before any filter runs. {@link firstRankedSql}
 * ranks the matches on the inverted index alone and keeps the best `k`; below
 * the score at which it stopped, those are every match there is. Joining just
 * them and taking the first rows of the result order — score, then newest
 * capture, then id — gives exactly the rows the full join would, at the cost of
 * a few thousand index probes instead of a hundred thousand row reads. When the
 * filters leave too few of them it ranks again with more, sized by how many
 * survived, and after {@link MAX_PASSES} passes it falls back to the full
 * predicate, which is exact for any filter.
 */

import { FTS_RANK_ORDER, FTS_RANK_SQL } from './search.fts.ts';
import { rankedPageSql, type BoundStatement } from './search.sql.ts';
import { monthNarrowing, searchWhereSql, type SearchWhere } from './search.where.ts';
import { readBulk, type SqliteDb } from './db-handle.ts';

/** One of the first rows: its `assets.rowid` and `assets.id`. */
export interface RankedAsset {
  r: number;
  id: string;
}

/**
 * How many more best-scored matches than rows wanted the score-only pass keeps,
 * so the hidden, trashed and filtered-out assets among them rarely leave the
 * answer short. Finding the best `k` costs about the same whatever `k` is —
 * every match is scored either way — and it is the probes after it that grow.
 */
const OVERFETCH = 2;

/**
 * How many score-only passes to try before giving up on them, and how much
 * margin each widening adds over the survival rate the last pass measured.
 * A filter that keeps a third of the matches (`rating >= 4`) is answered by
 * the second pass; one that keeps almost none goes to the full predicate.
 */
const MAX_PASSES = 3;
const WIDENING_MARGIN = 1.5;

/**
 * The first `limit` rows of the result order among the best `k` matches, in
 * one statement, plus whether those `k` were every match.
 *
 * - `hit` ranks on the inverted index alone. `MATERIALIZED` keeps it a single
 *   scan that nothing else in the statement can turn into a per-row probe.
 * - `stop` is the score the ranking stopped at; matches scoring exactly that
 *   may not all be in `hit`, so `alive` keeps only those strictly better —
 *   unless fewer than `k` came back, when `hit` is every match.
 * - `alive` applies everything but the text: liveness, visibility, filters,
 *   excluded people. `CROSS JOIN` keeps the hits as the outer loop. With no
 *   residual filter it reads the `assets_live_id` index, not the row.
 * - `edge` is the score of the `limit`-th survivor. Everything better is in;
 *   the rows tying it are ordered by capture date and id — the only rows whose
 *   capture date has to be read — and as many as fit are taken.
 *
 * The final `LEFT JOIN` from a one-row `flag` makes the statement answer at
 * least one row, so an empty survivor set still reports whether it is final.
 */
export function firstRankedSql(where: SearchWhere, k: number, limit: number): BoundStatement {
  if (where.match.kind !== 'match') throw new Error('firstRankedSql: not a text query');
  const narrowing = monthNarrowing(where);
  const rest = searchWhereSql(
    { ...where, match: { kind: 'none' } },
    { sql: '(hit.rank < (SELECT rank FROM stop) OR (SELECT rank FROM stop) IS NULL)', params: [] },
  );
  return {
    sql: `WITH hit AS MATERIALIZED (
      SELECT assets_fts.rowid AS sr, ${FTS_RANK_SQL}
        FROM assets_fts
       WHERE assets_fts MATCH ?${narrowing ? `\n         AND ${narrowing.sql}` : ''}
       ORDER BY ${FTS_RANK_ORDER}
       LIMIT ?),
    stop AS (SELECT CASE WHEN COUNT(*) < ? THEN NULL ELSE MAX(rank) END AS rank FROM hit),
    alive AS MATERIALIZED (
      SELECT hit.rank AS rank, assets.rowid AS r, assets.id AS id
        FROM hit
        CROSS JOIN asset_search ON asset_search.rowid = hit.sr
        CROSS JOIN assets ON assets.id = asset_search.asset_id
       ${rest.sql}),
    edge AS (SELECT rank FROM alive ORDER BY rank LIMIT 1 OFFSET ?),
    chosen AS (
      SELECT r, id FROM alive
       WHERE NOT EXISTS (SELECT 1 FROM edge) OR rank < (SELECT rank FROM edge)
      UNION ALL
      SELECT r, id FROM (
        SELECT alive.r AS r, alive.id AS id
          FROM alive CROSS JOIN assets ON assets.rowid = alive.r
         WHERE alive.rank = (SELECT rank FROM edge)
         ORDER BY assets.captured_at DESC, assets.id
         LIMIT ? - (SELECT COUNT(*) FROM alive WHERE rank < (SELECT rank FROM edge)))),
    flag AS (SELECT (SELECT rank IS NULL FROM stop) AS complete)
  SELECT flag.complete AS complete, chosen.r AS r, chosen.id AS id
    FROM flag LEFT JOIN chosen ON 1`,
    params: [
      where.match.expression,
      ...(narrowing?.params ?? []),
      k,
      k,
      ...rest.params,
      limit - 1,
      limit,
    ],
  };
}

/** The first `limit` rows from score-only passes, or null when they fell short. */
async function scoreFirst(
  db: SqliteDb,
  where: SearchWhere,
  limit: number,
  k: number,
  pass: number,
): Promise<RankedAsset[] | null> {
  const statement = firstRankedSql(where, k, limit);
  const answer = await readBulk<{ complete: number; r: number | null; id: string | null }>(
    db,
    statement.sql,
    statement.params,
  );
  const rows = answer.filter(
    (row): row is { complete: number; r: number; id: string } => row.r !== null && row.id !== null,
  );
  if (rows.length === limit || answer[0]?.complete === 1) {
    return rows.map((row) => ({ r: row.r, id: row.id }));
  }
  if (pass === MAX_PASSES) return null;
  const survivors = Math.max(rows.length, limit / 16);
  const widened = Math.ceil((k * limit * WIDENING_MARGIN) / survivors);
  return scoreFirst(db, where, limit, widened, pass + 1);
}

/**
 * The first `limit` rows of a text search's result order — the same rows the
 * result list shows first. Their order is not kept; a facet only needs the set.
 *
 * `hidden=only` goes straight to the full predicate: the score-only pass
 * assumes most of the best matches survive the visibility filter, which holds
 * for the default and for `hidden=all` but not when only hidden assets count.
 */
export async function firstRanked(
  db: SqliteDb,
  where: SearchWhere,
  limit: number,
): Promise<RankedAsset[]> {
  const scored =
    where.hidden === 1 ? null : await scoreFirst(db, where, limit, OVERFETCH * limit, 1);
  if (scored) return scored;
  const page = rankedPageSql(where, limit, 0, undefined, 'assets.rowid AS r, assets.id AS id');
  const rows = await readBulk<RankedAsset>(db, page.sql, page.params);
  return rows.map((row) => ({ r: row.r, id: row.id }));
}

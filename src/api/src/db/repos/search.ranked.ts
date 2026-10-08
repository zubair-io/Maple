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
 * filters leave too few of them it ranks once more with as many as the
 * survival rate says it needs — unless that is too many, see
 * {@link MAX_WIDENING} — and otherwise falls back to the full predicate, which
 * is exact for any filter.
 */

import { FTS_RANK_ORDER, FTS_RANK_SQL } from './search.fts.ts';
import { rankedPageSql, statement, type BoundStatement } from './search.sql.ts';
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
 * When the score-only pass falls short, how far it may widen before the full
 * predicate is the cheaper answer.
 *
 * A filter's survival rate among the first pass's hits says how many hits a
 * second pass would need. One that keeps a fair share of them — a camera, a
 * common rating — is answered by one wider pass, sized from that rate with
 * {@link WIDENING_MARGIN} to spare. One that keeps almost none would need a
 * pass over most of the library, probing every hit, and that costs far more
 * than the full statement it was meant to avoid: on the production snapshot
 * `rating=4` kept 1 of 4,000 hits, and widening from that took two passes of
 * 4.4 s each against 0.55 s for the full statement (#4431). So a widening
 * larger than {@link MAX_WIDENING} times the first pass, or a second shortfall,
 * goes straight to the full predicate.
 */
const WIDENING_MARGIN = 1.5;
const MAX_WIDENING = 4;

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
 * least one row, so an empty survivor set still reports whether it is final,
 * how many hits scored strictly better than the stop (`considered`), and how
 * many of those passed the filters (`survived`) — what a widening is sized
 * from, and what tells a filter's shortfall from a tie's.
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
    flag AS (SELECT (SELECT rank IS NULL FROM stop) AS complete,
                    (SELECT COUNT(*) FROM hit
                      WHERE hit.rank < (SELECT rank FROM stop)
                         OR (SELECT rank FROM stop) IS NULL) AS considered,
                    (SELECT COUNT(*) FROM alive) AS survived)
  SELECT flag.complete AS complete, flag.considered AS considered,
         flag.survived AS survived, chosen.r AS r, chosen.id AS id
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

/** One score-only pass over `k` hits: its rows, whether they are the answer, and its counts. */
async function scorePass(
  db: SqliteDb,
  where: SearchWhere,
  limit: number,
  k: number,
): Promise<{ rows: RankedAsset[]; enough: boolean; considered: number; survived: number }> {
  const pass = firstRankedSql(where, k, limit);
  const answer = await readBulk<{
    complete: number;
    considered: number;
    survived: number;
    r: number | null;
    id: string | null;
  }>(db, pass.sql, pass.params);
  const rows = answer
    .filter(
      (row): row is (typeof answer)[number] & { r: number; id: string } =>
        row.r !== null && row.id !== null,
    )
    .map((row) => ({ r: row.r, id: row.id }));
  return {
    rows,
    enough: rows.length === limit || answer[0]?.complete === 1,
    considered: answer[0]?.considered ?? 0,
    survived: answer[0]?.survived ?? 0,
  };
}

/**
 * The first `limit` rows from at most two score-only passes, or null when the
 * full predicate is the better answer.
 *
 * Two shortfalls look alike and are not. A filter can keep too few of the
 * hits; then a wider pass, sized from the rate it kept them at and bounded by
 * {@link MAX_WIDENING}, finds the rest. Or the pass can stop inside a tie: the
 * hits scoring exactly what it stopped at are left out, because a match it did
 * not return may share that score, and a library where thousands of assets
 * carry the same caption puts thousands of hits in one tie. When fewer hits
 * than the page needs scored strictly better than the stop, no filter is at
 * fault and widening would only walk further into the same tie, scoring every
 * match each time — so it goes to the full predicate at once, which orders ties
 * itself.
 */
async function scoreFirst(
  db: SqliteDb,
  where: SearchWhere,
  limit: number,
): Promise<RankedAsset[] | null> {
  const k = OVERFETCH * limit;
  const first = await scorePass(db, where, limit, k);
  if (first.enough) return first.rows;
  if (first.considered < limit) return null;
  const widened = Math.ceil(
    (first.considered * limit * WIDENING_MARGIN) / Math.max(first.survived, 1),
  );
  if (widened > MAX_WIDENING * k) return null;
  const second = await scorePass(db, where, limit, widened);
  return second.enough ? second.rows : null;
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
  const scored = where.hidden === 1 ? null : await scoreFirst(db, where, limit);
  if (scored) return scored;
  const page = rankedPageSql(where, limit, 0, undefined, 'assets.rowid AS r, assets.id AS id');
  const rows = await readBulk<RankedAsset>(db, page.sql, page.params);
  return rows.map((row) => ({ r: row.r, id: row.id }));
}

/**
 * Up to `limit` matches of a filtered text search, unranked: every match when
 * fewer come back.
 *
 * A filter the inverted index cannot see — a rating, a camera, a flag, hidden
 * assets only — decides membership row by row, so counting its matches already
 * joins every full-text hit. When it keeps few of them, that one join is the
 * whole answer: these are all the matches, there is nothing to rank among, and
 * a score-only pass would find almost none of them in its first hits (#4431).
 * When it keeps many, the statement stops as soon as it has `limit` and costs
 * little.
 */
export function someMatchesSql(where: SearchWhere, limit: number): BoundStatement {
  return statement('assets.rowid AS r, assets.id AS id', where, 'LIMIT ?', undefined, [limit]);
}

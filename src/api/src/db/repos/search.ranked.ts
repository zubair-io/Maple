/**
 * The ranked window: how every free-text search becomes a bounded list of assets (#4514).
 *
 * A caption-style query ("busy city streets, tall buildings, and urban cityscapes") matches most
 * of a library, and any statement that joins each match to `asset_search` and `assets` — to count
 * them, sort them, or ask whether they pass a filter — costs a row read per match. On production
 * that was minutes per statement once the planner picked a per-row plan, and three For You cards
 * loading together held every reader for the duration.
 *
 * So no request counts or joins a whole match set. A text search is answered in two steps, the
 * same whichever engine ranks it:
 *
 *   1. An engine ranks the text alone and returns its best `depth` hits — the in-process child's
 *      fused ranking, or {@link ftsWindowSql}: the inverted index scored on its own, never joined.
 *   2. Those hits, and only those, are joined to `assets` and filtered by everything else the
 *      request asked for (liveness, visibility, library, dates, people, …).
 *
 * The survivors are the window. `total` is their count and paging slices them, so the total and
 * every page agree by construction. When a full window leaves the request short, it is ranked
 * again four times deeper, up to {@link RANKED_WINDOW_MAX}, until the page is filled; the window
 * is never replaced by an exact count. `more` says the engine had hits left beyond the
 * window, so asking for a deeper page widens it; `capped` says it had hits left past the cap, which
 * no page reaches. A free-text `total` is therefore never more than {@link RANKED_WINDOW_MAX}.
 */

import { FTS_RANK_ORDER, FTS_RANK_SQL } from './search.fts.ts';
import { statement, type BoundStatement } from './search.sql.ts';
import { monthNarrowing, searchWhereSql, type SearchWhere } from './search.where.ts';
import { assetsDb, readBulk, type SqliteDb } from './db-handle.ts';
import {
  RANKED_WINDOW_BASE,
  RANKED_WINDOW_MAX,
  RANKED_WINDOW_WIDENING_FACTOR as WIDENING_FACTOR,
} from '../../generated/ranked-window.generated.ts';

/** One asset by its `assets.rowid` and `assets.id` — what a facet groups. */
export interface RankedAsset {
  r: number;
  id: string;
}

/**
 * A window survivor. `maple_id` is what the in-process engine knows it by;
 * `owner_id` lets its page be filled out in one trip (`windowDocs`).
 */
export interface WindowRow extends RankedAsset {
  maple_id: string | null;
  owner_id: string | null;
}

/** One ranking pass: the survivors in rank order, and how many hits the engine returned. */
export interface WindowPass {
  rows: WindowRow[];
  considered: number;
  /** `maple_id`s the engine's vector leg found, when it has one. */
  semantic?: ReadonlySet<string>;
  /** The engine's score of each hit by `maple_id`, when it has one. */
  scores?: ReadonlyMap<string, number>;
}

/** Ranks the text `depth` deep and filters the hits; null when the engine cannot answer. */
export type WindowRanker = (depth: number) => Promise<WindowPass | null>;

export interface RankedWindow {
  rows: WindowRow[];
  /** The engine returned a full window below the cap: a deeper page may find more. */
  more: boolean;
  /**
   * The engine returned a full window at {@link RANKED_WINDOW_MAX}: more matches exist, but no
   * page can reach them. `more` is false then, so paging ends; this says why.
   */
  capped: boolean;
  semantic: ReadonlySet<string>;
  scores?: ReadonlyMap<string, number>;
}

/**
 * The ladder — start depth, cap, widening factor — is `raw_core::ranked_window`, generated here and
 * into the Apple client by `tools/codegen.sh`, so the two cannot step differently (#4545).
 */
export { RANKED_WINDOW_BASE, RANKED_WINDOW_MAX };

/**
 * The first depth on the widening ladder that reaches `need` rows. Requests whose pages share a
 * ladder step share a window, which is what the facet and bucket caches key on.
 */
export function windowDepthFor(need: number): number {
  const climb = (depth: number): number =>
    depth >= need || depth >= RANKED_WINDOW_MAX
      ? Math.min(depth, RANKED_WINDOW_MAX)
      : climb(depth * WIDENING_FACTOR);
  return climb(RANKED_WINDOW_BASE);
}

/**
 * The window a request reaching `need` rows is served from. It is filled to the ladder step that
 * reaches `need`: a full window with fewer survivors than that step is widened up the ladder until
 * it has them, the engine runs out of hits, or the cap is reached. So every page's `skip` indexes
 * a prefix earlier pages served in full, and the window depends only on the query and its step —
 * which is what lets the facet and bucket caches share it across the pages of a step. A caller
 * with no pages to keep stable passes `enough`: widening stops at that many survivors instead.
 */
export async function rankWindow(
  ranker: WindowRanker,
  need: number,
  enough?: number,
): Promise<RankedWindow | null> {
  const target = windowDepthFor(need);
  const sufficient = enough ?? target;
  const widen = async (
    depth: number,
    previous: { pass: WindowPass; depth: number } | null,
  ): Promise<RankedWindow | null> => {
    const pass = await ranker(depth);
    if (pass === null) {
      return (
        previous &&
        windowOf(previous.pass, previous.pass.considered >= previous.depth, previous.depth)
      );
    }
    const full = pass.considered >= depth;
    if (pass.rows.length >= sufficient || !full || depth >= RANKED_WINDOW_MAX) {
      return windowOf(pass, full, depth);
    }
    return widen(Math.min(RANKED_WINDOW_MAX, depth * WIDENING_FACTOR), { pass, depth });
  };
  return widen(target, null);
}

function windowOf(pass: WindowPass, full: boolean, depth: number): RankedWindow {
  const atCap = depth >= RANKED_WINDOW_MAX;
  return {
    rows: pass.rows,
    more: full && !atCap,
    capped: full && atCap,
    semantic: pass.semantic ?? new Set(),
    scores: pass.scores,
  };
}

/**
 * The database's ranking: the best `depth` hits on the inverted index alone, then those hits
 * filtered.
 *
 * - `hit` scores the text on the inverted index and nothing else. A month filter narrows it with
 *   an uncorrelated list the planner builds once; nothing per row can reach it, which is what
 *   keeps the plan from turning into a `MATCH` per asset however the statistics look.
 * - The survivors are joined from `hit` outwards with `CROSS JOIN`, so the hits stay the outer
 *   loop: at most `depth` keyed probes.
 * - The `LEFT JOIN` from a one-row select answers at least one row, so an empty window still
 *   reports how many hits there were.
 * - The order is total — score, then the index's rowid — in the ranking and in the answer alike.
 *   A broad query ties thousands of hits on one score, and cutting that tie by anything else
 *   would let a widened window admit rows that sort ahead of a page already served, so paging
 *   would repeat and skip assets. With one total order, every window is a prefix of every
 *   deeper one.
 */
export function ftsWindowSql(where: SearchWhere, depth: number): BoundStatement {
  if (where.match.kind !== 'match') throw new Error('ftsWindowSql: not a text query');
  const narrowing = monthNarrowing(where);
  const rest = searchWhereSql({ ...where, match: { kind: 'none' } });
  return {
    sql: `WITH hit AS MATERIALIZED (
      SELECT assets_fts.rowid AS sr, ${FTS_RANK_SQL}
        FROM assets_fts
       WHERE assets_fts MATCH ?${narrowing ? `\n         AND ${narrowing.sql}` : ''}
       ORDER BY ${FTS_RANK_ORDER}, assets_fts.rowid
       LIMIT ?),
    alive AS MATERIALIZED (
      SELECT hit.rank AS rank, hit.sr AS sr, assets.rowid AS r, assets.id AS id,
             assets.maple_id AS maple_id, assets.owner_id AS owner_id
        FROM hit
        CROSS JOIN asset_search ON asset_search.rowid = hit.sr
        CROSS JOIN assets ON assets.id = asset_search.asset_id
       ${rest.sql})
  SELECT (SELECT COUNT(*) FROM hit) AS considered, alive.r AS r, alive.id AS id,
         alive.maple_id AS maple_id, alive.owner_id AS owner_id
    FROM (SELECT 1) LEFT JOIN alive ON 1
   ORDER BY alive.rank ASC, alive.sr ASC`,
    params: [where.match.expression, ...(narrowing?.params ?? []), depth, ...rest.params],
  };
}

/** {@link ftsWindowSql} as a {@link WindowRanker}, through the pool's bulk lane. */
export function ftsRanker(where: SearchWhere, dbOverride?: SqliteDb): WindowRanker {
  return async (depth) => {
    if (where.match.kind !== 'match') return { rows: [], considered: 0 };
    const window = ftsWindowSql(where, depth);
    const answer = await readBulk<
      { considered: number } & { [K in keyof WindowRow]: WindowRow[K] | null }
    >(assetsDb(dbOverride), window.sql, window.params);
    return {
      considered: answer[0]?.considered ?? 0,
      rows: answer.flatMap(({ r, id, maple_id, owner_id }) =>
        r === null || id === null ? [] : [{ r, id, maple_id, owner_id }],
      ),
    };
  };
}

/**
 * The rows behind another engine's ranked `maple_id`s that pass every filter of `where` but its
 * text, in the order given — the engine did the text half, typo tolerance included, and a
 * database `MATCH` over its hits would reject the very rows it found.
 */
export async function mapleIdWindow(
  where: SearchWhere,
  mapleIds: readonly string[],
  dbOverride?: SqliteDb,
): Promise<WindowRow[]> {
  if (mapleIds.length === 0) return [];
  const ids = mapleIdRowsSql(where, mapleIds);
  const rows = await readBulk<WindowRow>(assetsDb(dbOverride), ids.sql, ids.params);
  return inGivenOrder(mapleIds, rows, (row) => row.maple_id);
}

/** `rows` in the order of `keys`, by the key each row carries; keys with no row drop out. */
export function inGivenOrder<T>(
  keys: readonly string[],
  rows: readonly T[],
  keyOf: (row: T) => string | null,
): T[] {
  const byKey = new Map(rows.map((row) => [keyOf(row), row] as const));
  return keys.flatMap((key) => {
    const row = byKey.get(key);
    return row === undefined ? [] : [row];
  });
}

/**
 * The rows behind a set of `maple_id`s that pass every filter of `where` but its text. The index
 * is named because the planner cannot see how short the id list is: with statistics that favour a
 * filter's index it walked the whole live set instead of probing a few thousand ids.
 */
export function mapleIdRowsSql(where: SearchWhere, mapleIds: readonly string[]): BoundStatement {
  return statement(
    'assets.rowid AS r, assets.id AS id, assets.maple_id AS maple_id, assets.owner_id AS owner_id',
    { ...where, match: { kind: 'none' } },
    '',
    {
      sql: 'assets.maple_id IS NOT NULL AND assets.maple_id IN (SELECT value FROM json_each(?))',
      params: [JSON.stringify(mapleIds)],
    },
    [],
    'FROM assets INDEXED BY assets_maple_id',
  );
}

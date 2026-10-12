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
 * once more, as much deeper as the survival rate says it needs, up to {@link RANKED_WINDOW_MAX};
 * the window is never replaced by an exact count. `more` says the engine had hits left beyond the
 * window, so asking for a deeper page widens it.
 */

import { FTS_RANK_ORDER, FTS_RANK_SQL } from './search.fts.ts';
import { statement, type BoundStatement } from './search.sql.ts';
import { monthNarrowing, searchWhereSql, type SearchWhere } from './search.where.ts';
import { assetsDb, readBulk, type SqliteDb } from './db-handle.ts';

/** One asset by its `assets.rowid` and `assets.id` — what a facet groups. */
export interface RankedAsset {
  r: number;
  id: string;
}

/**
 * A window survivor. `maple_id` is what the in-process engine and Meilisearch know it by;
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
}

/** Ranks the text `depth` deep and filters the hits; null when the engine cannot answer. */
export type WindowRanker = (depth: number) => Promise<WindowPass | null>;

export interface RankedWindow {
  rows: WindowRow[];
  /** The engine returned a full window below the cap: a deeper page may find more. */
  more: boolean;
  semantic: ReadonlySet<string>;
}

/** The depth a window starts at, and the in-process engine's candidate count. */
export const RANKED_WINDOW_BASE = 100;

/**
 * The deepest a window goes. Ranking costs about the same at any depth — every match is scored
 * either way — but each hit in the window is a keyed probe, so this caps the join at 5,000 probes.
 */
export const RANKED_WINDOW_MAX = 5_000;

const WIDENING_MARGIN = 1.5;

/** The window a request reaching `need` rows is served from. */
export async function rankWindow(ranker: WindowRanker, need: number): Promise<RankedWindow | null> {
  const depth = Math.min(RANKED_WINDOW_MAX, Math.max(need, RANKED_WINDOW_BASE));
  const first = await ranker(depth);
  if (first === null) return null;
  const full = first.considered >= depth;
  if (first.rows.length >= need || !full || depth >= RANKED_WINDOW_MAX) {
    return windowOf(first, full && depth < RANKED_WINDOW_MAX);
  }
  const survival = Math.max(first.rows.length, 1) / first.considered;
  const widened = Math.min(
    RANKED_WINDOW_MAX,
    Math.max(depth * 2, Math.ceil((need / survival) * WIDENING_MARGIN)),
  );
  const second = (await ranker(widened)) ?? first;
  const deeper = second === first ? depth : widened;
  return windowOf(second, second.considered >= deeper && deeper < RANKED_WINDOW_MAX);
}

function windowOf(pass: WindowPass, more: boolean): RankedWindow {
  return { rows: pass.rows, more, semantic: pass.semantic ?? new Set() };
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

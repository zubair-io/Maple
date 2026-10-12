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
 * no page reaches. The deepest pass ranks one hit past the cap to tell the two apart: a query with
 * exactly {@link RANKED_WINDOW_MAX} matches has none left, and is not capped. A free-text `total`
 * is therefore never more than {@link RANKED_WINDOW_MAX}.
 */

import { FTS_RANK_ORDER, FTS_RANK_SQL } from './search.fts.ts';
import { collapseShots, type ShotFields } from './search.shots.ts';
import { statement, type BoundStatement } from './search.sql.ts';
import { monthNarrowing, searchWhereSql, type SearchWhere } from './search.where.ts';
import { assetsDb, readBulk, type SqliteDb } from './db-handle.ts';

/** One asset by its `assets.rowid` and `assets.id` — what a facet groups. */
export interface RankedAsset {
  r: number;
  id: string;
}

/**
 * A window survivor. `maple_id` is what the in-process engine knows it by;
 * `owner_id` lets its page be filled out in one trip (`windowDocs`); its capture time and
 * filename say which shot it is (`search.shots.ts`).
 */
export interface WindowRow extends RankedAsset, ShotFields {
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
  /** The lookahead hits that pass the filters: never served, only read for which shot they are. */
  beyond?: WindowRow[];
}

/**
 * Ranks the text `depth + lookahead` deep and filters the first `depth` hits into `rows` and the
 * rest into `beyond`; `considered` counts every hit returned, so a lookahead hit says matches
 * remain past `depth`. Null when the engine cannot answer.
 */
export type WindowRanker = (depth: number, lookahead?: number) => Promise<WindowPass | null>;

export interface RankedWindow {
  rows: WindowRow[];
  /** The engine returned a full window below the cap: a deeper page may find more. */
  more: boolean;
  /**
   * The engine had a hit past {@link RANKED_WINDOW_MAX}: more matches exist, but no page can
   * reach them. `more` is false then, so paging ends; this says why.
   */
  capped: boolean;
  semantic: ReadonlySet<string>;
  scores?: ReadonlyMap<string, number>;
  /** The ladder step the served pass was ranked at. */
  depth: number;
}

/**
 * The filename of an asset's first live entry, for the shot rule: the name of a file the user still
 * has, even when the canonical entry has gone missing. A keyed probe of `(asset_id, ordinal)` per
 * survivor that stops at the first live row, and unlike a join it cannot multiply a row.
 */
const LIVE_FILENAME_SQL = `(SELECT l.filename FROM asset_locations l
              WHERE l.asset_id = assets.id AND l.deleted_at IS NULL AND l.missing_since IS NULL
              ORDER BY l.ordinal LIMIT 1)`;

/** The depth a window starts at, and the in-process engine's candidate count. */
export const RANKED_WINDOW_BASE = 100;

/**
 * The deepest a window goes. Ranking costs about the same at any depth — every match is scored
 * either way — but each hit in the window is a keyed probe, so this caps the join at 5,000 probes.
 */
export const RANKED_WINDOW_MAX = 5_000;

/** How much deeper each widening asks: 100, 400, 1,600, then the cap. */
const WIDENING_FACTOR = 4;

/**
 * The rows a ladder step serves: three quarters of its depth (75, 300, 1,200, 3,750). The last
 * quarter is headroom for the hits a step drops — copies of a shot already in it (#4557) and
 * hits the filters reject — so a step whose ranking holds a few of them still fills its pages
 * without ranking again. Every widening re-runs the engine's whole query (on production about
 * 50 ms in the in-process child), so a step that had to hold its full depth in shots widened
 * almost every search with a single copy in its first 100 hits.
 */
export function stepQuota(depth: number): number {
  return Math.floor((depth * 3) / 4);
}

/**
 * The first depth on the widening ladder whose quota reaches `need` rows. Requests whose pages
 * share a ladder step share a window, which is what the facet and bucket caches key on.
 */
export function windowDepthFor(need: number): number {
  const climb = (depth: number): number =>
    stepQuota(depth) >= need || depth >= RANKED_WINDOW_MAX
      ? Math.min(depth, RANKED_WINDOW_MAX)
      : climb(depth * WIDENING_FACTOR);
  return climb(RANKED_WINDOW_BASE);
}

/**
 * The window a request reaching `need` rows is served from. It is filled to the quota of the
 * ladder step that reaches `need`: a full window with fewer survivors than that quota is widened
 * up the ladder until it has them, the engine runs out of hits, or the cap is reached. So every page's `skip` indexes
 * a prefix earlier pages served in full, and the window depends only on the query and its step —
 * which is what lets the facet and bucket caches share it across the pages of a step. Each pass
 * keeps one row per shot (#4557), so the survivors counted here, `total` and every page count
 * shots, and a pass whose copies leave it short widens like any other. A caller
 * with no pages to keep stable passes `enough`: widening stops at that many survivors instead.
 */
export async function rankWindow(
  ranker: WindowRanker,
  need: number,
  enough?: number,
): Promise<RankedWindow | null> {
  const target = windowDepthFor(need);
  const sufficient = enough ?? stepQuota(target);
  const widen = async (
    depth: number,
    previous: { pass: WindowPass; depth: number } | null,
  ): Promise<RankedWindow | null> => {
    const atCap = depth >= RANKED_WINDOW_MAX;
    const answer = await ranker(depth, atCap ? 1 : 0);
    const pass = answer && { ...answer, rows: collapseShots(answer.rows) };
    if (pass === null) return previous && windowOf(previous.pass, previous.depth);
    if (pass.rows.length >= sufficient || pass.considered < depth || atCap) {
      return windowOf(pass, depth);
    }
    return widen(Math.min(RANKED_WINDOW_MAX, depth * WIDENING_FACTOR), { pass, depth });
  };
  return widen(target, null);
}

/** Whether `pass`, ranked at `depth`, had a new shot past the cap beyond the `held` window. */
export function cappedPast(held: readonly WindowRow[], pass: WindowPass, depth: number): boolean {
  const beyond = pass.beyond ?? [];
  const newShots = collapseShots([...held, ...beyond]).length - held.length;
  const copiesBeyond = beyond.length - newShots;
  return depth >= RANKED_WINDOW_MAX && pass.considered - copiesBeyond > depth;
}

/**
 * Below the cap a full pass says more; at the cap only a lookahead hit past it says capped — and
 * only one that could be a new tile. A lookahead hit that is another copy of a shot the window
 * already holds (#4557) says nothing about shots left past the cap, so it is not counted.
 */
function windowOf(pass: WindowPass, depth: number): RankedWindow {
  const atCap = depth >= RANKED_WINDOW_MAX;
  return {
    rows: pass.rows,
    more: !atCap && pass.considered >= depth,
    capped: cappedPast(pass.rows, pass, depth),
    semantic: pass.semantic ?? new Set(),
    scores: pass.scores,
    depth,
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
export function ftsWindowSql(where: SearchWhere, depth: number, lookahead = 0): BoundStatement {
  if (where.match.kind !== 'match') throw new Error('ftsWindowSql: not a text query');
  const narrowing = monthNarrowing(where);
  const rest = searchWhereSql({ ...where, match: { kind: 'none' } });
  const probed =
    lookahead > 0
      ? {
          sql: `,
    probed AS MATERIALIZED (SELECT sr, rank FROM hit ORDER BY rank, sr LIMIT ?)`,
          beyond: 'hit.sr NOT IN (SELECT sr FROM probed)',
          params: [depth],
        }
      : { sql: '', beyond: '0', params: [] };
  return {
    sql: `WITH hit AS MATERIALIZED (
      SELECT assets_fts.rowid AS sr, ${FTS_RANK_SQL}
        FROM assets_fts
       WHERE assets_fts MATCH ?${narrowing ? `\n         AND ${narrowing.sql}` : ''}
       ORDER BY ${FTS_RANK_ORDER}, assets_fts.rowid
       LIMIT ?)${probed.sql},
    alive AS MATERIALIZED (
      SELECT hit.rank AS rank, hit.sr AS sr, assets.rowid AS r, assets.id AS id,
             assets.maple_id AS maple_id, assets.owner_id AS owner_id,
             assets.captured_at AS captured_at, assets.media_kind AS media_kind,
             ${LIVE_FILENAME_SQL} AS filename, ${probed.beyond} AS beyond
        FROM hit
        CROSS JOIN asset_search ON asset_search.rowid = hit.sr
        CROSS JOIN assets ON assets.id = asset_search.asset_id
       ${rest.sql})
  SELECT (SELECT COUNT(*) FROM hit) AS considered, alive.r AS r, alive.id AS id,
         alive.maple_id AS maple_id, alive.owner_id AS owner_id,
         alive.captured_at AS captured_at, alive.media_kind AS media_kind,
         alive.filename AS filename, alive.beyond AS beyond
    FROM (SELECT 1) LEFT JOIN alive ON 1
   ORDER BY alive.rank ASC, alive.sr ASC`,
    params: [
      where.match.expression,
      ...(narrowing?.params ?? []),
      depth + lookahead,
      ...probed.params,
      ...rest.params,
    ],
  };
}

/** {@link ftsWindowSql} as a {@link WindowRanker}, through the pool's bulk lane. */
export function ftsRanker(where: SearchWhere, dbOverride?: SqliteDb): WindowRanker {
  return async (depth, lookahead = 0) => {
    if (where.match.kind !== 'match') return { rows: [], considered: 0 };
    const window = ftsWindowSql(where, depth, lookahead);
    const answer = await readBulk<
      { considered: number; beyond: number | null } & {
        [K in keyof WindowRow]: WindowRow[K] | null;
      }
    >(assetsDb(dbOverride), window.sql, window.params);
    const survivors = answer.flatMap(
      ({ r, id, maple_id, owner_id, captured_at, media_kind, filename, beyond }) =>
        r === null || id === null || media_kind === null
          ? []
          : [{ row: { r, id, maple_id, owner_id, captured_at, media_kind, filename }, beyond }],
    );
    return {
      considered: answer[0]?.considered ?? 0,
      rows: survivors.flatMap(({ row, beyond }) => (beyond ? [] : [row])),
      beyond: survivors.flatMap(({ row, beyond }) => (beyond ? [row] : [])),
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
    `assets.rowid AS r, assets.id AS id, assets.maple_id AS maple_id, assets.owner_id AS owner_id,
     assets.captured_at AS captured_at, assets.media_kind AS media_kind,
     ${LIVE_FILENAME_SQL} AS filename`,
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

/**
 * The exact `total` of a text search, without reading a row per match
 * (#4425).
 *
 * Counting a broad text search the obvious way joins every full-text match to
 * `asset_search` and `assets` to ask whether it is listed — about a second at
 * production's 98,635 matches for "group of people standing in front of the
 * ocean". For the search the grid opens with — text only, hidden assets left
 * out, perhaps a month — the question has a cheaper exact answer:
 *
 *   - With a month, the text match is already narrowed to the month's live,
 *     visible rows (`monthNarrowing`), so counting the inverted index under
 *     that narrowing is the total. No join at all.
 *   - Without one, it is every full-text match less the matches among the
 *     unlisted assets — trashed, without a live file, or hidden — which the
 *     `assets_unlisted` index enumerates. That set is small in any library
 *     people actually browse, and it is checked against the match list rather
 *     than probed per match.
 *
 * Any other filter, or another visibility mode, keeps the joined count: the
 * filter decides membership and only the asset row can answer it. Both are
 * exact; neither is an estimate.
 */

import { UNLISTED_ASSET_PREDICATE } from '../sqlite/migrations/0020-assets-unlisted.ts';
import { countSql, type BoundStatement } from './search.sql.ts';
import { monthNarrowing, type SearchWhere } from './search.where.ts';
import type { SqliteDb } from './db-handle.ts';

/** Whether the only things narrowing the match are the default visibility and a month. */
export function textOnly(where: SearchWhere): boolean {
  return where.hidden === 0 && where.clauses.length === (where.month === null ? 0 : 1);
}

const QUALIFIED_UNLISTED = UNLISTED_ASSET_PREDICATE.replace(
  /\b(deleted_at|live_location_count|hidden)\b/g,
  'assets.$1',
);

/** The count without a join per match, for a {@link textOnly} search. */
export function textOnlyCountSql(where: SearchWhere): BoundStatement {
  if (where.match.kind !== 'match') throw new Error('textOnlyCountSql: not a text query');
  const expression = where.match.expression;
  const narrowing = monthNarrowing(where);
  if (narrowing) {
    return {
      sql: `SELECT COUNT(*) AS n FROM assets_fts WHERE assets_fts MATCH ? AND ${narrowing.sql}`,
      params: [expression, ...narrowing.params],
    };
  }
  return {
    sql: `SELECT
      (SELECT COUNT(*) FROM assets_fts WHERE assets_fts MATCH ?)
    - (SELECT COUNT(*)
         FROM assets INDEXED BY assets_unlisted
         JOIN asset_search ON asset_search.asset_id = assets.id
        WHERE (${QUALIFIED_UNLISTED})
          AND +asset_search.rowid IN (SELECT assets_fts.rowid FROM assets_fts WHERE assets_fts MATCH ?)
      ) AS n`,
    params: [expression, expression],
  };
}

/** How many assets a text search matches — always exact. */
export async function textCount(db: SqliteDb, where: SearchWhere): Promise<number> {
  const statement = textOnly(where) ? textOnlyCountSql(where) : countSql(where);
  const rows = await db.read<{ n: number }>(statement.sql, statement.params);
  return rows[0]?.n ?? 0;
}

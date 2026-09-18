/**
 * The second of the two `$text` call sites: the ranked lexical fallback behind
 * `POST /api/service/assets/search`.
 *
 * That route prefers Meilisearch and falls back to the database when the
 * sidecar is absent, unconfigured or failing. The fallback runs two queries —
 * an exact filename match first, then a ranked full-text pass to fill the rest
 * of the page — and it is the second one that uses `$text` with a
 * `{ $meta: 'textScore' }` sort. Both are ported here, because splitting them
 * would leave the caller assembling a result set out of two engines.
 *
 * ## Two things this does better than the Mongo version
 *
 * **Media type is a column, not a filename guess.** The Mongo filter builds a
 * regex over the video and audio extension lists and matches it against
 * `fileinfo[].filename`, so a `.mov` renamed to `.mp4` is classified by its
 * name and an unindexed extension is classified as an image. `media_kind` is
 * set by the indexer from the actual file, is denormalised onto the asset row
 * (#3492) and has a partial index over the two minority kinds.
 *
 * **A text-search failure is not swallowed.** The Mongo version wraps its
 * ranked pass in a `try` that logs and returns the exact matches alone, because
 * a malformed `$text` string throws. The FTS5 expression is built by
 * {@link toTextFilter}, which quotes every term, so there is no user input
 * that can produce a syntax error and nothing to swallow.
 */

import { placeholders } from './assets.sql.ts';
import { toTextFilter } from './search.fts.ts';
import { serviceTextSearchSql } from './search.sql.ts';
import { likeLiteral } from './search.terms.ts';
import { QUALIFIED_LIVE_PREDICATE } from './search.where.ts';
import { assetsDb, type SqliteDb } from './db-handle.ts';
import type { SqlValue } from '../protocol.ts';

/** The media kinds a caller can ask to be limited to. */
export type ServiceMediaType = 'image' | 'video' | 'audio';

/** The parts of a service search request that narrow the query. */
export interface ServiceSearchScope {
  includeHidden: boolean;
  mediaTypes: ServiceMediaType[] | undefined;
  capturedFrom: string | undefined;
  capturedBefore: string | undefined;
}

/** A predicate and its bound values. */
interface Bound {
  sql: string;
  params: SqlValue[];
}

/**
 * The scope filters every branch of this route shares.
 *
 * The capture window is a lexicographic range over the ISO string, closed at
 * the bottom and open at the top, exactly as the Mongo clause is. NULL fails
 * both comparisons, so an asset with no capture date drops out of a windowed
 * search — which is what a caller asking for a date range wants, and what
 * Mongo's type bracketing gave for free.
 */
function scopeClauses(scope: ServiceSearchScope): Bound {
  const kinds = scope.mediaTypes;
  const parts: Bound[] = [
    ...(scope.includeHidden ? [] : [{ sql: 'assets.hidden = 0', params: [] }]),
    ...(kinds === undefined || kinds.length === 0
      ? []
      : [
          {
            sql: `assets.media_kind IN (${placeholders(kinds.length)})`,
            params: [...kinds] as SqlValue[],
          },
        ]),
    ...(scope.capturedFrom === undefined
      ? []
      : [{ sql: 'assets.captured_at >= ?', params: [scope.capturedFrom] as SqlValue[] }]),
    ...(scope.capturedBefore === undefined
      ? []
      : [{ sql: 'assets.captured_at < ?', params: [scope.capturedBefore] as SqlValue[] }]),
  ];
  return {
    sql: parts.length === 0 ? '' : ` AND ${parts.map((part) => part.sql).join(' AND ')}`,
    params: parts.flatMap((part) => part.params),
  };
}

/**
 * Assets whose filename is exactly the query, ignoring case.
 *
 * `LIKE` with no wildcards is an equality test that is case-insensitive for
 * ASCII, which is what the anchored `^…$` case-insensitive regex it replaces
 * amounted to. The query is escaped through the same {@link likeLiteral} every
 * other `LIKE` in the search layer uses — a second copy of the escape here read
 * identically and would have gone on reading identically right up until one of
 * them gained a character, at which point the two would disagree about which
 * rows match rather than fail.
 */
function exactFilenameSql(scope: Bound): string {
  return `
    SELECT DISTINCT assets.maple_id AS maple_id
      FROM assets
     WHERE ${QUALIFIED_LIVE_PREDICATE}
       AND assets.maple_id IS NOT NULL AND assets.maple_id <> ''
       AND EXISTS (SELECT 1 FROM asset_locations l
                    WHERE l.asset_id = assets.id
                      AND l.deleted_at IS NULL AND l.missing_since IS NULL
                      AND l.filename LIKE ? ESCAPE '\\')${scope.sql}
     LIMIT ?`;
}

/** What the route needs back: content ids, and which of them matched exactly. */
export interface ServiceSearchHits {
  ids: string[];
  exactIds: Set<string>;
}

/**
 * The lexical fallback: exact filename matches first, then the best remaining
 * full-text matches, up to `limit` content ids in all.
 *
 * Ordering is the contract. An exact filename match is what a caller searching
 * for `IMG_4021.dng` means, so those lead; the ranked pass then fills whatever
 * is left of the page without repeating an id that is already in it. The ranked
 * pass is skipped entirely once the exact matches have filled the page, which
 * is the same short-circuit the Mongo version makes.
 */
export async function serviceLexicalSearch(
  scope: ServiceSearchScope,
  query: string,
  limit: number,
  dbOverride?: SqliteDb,
): Promise<ServiceSearchHits> {
  const db = assetsDb(dbOverride);
  const bound = scopeClauses(scope);
  const exactRows = await db.read<{ maple_id: string }>(exactFilenameSql(bound), [
    likeLiteral(query),
    ...bound.params,
    limit,
  ]);
  const ids = exactRows.map((row) => row.maple_id);
  const exactIds = new Set(ids);
  if (ids.length >= limit) return { ids, exactIds };

  // No expression means no ranked pass, and that is right for both of the
  // reasons it can happen: a blank query has nothing to rank by, and a query
  // whose terms all cancel (`-boat`, `???`) matches nothing to add. `$text`
  // answers zero documents for the second, so the page ends at the exact
  // filename matches either way.
  const match = toTextFilter(query);
  if (match.kind !== 'match') return { ids, exactIds };

  // The same scope clauses go into both statements, so the ranked pass and the
  // exact pass see the same universe of assets.
  const ranked = await db.read<{ maple_id: string }>(serviceTextSearchSql(bound.sql), [
    match.expression,
    ...bound.params,
    limit,
  ]);
  for (const row of ranked) {
    if (exactIds.has(row.maple_id) || ids.includes(row.maple_id)) continue;
    ids.push(row.maple_id);
    if (ids.length >= limit) break;
  }
  return { ids, exactIds };
}

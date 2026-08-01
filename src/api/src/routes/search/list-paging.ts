/**
 * Pagination-mode resolution for `GET /api/search` (#2129).
 *
 * The route accepts either a `page`/`limit` skip or an opaque seek `cursor`,
 * and which one is legal depends on the sort. This module turns the raw
 * query params into the one decision the handler needs — seek, skip, or 400
 * — so the handler itself stays a straight line.
 */

import type { Filter } from 'mongodb';
import type { AssetDoc } from '../../db/schema.ts';
import { cursorDirectionFor, decodeCursor, seekFilter, type CursorDirection } from './cursor.ts';

export interface Paging {
  /** `null` when this request can't be seeked — an unseekable sort or the
   * relevance-ordered place path. The route reports that on the wire as
   * `cursorPaging: false`. */
  direction: CursorDirection | null;
  /** Documents to SKIP. Always 0 once a cursor is in play. */
  skip: number;
  /** Range predicate to `$and` onto the caller's filter, or `null` in skip mode. */
  seek: Filter<AssetDoc> | null;
}

/**
 * Resolve the pagination mode, or return `{ error }` for the caller to turn
 * into a 400.
 *
 * A bad or mismatched cursor is rejected rather than ignored: silently
 * dropping it would restart the scroll at page 0 and re-serve every row the
 * user has already scrolled past.
 */
export function resolvePaging(
  rawCursor: string | undefined,
  sort: string,
  page: number,
  limit: number,
  /** True on the `placeQuery` path, whose `$meta: 'textScore'` ordering is
   * not a stored field and therefore not seekable at all. */
  usingPlaceText: boolean,
): Paging | { error: string } {
  const direction = usingPlaceText ? null : cursorDirectionFor(sort);
  const trimmed = typeof rawCursor === 'string' ? rawCursor.trim() : '';
  if (trimmed.length === 0) return { direction, skip: page * limit, seek: null };

  if (direction === null) {
    return { error: 'cursor pagination is not available for this sort; use page/limit' };
  }
  const cursor = decodeCursor(trimmed);
  if (cursor === null || cursor.d !== direction) return { error: 'invalid cursor' };
  return { direction, skip: 0, seek: seekFilter(cursor) };
}

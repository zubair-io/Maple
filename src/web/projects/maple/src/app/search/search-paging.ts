// Pagination bookkeeping for the `/search` result grid (#2129).
//
// Pure, so the two non-obvious rules survive as testable statements rather
// than as conditions buried in a component method:
//
//   1. A seek request echoes back `page: 0`. Adopting it would rewind the
//      skip-mode fallback counter mid-scroll, so `page` is only taken from
//      responses that were actually paged.
//   2. A seekable query that hands back no cursor has been walked to its
//      end, so the loaded rows ARE the result set. `total` is cached
//      server-side for 30 s and can overstate it — believing the stale
//      number there leaves `canLoadMore` true and drops the grid back to
//      deep `page + 1` SKIP paging, the exact cost cursors remove.

import { seekExhausted, type SearchResponse } from '@maple-common';

export interface PagingState {
  /** Skip-mode fallback page counter. */
  page: number;
  /** Seek cursor for the next fetch, or `null`. */
  nextCursor: string | null;
  /** Result count to gate infinite scroll on (and to display). */
  total: number;
}

/**
 * Fold a search response into the grid's pagination state.
 *
 * @param seeked      whether this response answered a `cursor` request
 * @param loadedCount rows held after merging this response
 * @param currentPage the page counter before this response
 */
export function nextPagingState(
  r: SearchResponse,
  seeked: boolean,
  loadedCount: number,
  currentPage: number,
): PagingState {
  return {
    page: seeked ? currentPage : r.page,
    nextCursor: r.nextCursor ?? null,
    total: seekExhausted(r) ? loadedCount : r.total,
  };
}

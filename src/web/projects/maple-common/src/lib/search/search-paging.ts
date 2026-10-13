import { seekExhausted, type SearchResponse, type SearchResult } from '../api/search.service';

/** What the grid holds after a further page lands. */
export interface AppendedPage {
  results: readonly SearchResult[];
  nextCursor: string | null;
  total: number;
  /** The server ranked a window of the text and had hits left past `total` (#4514). */
  more: boolean;
  /** The window stopped at the server's 5,000-hit cap with matches left. */
  capped: boolean;
  /** A free-text window grew, so facets describing the old window are stale. */
  widened: boolean;
}

/**
 * Folds a further page into the rows already held. An empty page or an exhausted seek chain ends
 * the set at the rows held; otherwise the server's `total` stands, and a free-text `total` that
 * changed means the ranked window widened.
 */
export function appendPage(
  held: readonly SearchResult[],
  heldTotal: number,
  res: SearchResponse,
  hasText: boolean,
): AppendedPage {
  const results = [...held, ...res.results];
  const landed = res.results.length > 0;
  return {
    results,
    nextCursor: res.nextCursor ?? null,
    total: seekExhausted(res) || !landed ? results.length : res.total,
    more: landed && (res.more ?? false),
    capped: res.capped ?? false,
    widened: hasText && landed && res.total !== heldTotal,
  };
}

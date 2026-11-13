/**
 * The in-process search engine as the routes see it: started at boot, asked for the fused ranking
 * of a text query, and answering `null` whenever it cannot — still loading, not running, dead
 * mid-query. Callers then rank in the database through the same bounded window, so a search never
 * fails because the engine is unavailable.
 */

import { child as childLogger } from '../log.ts';
import { RANKED_WINDOW_BASE } from '../db/repos/search.ranked.ts';
import { searchChildConfig } from './search-child-config.ts';
import { inProcessRanker, searchChildPool } from './search-pool.ts';
import type { FusedSearchHit } from './search-engine-ffi.ts';

const log = childLogger('search-engine');

/** Boot: start the search child. Never throws. */
export function startSearchEngine(): void {
  try {
    searchChildPool(searchChildConfig).start();
  } catch (err) {
    log.error({ err }, 'could not start the search child; searches use the full-text path');
  }
}

/** The child's fused top `k` for `query`, or null when it cannot answer. */
export async function inProcessRanking(
  query: string,
  k: number = RANKED_WINDOW_BASE,
): Promise<FusedSearchHit[] | null> {
  return (await inProcessRanker()?.search(query, k)) ?? null;
}

/**
 * The in-process branch of `POST /api/search/assets` (#4463): the request's best matches from the
 * shared ranked window (`search/ranked-window.ts`), which ranks the query with the search child
 * and filters by the request's own scope (hidden, media type, capture window), widening 100 → 400
 * → 1,600 → 5,000 until `limit` survivors are found (#4549). Null when the engine cannot answer,
 * and the route takes its database path.
 */

import { serviceSearchWhere, type ServiceSearchScope } from '../db/repos/search.service.ts';
import { requestWindow } from './search/ranked-window.ts';

/** Asset ids best first, with the count of every match and the engine's scores when it has them. */
export interface ServiceSearchResult {
  ids: string[];
  /** The ids delivered: a total the caller can always retrieve, never the window's larger size. */
  estimatedTotal: number;
  scores?: Record<string, number>;
  more?: boolean;
  capped?: boolean;
}

export async function inProcessServiceSearch(
  scope: ServiceSearchScope,
  query: string,
  limit: number,
): Promise<ServiceSearchResult | null> {
  const window = await requestWindow(
    { where: serviceSearchWhere(scope), text: query, need: limit },
    'collection',
  );
  if (!window) return null;
  const ids = window.rows.flatMap((row) => (row.maple_id === null ? [] : [row.maple_id]));
  return {
    ids: ids.slice(0, limit),
    estimatedTotal: Math.min(ids.length, limit),
    scores: Object.fromEntries(window.scores ?? []),
    more: window.more || ids.length > limit,
    capped: window.capped,
  };
}

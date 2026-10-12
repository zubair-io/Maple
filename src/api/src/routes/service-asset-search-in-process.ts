/**
 * The in-process branch of `POST /api/search/assets` (#4463): the search child's fused top
 * candidates, narrowed in SQL by the request's own scope (hidden, media type, capture window) and
 * cut to its limit. Null when the engine cannot answer, and the route takes its database path.
 */

import { serviceScopedMapleIds, type ServiceSearchScope } from '../db/repos/search.service.ts';
import { inProcessRanking } from '../search/search-ranking.ts';

/** Asset ids best first, with the count of every match and the engine's scores when it has them. */
export interface ServiceSearchResult {
  ids: string[];
  estimatedTotal: number;
  scores?: Record<string, number>;
}

export async function inProcessServiceSearch(
  scope: ServiceSearchScope,
  query: string,
  limit: number,
): Promise<ServiceSearchResult | null> {
  const hits = await inProcessRanking(query);
  if (!hits) return null;
  const scores = Object.fromEntries(hits.map((hit) => [hit.id, hit.score] as const));
  const ranked = await serviceScopedMapleIds(
    scope,
    hits.map((hit) => hit.id),
  );
  return { ids: ranked.slice(0, limit), estimatedTotal: ranked.length, scores };
}

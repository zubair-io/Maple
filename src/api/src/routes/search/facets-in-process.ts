/**
 * The in-process ranking a text search's facets describe, when Settings → AI selects the
 * in-process engine (#4463) — the same filtered candidate list `inProcessPage` pages through, so
 * the facets count the photos the list shows. Undefined when this search has no free text; a
 * ranking that resolves to null (engine not selected or not answering) hands the facets back to
 * the Meilisearch or database ranking, as the list falls back in the same cases.
 */

import { mapleIdsMatching } from '../../db/repos/search.repo.ts';
import type { ExternalRanking } from '../../db/repos/search.facets.ts';
import type { SearchWhere } from '../../db/repos/search.where.ts';
import { inProcessRanking } from '../../search/search-engine-selection.ts';
import { usesPlaceText } from './list-meili.ts';
import { extractDatesFromQuery, type SearchQuery } from './query.ts';

export function inProcessFacetRanking(
  query: SearchQuery,
  where: SearchWhere,
): (() => Promise<ExternalRanking | null>) | undefined {
  const resolved = extractDatesFromQuery(query, new Date());
  if (!usesPlaceText(resolved)) return undefined;
  return async () => {
    const hits = await inProcessRanking(resolved.placeQuery!.trim());
    if (!hits) return null;
    const mapleIds = await mapleIdsMatching(
      where,
      hits.map((hit) => hit.id),
    );
    return { mapleIds, total: mapleIds.length };
  };
}

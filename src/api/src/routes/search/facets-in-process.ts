/**
 * The in-process ranking a text search's facets describe, when Settings → AI selects the
 * in-process engine (#4463) — the same ranked window the list pages through (`ranked-window.ts`),
 * so the facets count the photos the list shows. Undefined when this search has no free text; a
 * ranking that resolves to null (engine not selected or not answering) hands the facets back to
 * the Meilisearch or database ranking, as the list falls back in the same cases.
 */

import type { ExternalRanking } from '../../db/repos/search.facets.ts';
import { RANKED_WINDOW_BASE } from '../../db/repos/search.ranked.ts';
import { inProcessWindow } from './ranked-window.ts';
import type { RankedSearchScope } from './scope.ts';

export function inProcessFacetRanking(
  scope: RankedSearchScope,
): (() => Promise<ExternalRanking | null>) | undefined {
  const { childQuery, where } = scope;
  if (childQuery === null) return undefined;
  return async () => {
    const window = await inProcessWindow(where, childQuery, RANKED_WINDOW_BASE);
    if (!window) return null;
    const mapleIds = window.rows.flatMap((row) => (row.maple_id === null ? [] : [row.maple_id]));
    return { mapleIds, total: mapleIds.length };
  };
}

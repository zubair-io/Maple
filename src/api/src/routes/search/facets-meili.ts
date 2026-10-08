/**
 * The Meilisearch ranking a text search's facets describe, when Meilisearch
 * serves that search's list (#4431).
 *
 * A broad text search is faceted over its most relevant matches rather than
 * every match, and "most relevant" has to mean what the list shows. When the
 * sidecar is configured and the query is one it can answer — the same test
 * `meiliPage` applies — the list is Meilisearch's ranking, typo-tolerant and
 * possibly semantic, and the database's `bm25()` order would describe a
 * different set of photos. So the facets ask Meilisearch for the ids of its
 * best matches, with the same filters the list request carries, and count
 * those. Anything else — not configured, a filter it cannot express, a
 * failure or a timeout — answers null, and the facets use the database's own
 * ranking, as the list does in the same cases.
 */

import { meilisearchClient } from '../../enrichment/meilisearch-client.ts';
import { child as childLogger } from '../../log.ts';
import type { ExternalRanking } from '../../db/repos/search.facets.ts';
import { meiliSearchOptions, unpushableFilters, usesPlaceText } from './list-meili.ts';
import { extractDatesFromQuery, type SearchQuery } from './query.ts';

const searchLog = childLogger('search');

/** Meilisearch's best `limit` matches for `query`, or null to use the database. */
export async function meiliFacetRanking(
  query: SearchQuery,
  limit: number,
): Promise<ExternalRanking | null> {
  const resolved = extractDatesFromQuery(query, new Date());
  const meili = meilisearchClient();
  if (!usesPlaceText(resolved) || !meili.isConfigured()) return null;
  if (unpushableFilters(resolved).length > 0) return null;
  try {
    const hit = await meili.search(resolved.placeQuery!.trim(), {
      ...meiliSearchOptions(resolved, query.libraryId, meili.semanticConfigured()),
      offset: 0,
      limit,
    });
    return { mapleIds: hit.ids, total: hit.estimatedTotal };
  } catch (err) {
    searchLog.warn(
      { err: err instanceof Error ? err.message : String(err), placeQuery: resolved.placeQuery },
      'meilisearch facet ranking failed; faceting the database ranking instead',
    );
    return null;
  }
}

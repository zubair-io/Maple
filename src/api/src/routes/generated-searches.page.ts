/**
 * One page of a generated-search collection, live (#4514).
 *
 * A card whose query carries free text is a ranked collection: the in-process engine ranks the
 * text and SQL filters its hits (`search/ranked-window.ts`), so `total` is the ranked window's
 * size and `more` says a deeper page can widen it — the same window `GET /api/search` serves for
 * the same query, and the one the worker measured the card with.
 *
 * While the in-process engine is still loading (about a minute after a restart) the
 * collection answers with the worker's stored preview and `pending: true` rather than ranking the
 * text in the database: those rows are what the card already shows, `total` is their count on
 * every page, and `more` says to ask again once the engine is up.
 *
 * A card without free text is a structured filter — dates, people, scene type — with no full-text
 * term, so its page is the capture-ordered index walk `GET /api/search` uses and its `total` a live
 * count on the same structured indexes: the live hidden-people and screenshot exclusions move both.
 */

import { searchCount, searchPage } from '../db/repos/search.page.ts';
import { assetsDb, bulkLane } from '../db/repos/db-handle.ts';
import type { SearchWhere } from '../db/repos/search.where.ts';
import type { GeneratedSearchDoc } from '../workers/generated-search/repo.ts';
import { libraryMaps } from './search/libraries.ts';
import { projectAssets, type SearchResult } from './search/project.ts';
import type { SearchQuery } from './search/query.ts';
import { requestWindow, windowPage } from './search/ranked-window.ts';
import { storedPage } from './generated-searches.stored-page.ts';

export interface CollectionPage {
  total: number;
  results: SearchResult[];
  more?: boolean;
  capped?: boolean;
  snapshot?: true;
  pending?: true;
}

export interface CollectionPageInput {
  doc: GeneratedSearchDoc;
  where: SearchWhere;
  resolved: SearchQuery;
  offset: number;
  limit: number;
}

export async function collectionPage(input: CollectionPageInput): Promise<CollectionPage> {
  const text = input.resolved.placeQuery?.trim() ?? '';
  return text.length > 0 ? rankedCollectionPage(input, text) : structuredCollectionPage(input);
}

async function rankedCollectionPage(
  input: CollectionPageInput,
  text: string,
): Promise<CollectionPage> {
  const { doc, where, offset, limit } = input;
  const page = { skip: offset, limit };
  const request = { where, text, need: offset + limit };
  const window = await requestWindow(request, 'collection');
  return window ? withoutRankedBy(await windowPage(window, page)) : pendingPage(doc, where, page);
}

function withoutRankedBy(page: {
  total: number;
  more: boolean;
  capped: boolean;
  results: SearchResult[];
}): CollectionPage {
  return { total: page.total, more: page.more, capped: page.capped, results: page.results };
}

/**
 * The stored preview while the engine loads, paged like any collection. `total` is the preview's
 * row count on every page; `more` stays true while a page is inside the preview, so a client asks
 * again once the engine is up, and is false past its end, so nothing pages on into empty results.
 */
async function pendingPage(
  doc: GeneratedSearchDoc,
  where: SearchWhere,
  page: { skip: number; limit: number },
): Promise<CollectionPage> {
  const stored = doc.first_page_ids ?? [];
  const preview =
    stored.length === 0
      ? []
      : (await storedPage({ ...doc, first_page_ids: stored }, where)).results;
  return {
    total: preview.length,
    results: preview.slice(page.skip, page.skip + page.limit),
    more: page.skip < preview.length,
    snapshot: true,
    pending: true,
  };
}

async function structuredCollectionPage(input: CollectionPageInput): Promise<CollectionPage> {
  const { where, offset, limit } = input;
  const lane = bulkLane(assetsDb());
  const [docs, total, { libs, idToSlug }] = await Promise.all([
    searchPage(where, { sort: 'captured_desc', limit, skip: offset }, lane),
    searchCount(where, lane),
    libraryMaps(),
  ]);
  return { total, results: projectAssets(docs, libs, idToSlug) };
}

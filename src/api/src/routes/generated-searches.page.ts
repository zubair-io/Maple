/**
 * One page of a generated-search collection, live (#4514).
 *
 * A card whose query carries free text is a ranked collection: the in-process engine ranks the
 * text and SQL filters its hits (`search/ranked-window.ts`), so `total` is the ranked window's
 * size and `more` says a deeper page can widen it — the same window `GET /api/search` serves for
 * the same query, and the one the worker measured the card with. Meilisearch answers when it is
 * configured and the child is not selected.
 *
 * While the selected in-process engine is still loading (about a minute after a restart) the
 * collection answers with the worker's stored preview and `pending: true` rather than ranking the
 * text in the database: those rows are what the card already shows, and `total` is their count so
 * a client pages no further until it asks again. Only a server with no engine selected or
 * configured ranks a card in the database, through the same bounded window.
 *
 * A card without free text is a structured filter. Its page is the capture-ordered index walk
 * `GET /api/search` uses, and its `total` is the worker's stored count, so no request counts the
 * collection.
 */

import { searchPage } from '../db/repos/search.page.ts';
import { assetsDb, bulkLane } from '../db/repos/db-handle.ts';
import type { SearchWhere } from '../db/repos/search.where.ts';
import type { GeneratedSearchDoc } from '../workers/generated-search/repo.ts';
import { inProcessSelected } from '../search/search-engine-selection.ts';
import { meiliPage } from './search/list-meili.ts';
import { libraryMaps } from './search/libraries.ts';
import { projectAssets, type SearchResult } from './search/project.ts';
import type { SearchQuery } from './search/query.ts';
import { databaseWindow, inProcessWindow, windowPage } from './search/ranked-window.ts';
import { storedPage } from './generated-searches.stored-page.ts';

export interface CollectionPage {
  total: number;
  results: SearchResult[];
  more?: boolean;
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
  const { doc, where, resolved, offset, limit } = input;
  const page = { skip: offset, limit };
  const need = offset + limit;
  const inProcess = await inProcessWindow(where, text, need);
  if (inProcess) return windowPage(inProcess, page).then(withoutRankedBy);
  const meili = await meiliPage({ where, resolved, libraryId: doc.library_id, ...page });
  if (meili) return { total: meili.total, results: meili.results };
  if (await inProcessSelected()) return pendingPage(doc, offset, where);
  return withoutRankedBy(await windowPage(await databaseWindow(where, need), page));
}

function withoutRankedBy(page: {
  total: number;
  more: boolean;
  results: SearchResult[];
}): CollectionPage {
  return { total: page.total, more: page.more, results: page.results };
}

/** The stored preview while the engine loads: its rows, and a total that ends paging there. */
async function pendingPage(
  doc: GeneratedSearchDoc,
  offset: number,
  where: SearchWhere,
): Promise<CollectionPage> {
  const stored = doc.first_page_ids;
  if (offset > 0 || stored === null || stored.length === 0) {
    return { total: offset, results: [], snapshot: true, pending: true };
  }
  const preview = await storedPage({ ...doc, first_page_ids: stored }, where);
  return { total: preview.results.length, results: preview.results, snapshot: true, pending: true };
}

async function structuredCollectionPage(input: CollectionPageInput): Promise<CollectionPage> {
  const { doc, where, offset, limit } = input;
  const [docs, { libs, idToSlug }] = await Promise.all([
    searchPage(where, { sort: 'captured_desc', limit, skip: offset }, bulkLane(assetsDb())),
    libraryMaps(),
  ]);
  return { total: doc.result_count, results: projectAssets(docs, libs, idToSlug) };
}

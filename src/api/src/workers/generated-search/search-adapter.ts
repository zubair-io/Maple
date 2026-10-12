/**
 * The loop's `runSearch` dependency: execute one candidate query and report
 * what it found.
 *
 * This deliberately mirrors `GET /api/generated-searches/:id/assets`
 * (`routes/generated-searches.page.ts`): the worker uses the count to decide
 * whether a collection is worth keeping and the read API renders the same
 * stored query later; if the two paths disagree, a collection measured at 40
 * photos shows up on a widget with four.
 *
 * A query with free text is measured as its ranked window (#4514): the
 * in-process engine ranks the text — reached through the API process, which
 * owns the child (#4510, `search/remote-search.ts`) — and SQL filters its hits;
 * Meilisearch when it is configured instead; the database's inverted index when
 * neither answers. The count is the window's size, never a count of every
 * match: a caption-style theme matches most of a library, and counting that
 * took minutes per statement on production. A query without free text is a
 * structured filter, counted on the indexes that serve it.
 *
 * Every read goes through the pool's bulk lane, so a run can never hold every
 * reader of the process it runs in — the worker tier's own on a scheduled pass,
 * the API's on Settings → Workers' Run now.
 */

import { child as childLogger } from '../../log.ts';
import { searchCount, searchPage, windowDocs } from '../../db/repos/search.page.ts';
import { assetsDb, bulkLane } from '../../db/repos/db-handle.ts';
import type { WindowRow } from '../../db/repos/search.ranked.ts';
import type { SearchWhere } from '../../db/repos/search.where.ts';
import { requestWindow } from '../../routes/search/ranked-window.ts';
import type { SearchQuery } from '../../routes/search/query.ts';
import { resolveSearchWhere } from './execute.ts';
import { FIRST_PAGE_SIZE } from './first-page.ts';
import type { SearchOutcome } from './loop.ts';

const log = childLogger('generated-search');

/**
 * How many matched assets to pull captions from. Phase 3 only needs enough
 * evidence to name the collection honestly; the full set can be tens of
 * thousands, and the titling prompt has to stay small.
 */
const CAPTION_SAMPLE = 10;

/** Non-empty captions only — phase 3 reads these as evidence, and a list of
 * blanks would let it invent a title from nothing. */
function captionsOf(rows: readonly { description?: string | null }[]): string[] {
  return rows
    .map((row) => row.description)
    .filter((text): text is string => typeof text === 'string' && text.trim().length > 0)
    .map((text) => text.trim());
}

export async function runGeneratedSearch(query: SearchQuery): Promise<SearchOutcome> {
  const prepared = await resolveSearchWhere(query);
  if ('error' in prepared) {
    log.warn({ error: prepared.error }, 'candidate query rejected by the search-query builder');
    return { count: 0, captions: [], coverAssetId: null, firstPageIds: [] };
  }
  const { resolved, where } = prepared;
  const text = resolved.placeQuery?.trim() ?? '';
  return text.length > 0
    ? rankedOutcome(where, resolved, query.libraryId, text)
    : structuredOutcome(where);
}

async function rankedOutcome(
  where: SearchWhere,
  resolved: SearchQuery,
  libraryId: string | undefined,
  text: string,
): Promise<SearchOutcome> {
  const window = await requestWindow({ where, resolved, text, libraryId, need: FIRST_PAGE_SIZE });
  return windowOutcome(window.rows);
}

async function windowOutcome(rows: readonly WindowRow[]): Promise<SearchOutcome> {
  const firstPageIds = rows.slice(0, FIRST_PAGE_SIZE).map((row) => row.id);
  const sampled = await windowDocs(rows.slice(0, CAPTION_SAMPLE));
  return {
    count: rows.length,
    captions: captionsOf(sampled as ReadonlyArray<{ description?: string | null }>),
    coverAssetId: firstPageIds[0] ?? null,
    firstPageIds,
  };
}

async function structuredOutcome(where: SearchWhere): Promise<SearchOutcome> {
  const lane = bulkLane(assetsDb());
  const [count, rows] = await Promise.all([
    searchCount(where, lane),
    searchPage(where, { sort: 'captured_desc', limit: FIRST_PAGE_SIZE, skip: 0 }, lane),
  ]);
  return {
    count,
    captions: captionsOf(
      (rows as ReadonlyArray<{ description?: string | null }>).slice(0, CAPTION_SAMPLE),
    ),
    coverAssetId: rows[0]?._id.toHexString() ?? null,
    firstPageIds: rows.map((row) => row._id.toHexString()),
  };
}

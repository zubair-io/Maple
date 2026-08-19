/**
 * The loop's `runSearch` dependency: execute one candidate query and report
 * what it found.
 *
 * This deliberately mirrors `GET /api/search`'s own sequence — resolve
 * natural-language dates, resolve the person ids to drop, resolve person
 * names to ids, `buildFilter`, `applyLiveFilter`, then Meilisearch first when
 * there is residual free text. The worker uses the count to decide whether a
 * collection is worth keeping and the read API renders the same stored query
 * later; if the two paths disagree, a collection measured at 40 photos shows
 * up on a widget with four.
 *
 * `placeQuery` goes through `meiliPage`, which passes
 * `semantic: meili.semanticConfigured()` — so a natural-language scene
 * description is matched against caption vectors rather than keywords. When
 * the sidecar is absent or errors, `meiliPage` returns null and this falls
 * back to the structured/`$text` Mongo path exactly as the route does.
 */

import { assetsCollection } from '../../db/client.ts';
import { personIdsToDrop } from '../../people/people.repo.ts';
import { personIdsForNames } from '../../people/people-search-filter.repo.ts';
import {
  applyLiveFilter,
  buildFilter,
  extractDatesFromQuery,
  peopleNames,
  type SearchQuery,
} from '../../routes/search/query.ts';
import { meiliPage } from '../../routes/search/list-meili.ts';
import { child as childLogger } from '../../log.ts';
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
  const empty: SearchOutcome = { count: 0, captions: [], coverAssetId: null };

  const resolved = extractDatesFromQuery(query);
  const [dropIds, peopleIds] = await Promise.all([
    personIdsToDrop(resolved.excludeHiddenPeople),
    personIdsForNames(peopleNames(resolved.people)),
  ]);

  const filterOrError = buildFilter(resolved, dropIds, peopleIds);
  if ('error' in filterOrError) {
    log.warn({ error: filterOrError.error }, 'candidate query rejected by buildFilter');
    return empty;
  }

  const coll = await assetsCollection();

  // Meilisearch first when there is residual free text, mirroring the route.
  const meili = await meiliPage({
    coll,
    filter: filterOrError,
    resolved,
    libraryId: query.libraryId,
    skip: 0,
    limit: CAPTION_SAMPLE,
  });
  if (meili !== null) {
    return {
      count: meili.total,
      captions: captionsOf(meili.results),
      coverAssetId: meili.results[0]?.id ?? null,
    };
  }

  const liveFilter = applyLiveFilter(filterOrError);
  const [count, rows] = await Promise.all([
    coll.countDocuments(liveFilter),
    coll
      .find(liveFilter, { projection: { maple_id: 1, description: 1 } })
      .limit(CAPTION_SAMPLE)
      .toArray(),
  ]);

  const cover = rows[0] as { maple_id?: unknown } | undefined;
  return {
    count,
    captions: captionsOf(rows as { description?: string | null }[]),
    coverAssetId: typeof cover?.maple_id === 'string' ? cover.maple_id : null,
  };
}

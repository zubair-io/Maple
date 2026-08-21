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
import { applyLiveFilter, type SearchQuery } from '../../routes/search/query.ts';
import { resolveLiveFilter } from './execute.ts';
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

  const prepared = await resolveLiveFilter(query);
  if ('error' in prepared) {
    log.warn({ error: prepared.error }, 'candidate query rejected by buildFilter');
    return empty;
  }
  const { resolved, filter } = prepared;

  const coll = await assetsCollection();

  // Meilisearch first when there is residual free text, mirroring the route.
  const meili = await meiliPage({
    coll,
    filter,
    resolved,
    libraryId: query.libraryId,
    skip: 0,
    limit: CAPTION_SAMPLE,
  });
  if (meili !== null) {
    return {
      count: meili.total,
      captions: captionsOf(meili.results),
      // `_id`, not `.id`: SearchResult.id is the editor-facing
      // `fs:<absPath>` form, useless against /api/assets/:id/*. The Mongo
      // `_id` hex is the identity both branches can agree on.
      coverAssetId: meili.results[0]?._id ?? null,
    };
  }

  const liveFilter = applyLiveFilter(filter);
  const [count, rows] = await Promise.all([
    coll.countDocuments(liveFilter),
    coll
      .find(liveFilter, { projection: { _id: 1, description: 1 } })
      .limit(CAPTION_SAMPLE)
      .toArray(),
  ]);

  const cover = rows[0] as { _id?: { toHexString(): string } } | undefined;
  return {
    count,
    captions: captionsOf(rows as { description?: string | null }[]),
    coverAssetId: cover?._id?.toHexString() ?? null,
  };
}

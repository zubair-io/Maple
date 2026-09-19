/**
 * The loop's `runSearch` dependency: execute one candidate query and report
 * what it found.
 *
 * This deliberately mirrors `GET /api/search`'s own sequence — resolve
 * natural-language dates, resolve the person ids to drop, resolve person
 * names to ids, `buildSearchWhere`, then Meilisearch first when there is
 * residual free text. The worker uses the count to decide whether a
 * collection is worth keeping and the read API renders the same stored query
 * later; if the two paths disagree, a collection measured at 40 photos shows
 * up on a widget with four.
 *
 * `placeQuery` goes through `meiliPage`, which passes
 * `semantic: meili.semanticConfigured()` — so a natural-language scene
 * description is matched against caption vectors rather than keywords. When
 * the sidecar is absent or errors, `meiliPage` returns null and this falls
 * back to the database's own full-text path exactly as the route does.
 *
 * ## No time bound, and why that is not a regression
 *
 * The Mongo version wrapped both legs in `maxTimeMS` (#2988): the `$text`
 * fallback matched on OR semantics, so a three-word query matched most of a
 * 333k-asset library and then sorted the whole match set by `textScore`, while
 * the count beside it was a documented ~2.5-second collection scan. Unbounded,
 * a few concurrent broad queries held their connections past the front proxy's
 * patience and the origin stopped answering.
 *
 * Neither leg has that shape here. The count is served by a partial index over
 * the live set and the page is an FTS5 `MATCH` with a `bm25()` order — the
 * measurements are in `docs/sqlite-schema.md`. More to the point, a bound is not
 * expressible: SQLite's interrupt is per connection, and these queries run on a
 * pooled worker shared with every other reader, so "abandon this statement"
 * would mean abandoning whatever else that worker is running.
 */

import { child as childLogger } from '../../log.ts';
import { searchCount, searchPage } from '../../db/repos/search.page.ts';
import { meiliPage } from '../../routes/search/list-meili.ts';
import type { SearchQuery } from '../../routes/search/query.ts';
import { resolveSearchWhere } from './execute.ts';
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

  const prepared = await resolveSearchWhere(query);
  if ('error' in prepared) {
    log.warn({ error: prepared.error }, 'candidate query rejected by the search-query builder');
    return empty;
  }
  const { resolved, where } = prepared;

  // Meilisearch first when there is residual free text, mirroring the route.
  const meili = await meiliPage({
    where,
    resolved,
    libraryId: query.libraryId,
    skip: 0,
    limit: CAPTION_SAMPLE,
  });
  if (meili !== null) {
    return {
      count: meili.total,
      captions: captionsOf(meili.results),
      // `_id`, not `.id`: `SearchResult.id` is the editor-facing `fs:<absPath>`
      // form, useless against `/api/assets/:id/*`. The hex id is the identity
      // both branches can agree on.
      coverAssetId: meili.results[0]?._id ?? null,
    };
  }

  // The database leg. The page and the total are composed from the same
  // `SearchWhere`, which is what makes them agree by construction — on Mongo
  // they were a `countDocuments` and a `find` over separately-wrapped filters.
  const [count, rows] = await Promise.all([
    searchCount(where),
    searchPage(where, { sort: 'captured_desc', limit: CAPTION_SAMPLE, skip: 0 }),
  ]);

  return {
    count,
    captions: captionsOf(rows as ReadonlyArray<{ description?: string | null }>),
    coverAssetId: rows[0]?._id.toHexString() ?? null,
  };
}

/**
 * `/api/generated-searches` — the daily themed collections the worker
 * invents, and the assets behind them.
 *
 * Endpoints:
 *   GET /api/generated-searches                — the day's collections
 *   GET /api/generated-searches/:id/assets     — run one and return results
 *
 * Both consumers (the Apple widget, the Maple TV shelf) call the second, so
 * query semantics live in exactly one place and cannot drift between
 * surfaces. The stored query is re-run through `toSearchQuery` on every
 * request rather than being materialised at generation time: that is what
 * forces `excludeHiddenPeople` and the screenshot exclusion on data written
 * by any earlier version of the worker.
 *
 * Registered after `requireAuth` in `src/index.ts`, like `/api/search`.
 */

import { Elysia, t } from 'elysia';
import { ObjectId } from '../db/object-id.ts';
import {
  findGeneratedSearchById,
  listGeneratedSearches,
} from '../db/repos/generated-searches.repo.ts';
import type { GeneratedSearchDoc } from '../workers/generated-search/repo.ts';
import { buildSearchWhere } from '../db/repos/search.where.ts';
import { searchCount, searchPage } from '../db/repos/search.page.ts';
import { toSearchQuery } from '../workers/generated-search/execute.ts';
import { loadLibraryRoots, loadLibraryIdToSlug } from '../indexer/libraries.cache.ts';
import { clampInt, extractDatesFromQuery, peopleNames } from './search/query.ts';
import { personIdsToDrop } from '../db/repos/people.visibility.ts';
import { personIdsForNames } from '../db/repos/people.search-filter.ts';
import { meiliPage } from './search/list-meili.ts';
import { projectAsset } from './search/project.ts';

/** Wire shape for a collection card. The stored `query` rides along so a
 * client can deep-link into `/search` with the same filters. */
function toCard(doc: GeneratedSearchDoc) {
  return {
    id: doc._id.toHexString(),
    theme: doc.theme,
    title: doc.title,
    subtitle: doc.subtitle,
    query: doc.query,
    result_count: doc.result_count,
    cover_asset_id: doc.cover_asset_id,
    generated_for: doc.generated_for,
  };
}

export const generatedSearchesRoutes = new Elysia({ prefix: '/api/generated-searches' })
  .get(
    '/',
    async ({ query }) => {
      const collections = await listGeneratedSearches(query.libraryId, query.date);
      return { results: collections.map(toCard) };
    },
    { query: t.Object({ libraryId: t.String(), date: t.Optional(t.String()) }) },
  )
  .get(
    '/:id/assets',
    async ({ params, query, set }) => {
      if (!ObjectId.isValid(params.id)) {
        set.status = 400;
        return { error: 'invalid id' };
      }

      const doc = await findGeneratedSearchById(new ObjectId(params.id));
      if (doc === null) {
        set.status = 404;
        return { error: 'not found' };
      }

      // Re-derive the live query on every request. Forcing at execution time
      // rather than at write time is what keeps a stale doc from surfacing a
      // hidden person on an unattended screen — so the two person-id lists are
      // resolved here, per request, and never read out of the stored document.
      const resolved = extractDatesFromQuery(toSearchQuery(doc.query, doc.library_id));
      const [dropIds, peopleIds] = await Promise.all([
        personIdsToDrop(resolved.excludeHiddenPeople),
        personIdsForNames(peopleNames(resolved.people)),
      ]);
      const where = buildSearchWhere(resolved, dropIds, peopleIds);
      if ('error' in where) {
        set.status = 400;
        return { error: where.error };
      }

      const limit = clampInt(query.limit, 1, 500, 100);
      // Paged rather than capped. A collection can hold more photos than any
      // one response should carry, and a client that could only ever see the
      // first page silently disagreed with the `result_count` on its own card.
      // `total` is already returned by both legs below, so a caller pages
      // until it has that many rows.
      const offset = clampInt(query.offset, 0, 100_000, 0);

      const meili = await meiliPage({
        where,
        resolved,
        libraryId: doc.library_id,
        skip: offset,
        limit,
      });
      if (meili !== null) {
        return { total: meili.total, results: meili.results };
      }

      // The database leg. The page and the total are composed from the same
      // `SearchWhere`, which is what stops a card claiming more photos than its
      // own grid can show.
      const [docs, total, libs, idToSlug] = await Promise.all([
        searchPage(where, { sort: 'captured_desc', limit, skip: offset }),
        searchCount(where),
        loadLibraryRoots().catch(() => new Map<string, string>()),
        loadLibraryIdToSlug().catch(() => new Map<string, string>()),
      ]);

      return {
        total,
        results: docs.map((d) => projectAsset(d as never, libs, idToSlug)),
      };
    },
    { query: t.Object({ limit: t.Optional(t.String()), offset: t.Optional(t.String()) }) },
  );

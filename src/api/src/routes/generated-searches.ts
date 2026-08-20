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
import { ObjectId } from 'mongodb';
import { getDb } from '../db/client.ts';
import {
  listGeneratedSearches,
  type GeneratedSearchDoc,
} from '../workers/generated-search/repo.ts';
import { toSearchQuery, resolveLiveFilter } from '../workers/generated-search/execute.ts';
import { assetsCollection } from '../db/client.ts';
import { loadLibraryRoots, loadLibraryIdToSlug } from '../indexer/libraries.cache.ts';
import { applyLiveFilter, clampInt } from './search/query.ts';
import { pickSort } from './search/sort.ts';
import { meiliPage } from './search/list-meili.ts';
import { projectAsset } from './search/project.ts';
import type { AssetDoc } from '../db/schema.ts';

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

      const db = await getDb();
      const doc = (await db
        .collection('generated_searches')
        .findOne({ _id: new ObjectId(params.id) })) as GeneratedSearchDoc | null;
      if (doc === null) {
        set.status = 404;
        return { error: 'not found' };
      }

      // Re-derive the live query on every request. Forcing at execution time
      // rather than at write time is what keeps a stale doc from surfacing a
      // hidden person on an unattended screen.
      const prepared = await resolveLiveFilter(toSearchQuery(doc.query, doc.library_id));
      if ('error' in prepared) {
        set.status = 400;
        return { error: prepared.error };
      }
      const { resolved, filter } = prepared;

      const limit = clampInt(query.limit, 1, 500, 100);
      const coll = await assetsCollection();

      const meili = await meiliPage({
        coll,
        filter,
        resolved,
        libraryId: doc.library_id,
        skip: 0,
        limit,
      });
      if (meili !== null) {
        return { total: meili.total, results: meili.results };
      }

      const liveFilter = applyLiveFilter(filter);
      const [libs, idToSlug, docs] = await Promise.all([
        loadLibraryRoots().catch(() => new Map<string, string>()),
        loadLibraryIdToSlug().catch(() => new Map<string, string>()),
        coll.find(liveFilter).sort(pickSort('captured_desc')).limit(limit).toArray(),
      ]);

      return {
        total: await coll.countDocuments(liveFilter),
        results: (docs as AssetDoc[]).map((d) => projectAsset(d as never, libs, idToSlug)),
      };
    },
    { query: t.Object({ limit: t.Optional(t.String()) }) },
  );

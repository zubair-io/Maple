/**
 * `GET /api/search` — paginated result list.
 *
 * When `placeQuery` is set and a Meilisearch sidecar is configured, we
 * query Meilisearch first (typo-tolerant, ranked) and re-fetch the full
 * asset rows from Mongo to preserve the source-of-truth projection. On
 * miss/error we fall back to the Mongo `$text` path so the route keeps
 * answering 200s even when Meilisearch is down.
 */

import { Elysia } from 'elysia';
import { ObjectId } from 'mongodb';
import type { Filter, Sort } from 'mongodb';
import { assetsCollection } from '../../db/client.ts';
import { loadLibraryRoots } from '../../indexer/libraries.cache.ts';
import { meilisearchClient } from '../../enrichment/meilisearch-client.ts';
import { child as childLogger } from '../../log.ts';
import type { AssetDoc } from '../../db/schema.ts';
import { projectAsset } from './project.ts';
import { applyLiveFilter, buildFilter, clampInt, SearchQueryT, type SearchQuery } from './query.ts';
import { pickSort, SORT_OPTIONS } from './sort.ts';

const searchLog = childLogger('search');

export const listRoute = new Elysia().get(
  '/',
  async ({ query, set }) => {
    const filterOrError = buildFilter(query as SearchQuery);
    if ('error' in filterOrError) {
      set.status = 400;
      return { error: filterOrError.error };
    }
    const filter = filterOrError;

    const page = clampInt(query.page, 0, Number.MAX_SAFE_INTEGER, 0);
    const limit = clampInt(query.limit, 1, 200, 100);
    const sort = query.sort && SORT_OPTIONS.has(query.sort) ? query.sort : 'captured_desc';
    const skip = page * limit;

    const coll = await assetsCollection();
    // Exclude soft-deleted rows from search results. We always wrap the
    // existing filter into a `$and` so a user-supplied `$or` (free-text
    // q + camera) doesn't shadow this constraint.
    const finalFilter = applyLiveFilter(filter);

    // When a placeQuery is set, sort by Mongo's textScore first so
    // closer matches lead the page; tie-break on captured_at desc, then
    // _id for pagination stability. Otherwise honour the caller's sort.
    const usingPlaceText =
      typeof query.placeQuery === 'string' && query.placeQuery.trim().length > 0;

    // Phase 7: try Meilisearch first when a placeQuery is present and
    // the sidecar is configured. On miss/error, fall back to the Mongo
    // `$text` path. The Mongo path is the source of truth — we only use
    // Meilisearch's hit ids and re-fetch the full asset rows from Mongo.
    const meili = meilisearchClient();
    if (usingPlaceText && meili.isConfigured()) {
      try {
        const placeQuery = query.placeQuery!.trim();
        const meiliResult = await meili.search(placeQuery, {
          folderId: query.libraryId,
          offset: skip,
          limit,
        });
        if (meiliResult.ids.length === 0) {
          return {
            total: meiliResult.estimatedTotal,
            page,
            limit,
            results: [],
          };
        }
        // Fetch full asset summaries for the Meilisearch ids. Strip
        // `$text` from the filter — Meilisearch already did the text
        // match, and re-running Mongo $text on a typo-tolerant hit
        // ("Musum" → "Museum") would zero the result. The structured
        // filters (camera, lens, ext, …) and the soft-delete clause
        // still apply.
        const filterWithoutText = { ...filter };
        delete (filterWithoutText as Record<string, unknown>).$text;
        const restrict = applyLiveFilter({
          ...filterWithoutText,
          maple_id: { $in: meiliResult.ids },
        } as unknown as Filter<AssetDoc>);
        const docs = await coll.find(restrict).toArray();
        const byId = new Map<string, AssetDoc & { _id: ObjectId }>();
        for (const d of docs) {
          const mapleId = (d as unknown as { maple_id?: string }).maple_id;
          if (typeof mapleId === 'string') {
            byId.set(mapleId, d as AssetDoc & { _id: ObjectId });
          }
        }
        // Preserve Meilisearch's relevance order. Drop ids that no
        // longer exist in Mongo (rare; e.g. mid-flight hard delete).
        const ordered: Array<AssetDoc & { _id: ObjectId }> = [];
        for (const id of meiliResult.ids) {
          const d = byId.get(id);
          if (d) ordered.push(d);
        }
        const libs = await loadLibraryRoots().catch(() => new Map<string, string>());
        const results = ordered.map((d) => projectAsset(d, libs));
        return {
          total: meiliResult.estimatedTotal,
          page,
          limit,
          results,
        };
      } catch (err) {
        // Log and fall through to the Mongo `$text` path. The route
        // still returns a 200 — the operator sees this in the logs.
        searchLog.warn(
          {
            err: err instanceof Error ? err.message : String(err),
            placeQuery: query.placeQuery,
          },
          'meilisearch query failed; falling back to mongo $text',
        );
      }
    }

    const sortSpec: Sort = usingPlaceText
      ? ({
          score: { $meta: 'textScore' },
          'exif.captured_at': -1,
          _id: 1,
        } as unknown as Sort)
      : pickSort(sort);
    const projection = usingPlaceText ? { score: { $meta: 'textScore' } } : undefined;

    const cursor = coll.find(finalFilter);
    if (projection) cursor.project(projection);
    const [docs, total] = await Promise.all([
      cursor.sort(sortSpec).skip(skip).limit(limit).toArray(),
      coll.countDocuments(finalFilter),
    ]);

    const libs = await loadLibraryRoots().catch(() => new Map<string, string>());
    const results = docs.map((d) => projectAsset(d as AssetDoc & { _id: ObjectId }, libs));
    return { total, page, limit, results };
  },
  { query: SearchQueryT },
);

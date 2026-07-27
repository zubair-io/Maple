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
import type { Collection, ObjectId } from 'mongodb';
import type { Filter, Sort } from 'mongodb';
import { assetsCollection } from '../../db/client.ts';
import { hiddenPersonIds } from '../../people/people.repo.ts';
import { loadLibraryRoots, loadLibraryIdToSlug } from '../../indexer/libraries.cache.ts';
import { meilisearchClient } from '../../enrichment/meilisearch-client.ts';
import { child as childLogger } from '../../log.ts';
import type { AssetDoc } from '../../db/schema.ts';
import { projectAsset } from './project.ts';
import {
  applyLiveFilter,
  buildFilter,
  clampInt,
  extractDatesFromQuery,
  SEARCH_SCOPES,
  SearchQueryT,
  type SearchQuery,
} from './query.ts';
import { pickSort, SORT_OPTIONS } from './sort.ts';

const searchLog = childLogger('search');

// ── Total-count cache (#2128) ─────────────────────────────────────────
// `countDocuments` runs the same non-indexable residual predicates as the
// main find (deleted_at / hidden / the fileinfo liveness $elemMatch) — even
// once the default-sort find is index-only, the count stays an O(N) scan.
// `total`'s only consumer is the `canLoadMore` infinite-scroll gate in the
// two search components (`search.component.ts:144` and `:175`), so brief
// staleness is not user-visible. Cached for 30 s keyed on the full filter
// set — mirrors the buckets cache in `buckets.ts` exactly (module-scoped
// `Map`, same TTL, same `_resetCacheForTests` shape).
const TOTAL_CACHE_TTL_MS = 30_000;
interface CachedTotal {
  total: number;
  expiresMs: number;
}
const totalCache = new Map<string, CachedTotal>();

/** Every field that feeds `buildFilter` (i.e. the full filter set the
 * count depends on), in a fixed order. `page`/`limit`/`sort` are
 * deliberately excluded because `countDocuments` doesn't depend on
 * pagination or ordering, and `people` is excluded because it only feeds
 * the Meilisearch path (never the Mongo filter this cache guards). */
const TOTAL_CACHE_KEY_FIELDS = [
  'pathPrefix',
  'libraryId',
  'q',
  'placeQuery',
  'camera',
  'lens',
  'isoMin',
  'isoMax',
  'apertureMin',
  'apertureMax',
  'focalMin',
  'focalMax',
  'from',
  'to',
  'rating',
  'flag',
  'color',
  'ext',
  'hasCapturedAt',
  'sceneType',
  'activity',
  'subjects',
  'isScreenshot',
  'scope',
  'hidden',
] as const satisfies ReadonlyArray<keyof SearchQuery>;

/** Stable JSON serialisation of a SearchQuery over `TOTAL_CACHE_KEY_FIELDS`.
 * Field order is fixed so that two requests with the same params produce
 * the same key regardless of how the URL was constructed. */
function makeTotalCacheKey(q: SearchQuery): string {
  const normalized: Partial<Record<keyof SearchQuery, string | null>> = {};
  for (const field of TOTAL_CACHE_KEY_FIELDS) {
    normalized[field] = q[field] ?? null;
  }
  return JSON.stringify(normalized);
}

/** Test-only: blow the cache so back-to-back tests don't see each other's
 * results. Safe in production too — just slower for 30 s. */
export function _resetCacheForTests(): void {
  totalCache.clear();
}

/**
 * `countDocuments`, hinting the narrow `fileinfo.library_id` index when
 * `canHint` is true (see the call site for why that's conditional on
 * `usingPlaceText`).
 *
 * Falls back to an unhinted count if the hint index doesn't exist —
 * Mongo raises `BadValue` (code 2) "hint provided does not correspond to
 * an existing index" in that case. That's not hypothetical: `ensureIndexes`
 * (`db/client.ts`) runs in the background at boot, and the index-creation
 * step this hint targets is itself gated on a migration that can be
 * pending on an older/partially-migrated database (see the
 * `drop-abs-path-2026-05-21` guard). A missing hint index must degrade to
 * the planner's own (slower) choice, not 500 the whole search route.
 */
async function countTotal(
  coll: Collection<AssetDoc>,
  filter: Filter<AssetDoc>,
  canHint: boolean,
): Promise<number> {
  if (!canHint) return coll.countDocuments(filter);
  try {
    return await coll.countDocuments(filter, { hint: { 'fileinfo.library_id': 1 } });
  } catch (err) {
    if (err instanceof Error && (err as { code?: number }).code === 2) {
      return coll.countDocuments(filter);
    }
    throw err;
  }
}

/**
 * Resolve `total` for this request: serve it from `totalCache` if a fresh
 * entry exists for this exact filter set, otherwise compute it via
 * `countTotal` and cache the result before returning.
 *
 * `$text` queries require the planner to use the text index — combining
 * `$text` with an explicit `hint` throws "text and hint not allowed in
 * same query", so `canHint` must be false whenever the filter carries
 * `$text` (i.e. `usingPlaceText` at the call site). Otherwise, hint the
 * narrower `fileinfo.library_id` index: adding the new
 * lib+captured+_id compound index in `db/client.ts` (needed to fix the
 * find) gives the planner a wider, slower index it will otherwise pick
 * for this count. Measured on the 333k-asset production library:
 * unhinted 3379ms vs hinted 2513ms (~1.34x). An earlier ~2.5x figure in
 * the #2128 commit message came from 723-byte synthetic documents; the
 * ratio compresses at production's ~6KB avgObjSize, because both plans
 * are dominated by the same FETCH volume.
 *
 * Both remain O(N): `hidden`/`deleted_at`/the `fileinfo` `$elemMatch`
 * appear in no index, so every candidate must be fetched and neither
 * index can make this an index-only COUNT_SCAN (the multikey
 * `fileinfo.library_id` path would force a FETCH to dedupe
 * array-generated entries regardless). The 30s cache bounds how often
 * that ~2.5s scan is paid, it does not remove it — see #2129.
 */
async function getCachedTotal(
  coll: Collection<AssetDoc>,
  query: SearchQuery,
  finalFilter: Filter<AssetDoc>,
  canHint: boolean,
): Promise<number> {
  const cacheKey = makeTotalCacheKey(query);
  const nowMs = Date.now();
  const cached = totalCache.get(cacheKey);
  if (cached && cached.expiresMs > nowMs) return cached.total;

  const total = await countTotal(coll, finalFilter, canHint);
  // Bound the cache so a parameterised attack can't grow it unboundedly.
  // 500 unique filter sets is generous for a single server; eviction is
  // FIFO via insertion order.
  if (totalCache.size >= 500) {
    const oldest = totalCache.keys().next().value;
    if (oldest !== undefined) totalCache.delete(oldest);
  }
  totalCache.set(cacheKey, { total, expiresMs: nowMs + TOTAL_CACHE_TTL_MS });
  return total;
}

export const listRoute = new Elysia().get(
  '/',
  async ({ query, set }) => {
    // Natural-language dates: resolve "May 5" / "2023" / "last summer" out
    // of placeQuery into structured from/to, and strip the matched span so
    // the residual free-text drives the text/Meili path. Pure-date queries
    // ("2023") leave an empty residual and skip the text path entirely.
    const resolved = extractDatesFromQuery(query as SearchQuery);
    // Only pay for the hidden-people lookup when the caller asked to exclude
    // them (opt-in — see `SearchQuery.excludeHiddenPeople`).
    const hiddenIds = resolved.excludeHiddenPeople === 'true' ? await hiddenPersonIds() : [];
    const filterOrError = buildFilter(resolved, hiddenIds);
    if ('error' in filterOrError) {
      set.status = 400;
      return { error: filterOrError.error };
    }
    const filter = filterOrError;

    // 10_000 mirrors `limit`'s ceiling below in spirit — a sane cap rather
    // than `Number.MAX_SAFE_INTEGER`, which let `skip = page * limit`
    // (below) blow up into a value Mongo has to reject/choke on for a
    // trivially-crafted request (#2359).
    const page = clampInt(query.page, 0, 10_000, 0);
    const limit = clampInt(query.limit, 1, 500, 100);

    // S7 scope chip: `albums` has no backing field today (PhotoKit
    // assetCollection ids are not stored on AssetDoc). Short-circuit
    // BEFORE the Mongo round-trip so an empty result is cheap, and stamp
    // `notImplemented: true` so the client can surface "Coming soon"
    // instead of an empty grid. `buildFilter` already validated the
    // enum, so we know `query.scope === 'albums'` is the only path here.
    if (
      typeof query.scope === 'string' &&
      query.scope !== '' &&
      SEARCH_SCOPES.has(query.scope) &&
      query.scope === 'albums'
    ) {
      return {
        total: 0,
        page,
        limit,
        results: [],
        notImplemented: true as const,
      };
    }
    const sort = query.sort && SORT_OPTIONS.has(query.sort) ? query.sort : 'captured_desc';
    const skip = page * limit;

    const coll = await assetsCollection();
    // Exclude soft-deleted rows from search results. We always wrap the
    // existing filter into a `$and` so a user-supplied `$or` (free-text
    // q + camera) doesn't shadow this constraint.
    const finalFilter = applyLiveFilter(filter);

    // When a residual placeQuery is set, sort by Mongo's textScore first
    // so closer matches lead the page; tie-break on captured_at desc, then
    // _id for pagination stability. Otherwise honour the caller's sort. A
    // pure-date query ("2023") has an empty residual placeQuery here, so it
    // bypasses both the Meili path and the Mongo `$text` path and runs as a
    // plain structured filter on `exif.captured_at`.
    const usingPlaceText =
      typeof resolved.placeQuery === 'string' && resolved.placeQuery.trim().length > 0;

    // Explicit person-name picker — comma-separated names folded into the
    // Meili `people` filter. The Mongo `$text` fallback already covers
    // names via search_blob.
    const peopleNames =
      typeof resolved.people === 'string' && resolved.people.trim().length > 0
        ? resolved.people
            .split(',')
            .map((p) => p.trim())
            .filter((p) => p.length > 0)
        : undefined;

    // Phase 7: try Meilisearch first when a placeQuery is present and
    // the sidecar is configured. On miss/error, fall back to the Mongo
    // `$text` path. The Mongo path is the source of truth — we only use
    // Meilisearch's hit ids and re-fetch the full asset rows from Mongo.
    const meili = meilisearchClient();
    if (usingPlaceText && meili.isConfigured()) {
      try {
        const placeQuery = resolved.placeQuery!.trim();
        // Thread the caller's hidden mode into the Meili candidate set.
        // Meili defaults to excluding hidden docs, so without this the Mongo
        // `hidden: true` intersection for `only` runs against an already
        // hidden-free id set and always comes back empty (#2358). `only` is
        // pushed all the way into the Meili filter (`hidden = true`) so each
        // candidate page stays dense with rows the re-fetch will keep.
        const includeHidden = resolved.hidden === 'all';
        const onlyHidden = resolved.hidden === 'only';
        const meiliResult = await meili.search(placeQuery, {
          folderId: query.libraryId,
          people: peopleNames,
          semantic: meili.semanticConfigured(),
          includeHidden,
          onlyHidden,
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
        const [libs, idToSlug] = await Promise.all([
          loadLibraryRoots().catch(() => new Map<string, string>()),
          loadLibraryIdToSlug().catch(() => new Map<string, string>()),
        ]);
        const results = ordered.map((d) => projectAsset(d, libs, idToSlug));
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
            placeQuery: resolved.placeQuery,
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

    // `total` is cached — see `getCachedTotal` and the module-level
    // comment. Keyed on the raw query (not `resolved`), matching
    // `buckets.ts`: repeated infinite-scroll requests from the FE resend
    // identical query params. Runs concurrently with the find below (the
    // cache-miss path still calls `countDocuments` in parallel with it).
    const totalPromise = getCachedTotal(coll, query as SearchQuery, finalFilter, !usingPlaceText);

    const [docs, total] = await Promise.all([
      cursor.sort(sortSpec).skip(skip).limit(limit).toArray(),
      totalPromise,
    ]);

    const [libs, idToSlug] = await Promise.all([
      loadLibraryRoots().catch(() => new Map<string, string>()),
      loadLibraryIdToSlug().catch(() => new Map<string, string>()),
    ]);
    const results = docs.map((d) =>
      projectAsset(d as AssetDoc & { _id: ObjectId }, libs, idToSlug),
    );
    return { total, page, limit, results };
  },
  { query: SearchQueryT },
);

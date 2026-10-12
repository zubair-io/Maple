/**
 * `GET /api/search/buckets` — year/month histogram for the Timeline view.
 *
 * The two aggregations behind it live in `db/repos/search.buckets.ts`:
 * the dated rows group a partial index whose keys are the group keys, and the
 * undated ones are a count over the live index. Splitting them is what lets
 * each use its own index, and they run concurrently on separate readers.
 *
 * Responses are cached for 30 s keyed on the full filter set. Buckets
 * only change when assets are written; a tight TTL keeps repeat loads
 * cheap and surfaces newly-indexed photos within a minute.
 */

import { Elysia } from 'elysia';
import { buildSearchWhere, searchBuckets, windowBuckets } from '../../db/repos/search.repo.ts';
import { firstEngine, requestWindow, windowNeed } from './ranked-window.ts';
import { windowDepthFor } from '../../db/repos/search.ranked.ts';
import { extractDatesFromQuery, SearchQueryT, type SearchQuery } from './query.ts';
import { resolveRankedScope, resolveSearchScope } from './scope.ts';
import { canonicalOwner } from './total-cache.ts';

// ── Buckets response cache ────────────────────────────────────────────
// Module-scoped because the cache lives for the process lifetime. Keys
// are the full filter set; values are the aggregation result + an
// absolute expiry. 30 s is short enough that newly-indexed assets show
// up "soon" without explicit invalidation, long enough that a user
// flicking between scopes hits warm cache.
const BUCKETS_CACHE_TTL_MS = 30_000;
interface CachedBuckets {
  result: {
    total: number;
    buckets: Array<{ year: number; month: number; count: number }>;
    untimed_count: number;
  };
  expiresMs: number;
}
const bucketsCache = new Map<string, CachedBuckets>();

/** Fields whose value participates in the buckets cache key, in the
 * order they're serialised. Must include every `SearchQuery` field that
 * `buildSearchWhere` consumes — anything left out lets two requests that
 * differ only in that field collide on the same cache entry within the
 * 30s TTL and serve each other's histogram.
 * `page`/`limit`/`sort` are deliberately excluded: the filter builder
 * never reads them, so they can't change the aggregation result.
 * Referenced by the completeness test in `buckets.test.ts`, which
 * enumerates this list against `SearchQuery`.
 */
const BUCKETS_CACHE_KEY_FIELDS = [
  'pathPrefix',
  'people',
  'place',
  'libraryId',
  'excludeHiddenPeople',
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
  'month',
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
  'ownerId',
  'owner_id',
  'owner',
] as const satisfies readonly (keyof SearchQuery)[];

/** Stable JSON serialisation of a SearchQuery. Field order is fixed
 * (see `BUCKETS_CACHE_KEY_FIELDS`) so that two requests with the same
 * params produce the same key regardless of how the URL was
 * constructed. Exported so the completeness test in `buckets.test.ts`
 * can enumerate the field list against `SearchQuery`.
 */
/** The scope chip only narrows on `places`/`people` — `photos`, `albums`,
 * `''`, and absent all produce the identical (unfiltered) aggregation, so
 * they must share one key. Keying the raw value would fragment the cache. */
const canonicalScope = (v: SearchQuery['scope']): string | null =>
  v === 'places' || v === 'people' ? v : null;

/** The filter builder treats anything other than `only`/`all` as the
 * default (exclude hidden). Folding unknown values to `null` also stops
 * arbitrary `hidden=...` strings minting unlimited fresh keys and churning
 * the 500-entry cache. */
const canonicalHidden = (v: SearchQuery['hidden']): string | null =>
  v === 'only' || v === 'all' ? v : null;

export function makeBucketsCacheKey(q: SearchQuery): string {
  const normalized = Object.fromEntries(
    BUCKETS_CACHE_KEY_FIELDS.map((field) => [
      field,
      field === 'scope'
        ? canonicalScope(q.scope)
        : field === 'hidden'
          ? canonicalHidden(q.hidden)
          : field === 'owner' || field === 'ownerId' || field === 'owner_id'
            ? canonicalOwner(q)
            : (q[field] ?? null),
    ]),
  );
  return JSON.stringify(normalized);
}

/** Test-only: blow the cache so back-to-back tests don't see each
 * other's results. Safe in production too — just slower for 30 s. */
export function _resetBucketsCacheForTests(): void {
  bucketsCache.clear();
}

/**
 * The histogram, and whether to cache it. A text search's is its request's ranked window's — the
 * window `requestWindow` serves the list with the same `page` and `limit` (#4514) — and is cached
 * only when the request's first engine answered.
 */
async function histogram(
  query: SearchQuery,
  need: number,
): Promise<Response | { result: Awaited<ReturnType<typeof searchBuckets>>; keep: boolean }> {
  const where = await resolveSearchScope(query);
  if (where instanceof Response) return where;
  if (where.match.kind !== 'match') return { result: await searchBuckets(where), keep: true };
  const scope = await resolveRankedScope(query);
  if ('error' in scope) return Response.json({ error: scope.error }, { status: 400 });
  if (scope.childQuery === null) return { result: await searchBuckets(scope.where), keep: true };
  const window = await requestWindow({
    where: scope.where,
    text: scope.childQuery,
    need,
  });
  return { result: await windowBuckets(window.rows), keep: window.preferred };
}

export const bucketsRoute = new Elysia().get(
  '/buckets',
  async ({ query, set }) => {
    // Opt-in hidden-people exclusion (see `SearchQuery.excludeHiddenPeople`).
    // Folded into the cache key below, so buckets computed with and without
    // it never share an entry. Skips the lookup when not requested.
    // Validate up front. `buildSearchWhere` is pure and does no I/O, so
    // running it before the cache lookup keeps an invalid `scope` returning
    // 400 rather than being answered from a cache entry.
    const validation = buildSearchWhere(query as SearchQuery);
    if ('error' in validation) {
      set.status = 400;
      return { error: validation.error };
    }

    // Cache lookup. Buckets only change when assets are written —
    // a 30s TTL keeps repeat loads from the same client cheap and is
    // tight enough that newly-indexed photos surface within a minute.
    const need = windowNeed(query as SearchQuery);
    const engine = firstEngine();
    const cacheKey = `${makeBucketsCacheKey(query as SearchQuery)}#${windowDepthFor(need)}#${engine}`;
    const cached = bucketsCache.get(cacheKey);
    const nowMs = Date.now();
    if (cached && cached.expiresMs > nowMs) {
      return cached.result;
    }

    // Cache MISS only: the person-id lookups this resolves are the route's
    // extra round trips, so they stay behind the fast path. A fresh exclusion
    // can lag buckets by up to the 30s cache TTL, same as any asset write.
    const computed = await histogram(query as SearchQuery, need);
    if (computed instanceof Response) return computed;
    const { result, keep } = computed;
    if (!keep) return result;
    // Bound the cache so a parameterised attack can't grow it
    // unboundedly. 500 unique filter sets is generous for a single
    // server; eviction is FIFO via insertion order.
    if (bucketsCache.size >= 500) {
      const oldest = bucketsCache.keys().next().value;
      if (oldest !== undefined) bucketsCache.delete(oldest);
    }
    bucketsCache.set(cacheKey, {
      result,
      expiresMs: nowMs + BUCKETS_CACHE_TTL_MS,
    });
    return result;
  },
  { query: SearchQueryT },
);

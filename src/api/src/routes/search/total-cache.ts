/**
 * Total-count cache for `GET /api/search` (#2128).
 *
 * `countDocuments` runs the same non-indexable residual predicates as the
 * main find (deleted_at / hidden / the fileinfo liveness $elemMatch) — even
 * once the default-sort find is index-only, the count stays an O(N) scan.
 * `total`'s only consumer is the `canLoadMore` infinite-scroll gate in the
 * two search components (`search.component.ts:144` and `:175`), so brief
 * staleness is not user-visible. Cached for 30 s keyed on the full filter
 * set — mirrors the buckets cache in `buckets.ts` exactly (module-scoped
 * `Map`, same TTL, same `_resetCacheForTests` shape).
 *
 * Extracted from `list.ts` in #2129 to keep that route file inside the
 * file-size budget once seek pagination landed; the behaviour is unchanged.
 */

import type { Collection, Filter } from 'mongodb';
import type { AssetDoc } from '../../db/schema.ts';
import type { SearchQuery } from './query.ts';

const TOTAL_CACHE_TTL_MS = 30_000;

interface CachedTotal {
  total: number;
  expiresMs: number;
}

const totalCache = new Map<string, CachedTotal>();

/** Every field that feeds `buildFilter` (i.e. the full filter set the
 * count depends on), in a fixed order. `page`/`limit`/`sort`/`cursor` are
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
 * that ~2.5s scan is paid, it does not remove it.
 *
 * Note the filter passed here is the *unpaged* one — the seek predicate
 * from `cursor.ts` must never reach the count, or `total` would shrink as
 * the user scrolls.
 */
export async function getCachedTotal(
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

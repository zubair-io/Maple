/**
 * `GET /api/search/buckets` — year/month histogram for the Timeline view.
 *
 * Two parallel aggregations instead of one $facet pipeline: each branch
 * can use its own optimal index, and Mongo schedules them independently.
 * The timed branch uses pre-computed numeric `exif.captured_year`/`month`
 * (set by the indexer + backfilled at startup) so `$group` is index-only —
 * no `$dateFromString` per doc.
 *
 * Responses are cached for 30 s keyed on the full filter set. Buckets
 * only change when assets are written; a tight TTL keeps repeat loads
 * cheap and surfaces newly-indexed photos within a minute.
 */

import { Elysia } from 'elysia';
import { assetsCollection } from '../../db/client.ts';
import { hiddenPersonIds } from '../../people/people.repo.ts';
import { applyLiveFilter, buildFilter, SearchQueryT, type SearchQuery } from './query.ts';

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

/** Stable JSON serialisation of a SearchQuery. Field order is fixed so
 * that two requests with the same params produce the same key
 * regardless of how the URL was constructed. */
function makeBucketsCacheKey(q: SearchQuery): string {
  return JSON.stringify({
    pathPrefix: q.pathPrefix ?? null,
    libraryId: q.libraryId ?? null,
    excludeHiddenPeople: q.excludeHiddenPeople ?? null,
    q: q.q ?? null,
    placeQuery: q.placeQuery ?? null,
    camera: q.camera ?? null,
    lens: q.lens ?? null,
    isoMin: q.isoMin ?? null,
    isoMax: q.isoMax ?? null,
    apertureMin: q.apertureMin ?? null,
    apertureMax: q.apertureMax ?? null,
    focalMin: q.focalMin ?? null,
    focalMax: q.focalMax ?? null,
    from: q.from ?? null,
    to: q.to ?? null,
    rating: q.rating ?? null,
    flag: q.flag ?? null,
    color: q.color ?? null,
    ext: q.ext ?? null,
    hasCapturedAt: q.hasCapturedAt ?? null,
    sceneType: q.sceneType ?? null,
    activity: q.activity ?? null,
    subjects: q.subjects ?? null,
    isScreenshot: q.isScreenshot ?? null,
  });
}

/** Test-only: blow the cache so back-to-back tests don't see each
 * other's results. Safe in production too — just slower for 30 s. */
export function _resetBucketsCacheForTests(): void {
  bucketsCache.clear();
}

export const bucketsRoute = new Elysia().get(
  '/buckets',
  async ({ query, set }) => {
    // Opt-in hidden-people exclusion (see `SearchQuery.excludeHiddenPeople`).
    // Folded into the cache key below, so buckets computed with and without
    // it never share an entry. Skips the lookup when not requested.
    const hiddenIds =
      (query as SearchQuery).excludeHiddenPeople === 'true' ? await hiddenPersonIds() : [];
    const filterOrError = buildFilter(query as SearchQuery, hiddenIds);
    if ('error' in filterOrError) {
      set.status = 400;
      return { error: filterOrError.error };
    }

    // Cache lookup. Buckets only change when assets are written —
    // a 30s TTL keeps repeat loads from the same client cheap and is
    // tight enough that newly-indexed photos surface within a minute.
    const cacheKey = makeBucketsCacheKey(query as SearchQuery);
    const cached = bucketsCache.get(cacheKey);
    const nowMs = Date.now();
    if (cached && cached.expiresMs > nowMs) {
      return cached.result;
    }

    const filter = filterOrError;
    const coll = await assetsCollection();
    const finalFilter = applyLiveFilter(filter);

    // Two parallel aggregations instead of one $facet pipeline: each
    // branch can use its own optimal index, and Mongo schedules them
    // independently. The timed branch uses pre-computed numeric
    // exif.captured_year/month (set by the indexer + backfilled at
    // startup) so $group is index-only — no $dateFromString per doc.
    const timedFilter = {
      ...finalFilter,
      'exif.captured_year': { $ne: null },
    } as typeof finalFilter;
    // Wrap the untimed predicate with `$and` instead of spreading: when
    // `applyLiveFilter` returned a top-level `$or` (empty query case —
    // the soft-delete clause is `{ $or: [{ deleted_at: null }, ...] }`),
    // a naive spread + `$or` override would silently drop the live-row
    // constraint and let soft-deleted untimed rows leak into the count.
    // `$and` keeps both predicates restrictive.
    const untimedFilter = {
      $and: [
        finalFilter,
        {
          $or: [{ 'exif.captured_at': null }, { 'exif.captured_at': { $exists: false } }],
        },
      ],
    } as unknown as typeof finalFilter;

    const [timed, untimed_count] = await Promise.all([
      coll
        .aggregate<{
          _id: { year: number; month: number };
          count: number;
        }>([
          { $match: timedFilter },
          {
            $group: {
              _id: {
                year: '$exif.captured_year',
                month: '$exif.captured_month',
              },
              count: { $sum: 1 },
            },
          },
          { $sort: { '_id.year': -1, '_id.month': -1 } },
        ])
        .toArray(),
      coll.countDocuments(untimedFilter),
    ]);

    const buckets = timed.map((t) => ({
      year: t._id.year,
      month: t._id.month,
      count: t.count,
    }));
    const total = buckets.reduce((acc, b) => acc + b.count, 0);

    const result = { total, buckets, untimed_count };
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

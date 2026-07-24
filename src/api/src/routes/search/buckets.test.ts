/**
 * Pure unit tests for `makeBucketsCacheKey` (#2131). No Mongo — the cache
 * key is built directly from a `SearchQuery` object with no I/O, so these
 * assert on the serialised key string.
 *
 * Root cause: the key was an explicit field list that omitted `scope`
 * even though `buildFilter` (query.ts) applies a scope filter (`places`
 * → `exif.gps != null`, `people` → `faces.0 exists`). Two requests
 * differing only by `scope` shared a cache entry within the 30s TTL, so
 * flicking between Timeline scope chips served one scope's histogram
 * under another's chip. `hidden` had the same bug — it also shapes
 * `buildFilter`'s output (line ~452 of query.ts) and was also missing
 * from the key.
 */

import { describe, it, expect } from 'bun:test';
import { makeBucketsCacheKey } from './buckets.ts';
import type { SearchQuery } from './query.ts';

describe('makeBucketsCacheKey — scope isolation (#2131)', () => {
  it('produces different keys only for scopes that actually narrow the filter', () => {
    const base: SearchQuery = { pathPrefix: 'Trips' };
    const photos = makeBucketsCacheKey({ ...base, scope: 'photos' });
    const places = makeBucketsCacheKey({ ...base, scope: 'places' });
    const people = makeBucketsCacheKey({ ...base, scope: 'people' });
    const absent = makeBucketsCacheKey({ ...base });

    // `photos` is `buildFilter`'s no-op default — it must share the absent
    // key rather than fragment the cache into two identical entries.
    expect(photos).toBe(absent);
    expect(new Set([places, people, absent]).size).toBe(3);
  });

  it('produces different keys for requests differing only in hidden', () => {
    const base: SearchQuery = { pathPrefix: 'Trips' };
    const only = makeBucketsCacheKey({ ...base, hidden: 'only' });
    const all = makeBucketsCacheKey({ ...base, hidden: 'all' });
    const absent = makeBucketsCacheKey({ ...base });

    expect(new Set([only, all, absent]).size).toBe(3);
  });

  it('folds unrecognised hidden values into the default key (no cache churn)', () => {
    const base: SearchQuery = { pathPrefix: 'Trips' };
    const absent = makeBucketsCacheKey({ ...base });

    // `buildFilter` treats anything but only/all as the default filter, so
    // arbitrary wire values must not mint fresh cache keys (an attacker or
    // buggy client could otherwise evict useful entries at will).
    expect(makeBucketsCacheKey({ ...base, hidden: 'garbage' })).toBe(absent);
  });
});

/**
 * Completeness guard: every `SearchQuery` field that `buildFilter` reads
 * to shape the Mongo filter MUST appear in the buckets cache key, or two
 * requests differing only in that field will share a cache entry within
 * the 30s TTL and one will serve the other's histogram — exactly the
 * #2131 bug, generalised. `FILTER_AFFECTING_FIELD_VALUES` lists every
 * such field with two distinct values; the parametrised test below
 * builds two queries per field, differing only in that field, and
 * asserts the keys (and the "field absent" key) are all distinct.
 *
 * `NON_FILTER_FIELDS` lists the `SearchQuery` fields `buildFilter` never
 * reads: `page`/`limit`/`sort` (pagination/ordering only — the buckets
 * aggregation ignores them) and `people` (wired to the Meilisearch
 * `people` filterable attribute, not the Mongo filter — see its doc
 * comment in `query.ts`).
 *
 * `ALL_SEARCH_QUERY_FIELDS` is a `Record<keyof SearchQuery, true>` — if a
 * field is added to or removed from the `SearchQuery` interface without
 * updating one of the two lists below, this object literal fails to
 * typecheck (excess or missing key). `bun test` doesn't typecheck by
 * itself, but `tsc` (run in CI / via `bun run` typecheck) will catch the
 * drift; the runtime assertion in the first `it` below is a
 * belt-and-braces check for the same invariant that works even without a
 * typecheck pass.
 */
const FILTER_AFFECTING_FIELD_VALUES: Record<string, [string, string]> = {
  q: ['foo', 'bar'],
  placeQuery: ['Paris', 'Rome'],
  libraryId: ['507f1f77bcf86cd799439011', '507f1f77bcf86cd799439012'],
  camera: ['Canon', 'Nikon'],
  lens: ['50mm', '85mm'],
  isoMin: ['100', '200'],
  isoMax: ['400', '800'],
  apertureMin: ['1.4', '2.8'],
  apertureMax: ['5.6', '8'],
  focalMin: ['24', '35'],
  focalMax: ['70', '135'],
  from: ['2024-01-01', '2024-02-01'],
  to: ['2024-06-01', '2024-07-01'],
  rating: ['3', '4'],
  flag: ['pick', 'reject'],
  color: ['red', 'blue'],
  ext: ['jpg', 'dng'],
  pathPrefix: ['A', 'B'],
  hasCapturedAt: ['true', 'false'],
  sceneType: ['indoor', 'outdoor'],
  activity: ['hiking', 'skiing'],
  subjects: ['dog', 'cat'],
  isScreenshot: ['true', 'false'],
  hidden: ['only', 'all'],
  scope: ['places', 'people'],
  excludeHiddenPeople: ['true', 'false'],
};

const NON_FILTER_FIELDS = new Set(['people', 'page', 'limit', 'sort']);

const ALL_SEARCH_QUERY_FIELDS: Record<keyof SearchQuery, true> = {
  q: true,
  placeQuery: true,
  libraryId: true,
  camera: true,
  lens: true,
  isoMin: true,
  isoMax: true,
  apertureMin: true,
  apertureMax: true,
  focalMin: true,
  focalMax: true,
  from: true,
  to: true,
  rating: true,
  flag: true,
  color: true,
  ext: true,
  pathPrefix: true,
  hasCapturedAt: true,
  sceneType: true,
  activity: true,
  subjects: true,
  isScreenshot: true,
  people: true,
  scope: true,
  hidden: true,
  excludeHiddenPeople: true,
  page: true,
  limit: true,
  sort: true,
};

describe('makeBucketsCacheKey — completeness vs SearchQuery', () => {
  it('accounts for every SearchQuery field in exactly one bucket, with no overlap', () => {
    const declaredFilterFields = Object.keys(FILTER_AFFECTING_FIELD_VALUES);
    const overlap = declaredFilterFields.filter((f) => NON_FILTER_FIELDS.has(f));
    expect(overlap).toEqual([]);

    const accounted = new Set([...declaredFilterFields, ...NON_FILTER_FIELDS]);
    expect(accounted).toEqual(new Set(Object.keys(ALL_SEARCH_QUERY_FIELDS)));
  });

  for (const [field, [a, b]] of Object.entries(FILTER_AFFECTING_FIELD_VALUES)) {
    it(`includes "${field}" in the cache key`, () => {
      const keyA = makeBucketsCacheKey({ [field]: a } as SearchQuery);
      const keyB = makeBucketsCacheKey({ [field]: b } as SearchQuery);
      const keyAbsent = makeBucketsCacheKey({} as SearchQuery);
      expect(new Set([keyA, keyB, keyAbsent]).size).toBe(3);
    });
  }
});

/**
 * #2932 — the Meilisearch branch of `GET /api/search` asks Meili for one
 * page of `limit` relevance-ranked ids and then lets the re-fetch apply the
 * caller's structured filters to THAT PAGE. A filter Meilisearch never saw
 * can only remove rows from those ids; it can never reach a match ranked
 * past them. The result is an empty grid under a `total` taken from
 * `estimatedTotalHits`, which counts documents the filter would have excluded.
 *
 * #2929 fixed the capture-date window by pushing it down. This closes the
 * class:
 *
 *   1. The vision fields and `isScreenshot` are already in the index's
 *      `filterableAttributes`, so they are pushed down too — no migration.
 *   2. Every remaining filter has no Meilisearch counterpart. Rather than
 *      post-filter a page and report a count the grid cannot produce, the
 *      branch declines and the route falls through to the database's own
 *      full-text path, which applies all filters in one query and counts
 *      correctly.
 *
 * (2) trades relevance ranking for correctness on those queries. That is the
 * right way round: today they return the wrong answer confidently.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import { listRoute } from './list.ts';
import { unpushableFilters } from './list-meili.ts';
import { _resetCacheForTests } from './total-cache.ts';
import { SearchQueryT } from './query-schema.ts';
import {
  setMeilisearchClientForTests,
  type MeilisearchClient,
  type MeilisearchSearchOptions,
} from '../../enrichment/meilisearch-client.ts';
import { seedSearchAsset } from '../../db/sqlite/repos/search.test-helpers.ts';
import {
  createLiveTestDatabase,
  insertFolder,
  type LiveTestDatabase,
} from '../../db/sqlite/test-sqlite.test-helpers.ts';

let live: LiveTestDatabase;

const MATCH_ID = 'maple-match';

beforeEach(async () => {
  live = await createLiveTestDatabase();
  const libraryId = insertFolder(live.db, { slug: 'pushdown', path: '/lib' });
  seedSearchAsset(live.db, libraryId, {
    filename: 'match.dng',
    mapleId: MATCH_ID,
    rating: 5,
    capturedAt: '2025-07-15T12:00:00.000Z',
    searchBlob: 'greyson beach',
  });
  _resetCacheForTests();
});

afterEach(() => {
  setMeilisearchClientForTests(null);
  live.close();
  _resetCacheForTests();
});

/** Returns a page that deliberately does NOT contain the seeded match, so a
 * test only passes if the route declined Meili and used the database. */
function fakeMeiliClient(): { client: MeilisearchClient; calls: MeilisearchSearchOptions[] } {
  const calls: MeilisearchSearchOptions[] = [];
  const client: MeilisearchClient = {
    isConfigured: () => true,
    semanticConfigured: () => false,
    health: async () => true,
    ensureIndex: async () => {},
    upsert: async () => {},
    upsertOrThrow: async () => {},
    tombstone: async () => {},
    search: async (_q, opts = {}) => {
      calls.push(opts);
      return { ids: ['maple-some-other-doc'], estimatedTotal: 9331 };
    },
  };
  return { client, calls };
}

describe('unpushableFilters — which filters force the database path', () => {
  it('treats a query with only pushed-down filters as Meili-expressible', () => {
    expect(
      unpushableFilters({
        placeQuery: 'greyson',
        people: 'Greyson',
        from: '2025-06-01',
        to: '2025-08-31',
        sceneType: 'outdoor',
        activity: 'skiing',
        subjects: 'dog,beach',
        isScreenshot: 'false',
        hidden: 'all',
        libraryId: 'abc',
      }),
    ).toEqual([]);
  });

  it('does not treat paging, sorting or scope=photos as filters', () => {
    expect(
      unpushableFilters({
        placeQuery: 'x',
        page: '2',
        limit: '50',
        sort: 'captured_desc',
        scope: 'photos',
      }),
    ).toEqual([]);
  });

  it.each([
    ['place', { place: 'Kyoto, Japan' }],
    ['month', { month: '8' }],
    ['rating', { rating: '4' }],
    ['camera', { camera: 'Hasselblad' }],
    ['lens', { lens: '24mm' }],
    ['ext', { ext: 'dng' }],
    ['flag', { flag: 'pick' }],
    ['color', { color: 'red' }],
    ['pathPrefix', { pathPrefix: '/A/B' }],
    ['isoMin', { isoMin: '100' }],
    ['apertureMax', { apertureMax: '2.8' }],
    ['focalMin', { focalMin: '50' }],
    ['hasCapturedAt', { hasCapturedAt: 'true' }],
    ['q', { q: 'DJI' }],
    ['scope', { scope: 'people' }],
    ['excludeHiddenPeople', { excludeHiddenPeople: 'true' }],
  ])('reports %s as unpushable', (key, extra) => {
    expect(unpushableFilters({ placeQuery: 'greyson', ...extra })).toContain(key);
  });

  /**
   * The filter builder adds a clause for these only on the exact string
   * 'true'. Treating any non-empty value as active would push
   * `hasCapturedAt=false` onto the database path for a filter that never
   * existed, losing relevance ranking for nothing.
   */
  it.each([
    ['hasCapturedAt', { hasCapturedAt: 'false' }],
    ['excludeHiddenPeople', { excludeHiddenPeople: 'false' }],
  ])('does not treat %s=false as an active filter', (_key, extra) => {
    expect(unpushableFilters({ placeQuery: 'greyson', ...extra })).toEqual([]);
  });

  /**
   * The guard is only as good as its coverage. A param added to the wire
   * contract without being classified would silently fall back into
   * post-filtering a page — the exact bug this closes. Failing here is the
   * signal to classify the new param, not to widen the allowlist blindly.
   */
  it('classifies every param in the wire schema', () => {
    const declared = Object.keys(SearchQueryT.properties);
    const unclassified = declared.filter((key) => {
      // Probed with 'true': the boolean opt-in params (`hasCapturedAt`,
      // `excludeHiddenPeople`) only add a clause on that exact value,
      // so any other probe would look inert and hide a real classification.
      const asFilter = unpushableFilters({ placeQuery: 'x', [key]: 'true' });
      const asEmpty = unpushableFilters({ placeQuery: 'x' });
      // Either the param forces a fallback, or it is knowingly inert here.
      return asFilter.length === asEmpty.length && !KNOWN_MEILI_SAFE.has(key);
    });
    expect(unclassified).toEqual([]);
  });
});

/** Params that legitimately do NOT force the database path: pushed down
 * into the Meili query, or not filters at all. */
const KNOWN_MEILI_SAFE = new Set([
  'placeQuery',
  'libraryId',
  'people',
  'from',
  'to',
  'sceneType',
  'activity',
  'subjects',
  'isScreenshot',
  'hidden',
  'page',
  'limit',
  'sort',
  'cursor',
]);

describe('GET /api/search — pushdown and fallback', () => {
  it('pushes the vision and screenshot filters into the Meili query', async () => {
    const { client, calls } = fakeMeiliClient();
    setMeilisearchClientForTests(client);

    const app = new Elysia().use(listRoute);
    const res = await app.handle(
      new Request(
        'http://localhost/?placeQuery=greyson&sceneType=outdoor&activity=skiing&subjects=dog,beach&isScreenshot=false',
      ),
    );
    expect(res.status).toBe(200);
    await res.json();
    expect(calls[0]?.sceneType).toBe('outdoor');
    expect(calls[0]?.activity).toBe('skiing');
    expect(calls[0]?.subjects).toEqual(['dog', 'beach']);
    expect(calls[0]?.isScreenshot).toBe(false);
  });

  it('declines Meili and answers from the database when a filter cannot be pushed down', async () => {
    const { client, calls } = fakeMeiliClient();
    setMeilisearchClientForTests(client);

    const app = new Elysia().use(listRoute);
    // rating=4 has no Meilisearch counterpart. The seeded asset satisfies
    // both the text and the rating, but is absent from the fake Meili page —
    // so it can only be found via the database path.
    const res = await app.handle(new Request('http://localhost/?placeQuery=greyson&rating=4'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(calls.length).toBe(0);
    expect(body.results.map((r: { filename: string }) => r.filename)).toEqual(['match.dng']);
  });

  it('reports a total the grid can actually produce on the fallback path', async () => {
    const { client } = fakeMeiliClient();
    setMeilisearchClientForTests(client);

    const app = new Elysia().use(listRoute);
    const res = await app.handle(new Request('http://localhost/?placeQuery=greyson&rating=4'));
    expect(res.status).toBe(200);
    const body = await res.json();
    // 9331 is the fake index's estimatedTotalHits — the inflated count that
    // rendered above an empty grid in #2928.
    expect(body.total).toBe(1);
  });
});

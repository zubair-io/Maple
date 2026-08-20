/**
 * #2932 — the Meilisearch branch of `GET /api/search` asks Meili for one
 * page of `limit` relevance-ranked ids and then lets the Mongo re-fetch apply
 * the caller's structured filters to THAT PAGE. A filter Meilisearch never
 * saw can only remove rows from those ids; it can never reach a match ranked
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
 *      branch declines and the route falls through to the Mongo `$text`
 *      path, which applies all filters in one query and counts correctly.
 *
 * (2) trades relevance ranking for correctness on those queries. That is the
 * right way round: today they return the wrong answer confidently.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import { ObjectId, type Db } from 'mongodb';
import { listRoute } from './list.ts';
import { unpushableFilters } from './list-meili.ts';
import { SearchQueryT } from './query-schema.ts';
import { closeDb, getDb, isDbConnected } from '../../db/client.ts';
import {
  setMeilisearchClientForTests,
  type MeilisearchClient,
  type MeilisearchSearchOptions,
} from '../../enrichment/meilisearch-client.ts';
import { withTestDb } from '../../db/test-db.test-helpers.ts';

withTestDb(`maple_test_search_pushdown_${process.pid}`);

let db: Db | null = null;
let mongoReachable = false;

const MATCH_ID = 'maple-match';

beforeEach(async () => {
  try {
    db = await getDb();
    mongoReachable = isDbConnected();
  } catch {
    mongoReachable = false;
    return;
  }
  if (!mongoReachable || !db) return;
  await db.collection('assets').deleteMany({});
  // The Mongo fallback searches `$text`, which needs the index the real
  // deployment builds at startup.
  await db
    .collection('assets')
    .createIndex({ search_blob: 'text' })
    .catch(() => {});
});

afterEach(() => {
  setMeilisearchClientForTests(null);
});

afterAll(async () => {
  if (db) await db.dropDatabase();
  await closeDb();
});

async function seed(d: Db): Promise<void> {
  await d.collection('assets').insertMany([
    {
      maple_id: MATCH_ID,
      fileinfo: [{ path: '', filename: 'match.dng', library_id: new ObjectId(), deleted_at: null }],
      size: 1,
      mtime: 1,
      rating: 5,
      flag: 0,
      color_label: '',
      indexed_at: 'now',
      deleted_at: null,
      hidden: false,
      search_blob: 'greyson beach',
      exif: { captured_at: '2025-07-15T12:00:00.000Z', captured_month: 7 },
    },
  ] as never);
}

/** Returns a page that deliberately does NOT contain the seeded match, so a
 * test only passes if the route declined Meili and used Mongo instead. */
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

describe('unpushableFilters — which filters force the Mongo path', () => {
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
   * The guard is only as good as its coverage. A param added to the wire
   * contract without being classified would silently fall back into
   * post-filtering a page — the exact bug this closes. Failing here is the
   * signal to classify the new param, not to widen the allowlist blindly.
   */
  it('classifies every param in the wire schema', () => {
    const declared = Object.keys(SearchQueryT.properties);
    const unclassified = declared.filter((key) => {
      const asFilter = unpushableFilters({ placeQuery: 'x', [key]: 'probe-value' });
      const asEmpty = unpushableFilters({ placeQuery: 'x' });
      // Either the param forces a fallback, or it is knowingly inert here.
      return asFilter.length === asEmpty.length && !KNOWN_MEILI_SAFE.has(key);
    });
    expect(unclassified).toEqual([]);
  });
});

/** Params that legitimately do NOT force the Mongo path: pushed down into
 * the Meili query, or not filters at all. */
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
    if (!mongoReachable || !db) return;
    await seed(db);
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

  it('declines Meili and answers from Mongo when a filter cannot be pushed down', async () => {
    if (!mongoReachable || !db) return;
    await seed(db);
    const { client, calls } = fakeMeiliClient();
    setMeilisearchClientForTests(client);

    const app = new Elysia().use(listRoute);
    // rating=4 has no Meilisearch counterpart. The seeded asset satisfies
    // both the text and the rating, but is absent from the fake Meili page —
    // so it can only be found via the Mongo path.
    const res = await app.handle(new Request('http://localhost/?placeQuery=greyson&rating=4'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(calls.length).toBe(0);
    expect(body.results.map((r: { filename: string }) => r.filename)).toEqual(['match.dng']);
  });

  it('reports a total the grid can actually produce on the fallback path', async () => {
    if (!mongoReachable || !db) return;
    await seed(db);
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

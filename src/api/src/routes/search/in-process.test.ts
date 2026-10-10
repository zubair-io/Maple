/**
 * `GET /api/search` and its facets with the in-process engine selected (#4463): the child's fused
 * candidates are filtered in SQL by every filter of the request, counted and paged from that one
 * list; with the engine down, or Meilisearch selected, the route answers exactly as before.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import { listRoute } from './list.ts';
import { facetsRoute } from './facets.ts';
import { _resetCacheForTests } from './total-cache.ts';
import { seedSearchAsset } from '../../db/repos/search.test-helpers.ts';
import {
  createLiveTestDatabase,
  insertFolder,
  type LiveTestDatabase,
} from '../../db/sqlite/test-sqlite.test-helpers.ts';
import {
  resetSearchEngineSelectionForTests,
  saveSearchEngine,
} from '../../search/search-engine-selection.ts';
import { setInProcessSearchForTests } from '../../search/search-pool.ts';
import { fakeInProcessSearch } from '../../search/search.test-helpers.ts';
import { setMeilisearchClientForTests } from '../../enrichment/meilisearch-client.ts';

let live: LiveTestDatabase;

beforeEach(async () => {
  live = await createLiveTestDatabase();
  const libraryId = insertFolder(live.db, { slug: 'in-process', path: '/lib' });
  const assets: Array<[string, Parameters<typeof seedSearchAsset>[2]]> = [
    [
      'dunes',
      {
        rating: 5,
        cameraMake: 'Canon',
        searchBlob: 'sand dunes',
        capturedAt: '2023-05-01T12:00:00.000Z',
      },
    ],
    [
      'harbour',
      {
        rating: 1,
        cameraMake: 'Canon',
        searchBlob: 'greyson harbour',
        capturedAt: '2023-08-01T12:00:00.000Z',
      },
    ],
    ['hidden', { rating: 5, hidden: true, cameraMake: 'Canon', searchBlob: 'greyson hidden' }],
    [
      'meadow',
      {
        rating: 5,
        cameraMake: 'SONY',
        searchBlob: 'quiet meadow',
        capturedAt: '2024-06-01T12:00:00.000Z',
      },
    ],
    ['trashed', { rating: 5, deletedAt: '2026-01-01T00:00:00.000Z', searchBlob: 'greyson' }],
  ];
  for (const [mapleId, seed] of assets) {
    seedSearchAsset(live.db, libraryId, { ...seed, mapleId, filename: `${mapleId}.dng` });
  }
  _resetCacheForTests();
  resetSearchEngineSelectionForTests();
  await saveSearchEngine('in-process');
});

afterEach(() => {
  setInProcessSearchForTests(null);
  setMeilisearchClientForTests(null);
  resetSearchEngineSelectionForTests();
  _resetCacheForTests();
  live.close();
});

const RANKED = ['meadow', 'trashed', 'hidden', 'dunes', 'gone', 'harbour'];

async function list(query: string): Promise<{
  total: number;
  results: Array<{ filename: string }>;
  rankedBy?: unknown;
}> {
  const res = await new Elysia().use(listRoute).handle(new Request(`http://localhost/?${query}`));
  expect(res.status).toBe(200);
  return res.json();
}

function filenames(body: { results: Array<{ filename: string }> }): string[] {
  return body.results.map((result) => result.filename);
}

describe('GET /api/search with the in-process engine', () => {
  it('keeps the fused order, asks for 100 candidates and drops trashed, hidden and gone ids', async () => {
    const engine = fakeInProcessSearch(RANKED);
    setInProcessSearchForTests(engine);

    const body = await list('placeQuery=greyson');

    expect(engine.queries).toEqual([{ query: 'greyson', k: 100 }]);
    expect(filenames(body)).toEqual(['meadow.dng', 'dunes.dng', 'harbour.dng']);
    expect(body.total).toBe(3);
    expect(body.rankedBy).toEqual({ engine: 'in-process', semanticHits: 3 });
  });

  it('applies filters Meilisearch could not push down, to the whole candidate list', async () => {
    setInProcessSearchForTests(fakeInProcessSearch(RANKED));

    const body = await list('placeQuery=greyson&rating=5&hidden=all');

    expect(filenames(body)).toEqual(['meadow.dng', 'hidden.dng', 'dunes.dng']);
    expect(body.total).toBe(3);
  });

  it('pages through the filtered list with a stable total', async () => {
    setInProcessSearchForTests(fakeInProcessSearch(RANKED));

    const second = await list('placeQuery=greyson&limit=2&page=1');

    expect(filenames(second)).toEqual(['harbour.dng']);
    expect(second.total).toBe(3);
  });

  it('falls back to the database full-text path while the child is down', async () => {
    setInProcessSearchForTests(fakeInProcessSearch(null));

    const body = await list('placeQuery=greyson');

    expect(filenames(body)).toEqual(['harbour.dng']);
    expect(body.total).toBe(1);
  });

  it('never asks the child when Meilisearch is selected', async () => {
    const engine = fakeInProcessSearch(RANKED);
    setInProcessSearchForTests(engine);
    await saveSearchEngine('meilisearch');

    await list('placeQuery=greyson');

    expect(engine.queries).toEqual([]);
  });

  it('leaves a search without free text on the database path', async () => {
    const engine = fakeInProcessSearch(RANKED);
    setInProcessSearchForTests(engine);

    const body = await list('rating=5');

    expect(engine.queries).toEqual([]);
    expect(body.total).toBe(2);
  });
});

describe('GET /api/search/facets with the in-process engine', () => {
  async function facets(query: string) {
    const res = await new Elysia()
      .use(facetsRoute)
      .handle(new Request(`http://localhost/facets?${query}`));
    expect(res.status).toBe(200);
    return (await res.json()) as {
      total: number;
      cameras: Array<{ make: string | null; count: number }>;
    };
  }

  it('counts the same filtered candidates the list shows', async () => {
    setInProcessSearchForTests(fakeInProcessSearch(RANKED));

    const body = await facets('placeQuery=greyson');

    expect(body.total).toBe(3);
    expect(body.cameras.map((row) => [row.make, row.count])).toEqual([
      ['Canon', 2],
      ['SONY', 1],
    ]);
  });

  it('applies a natural-language date window to the candidates, as the list does', async () => {
    const engine = fakeInProcessSearch(RANKED);
    setInProcessSearchForTests(engine);

    const facetBody = await facets('placeQuery=greyson%20in%202023');
    const listBody = await list('placeQuery=greyson%20in%202023');

    expect(engine.queries.map((query) => query.query)).toEqual(['greyson in', 'greyson in']);
    expect(facetBody.total).toBe(2);
    expect(facetBody.cameras.map((row) => [row.make, row.count])).toEqual([['Canon', 2]]);
    expect(filenames(listBody)).toEqual(['dunes.dng', 'harbour.dng']);
    expect(listBody.total).toBe(2);
  });

  it('never caches the Meilisearch stand-in for the in-process ranking', async () => {
    const meiliCalls: string[] = [];
    setMeilisearchClientForTests({
      isConfigured: () => true,
      semanticConfigured: () => false,
      health: async () => true,
      ensureIndex: async () => {},
      upsert: async () => {},
      upsertOrThrow: async () => {},
      tombstone: async () => {},
      search: async (q) => {
        meiliCalls.push(q);
        return { ids: ['meadow'], estimatedTotal: 1 };
      },
    });
    setInProcessSearchForTests(fakeInProcessSearch(null));

    const whileLoading = await facets('placeQuery=greyson');
    const engine = fakeInProcessSearch(RANKED);
    setInProcessSearchForTests(engine);
    const onceReady = await facets('placeQuery=greyson');

    expect(meiliCalls).toEqual(['greyson']);
    expect(whileLoading.total).toBe(1);
    expect(engine.queries.length).toBe(1);
    expect(onceReady.total).toBe(3);
  });

  it('falls back to the database ranking while the child is down', async () => {
    setInProcessSearchForTests(fakeInProcessSearch(null));

    const body = await facets('placeQuery=greyson');

    expect(body.total).toBe(1);
  });
});

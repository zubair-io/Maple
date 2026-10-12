/**
 * `GET /api/search`'s free-text window (#4514): the engine ranks as deep as the requested page,
 * `total` is the filtered window and `more` says a deeper page can widen it — so a client keeps
 * paging past a full window instead of stopping at its size, and nothing counts every match.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import { listRoute } from './list.ts';
import { facetsRoute } from './facets.ts';
import { bucketsRoute, _resetBucketsCacheForTests } from './buckets.ts';
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
import { RANKED_WINDOW_BASE, RANKED_WINDOW_MAX } from '../../db/repos/search.ranked.ts';
import { windowNeed } from './ranked-window.ts';

let live: LiveTestDatabase;
let libraryId: string;
const ranked: string[] = [];

beforeEach(async () => {
  live = await createLiveTestDatabase();
  libraryId = insertFolder(live.db, { slug: 'window', path: '/lib' });
  ranked.length = 0;
  for (let rank = 1; rank <= 250; rank++) {
    const mapleId = `photo${String(rank).padStart(3, '0')}`;
    ranked.push(mapleId);
    seedSearchAsset(live.db, libraryId, {
      mapleId,
      filename: `${mapleId}.dng`,
      rating: rank % 2 === 0 ? 5 : 1,
      searchBlob: `greyson ${'x'.repeat(rank)}`,
    });
  }
  _resetCacheForTests();
  resetSearchEngineSelectionForTests();
  await saveSearchEngine('in-process');
});

afterEach(() => {
  setInProcessSearchForTests(null);
  resetSearchEngineSelectionForTests();
  _resetCacheForTests();
  live.close();
});

async function list(query: string): Promise<{ total: number; more: boolean; results: unknown[] }> {
  const res = await new Elysia().use(listRoute).handle(new Request(`http://localhost/?${query}`));
  expect(res.status).toBe(200);
  return res.json();
}

/** A child that honours `k`, as the real one does. */
function honouringK(ids: readonly string[]) {
  const inner = fakeInProcessSearch(ids);
  return {
    ...inner,
    search: async (query: string, k: number) => (await inner.search(query, k))?.slice(0, k) ?? null,
  };
}

describe('the in-process window', () => {
  it('reports a full window as more, and widens it for a deeper page', async () => {
    const engine = honouringK(ranked);
    setInProcessSearchForTests(engine);

    const first = await list('placeQuery=greyson&limit=100');
    const third = await list('placeQuery=greyson&limit=100&page=2');

    expect(first).toMatchObject({ total: RANKED_WINDOW_BASE, more: true });
    expect(third).toMatchObject({ total: 250, more: false });
    expect(third.results).toHaveLength(50);
    expect(engine.queries.map((q) => q.k)).toEqual([RANKED_WINDOW_BASE, 300]);
  });

  it('widens once when a filter leaves a full window short', async () => {
    const engine = honouringK(ranked);
    setInProcessSearchForTests(engine);

    const body = await list('placeQuery=greyson&rating=5&limit=100');

    expect(engine.queries.map((q) => q.k)).toEqual([RANKED_WINDOW_BASE, 300]);
    expect(body).toMatchObject({ total: 125, more: false });
  });
});

describe('the database window while the child is down', () => {
  it('is bounded the same way: a full window says more', async () => {
    setInProcessSearchForTests(fakeInProcessSearch(null));

    const body = await list('placeQuery=greyson&limit=50');

    expect(body).toMatchObject({ total: RANKED_WINDOW_BASE, more: true });
    expect(body.results).toHaveLength(50);
  });
});

describe('paging a window through a tie wider than the window', () => {
  it('serves every match exactly once while the window widens under it', async () => {
    setInProcessSearchForTests(fakeInProcessSearch(null));
    const picked: string[] = [];
    for (let index = 0; index < 330; index++) {
      const mapleId = `tie${String(index).padStart(3, '0')}`;
      seedSearchAsset(live.db, libraryId, {
        mapleId,
        filename: `${mapleId}.dng`,
        rating: index % 2 === 0 ? 5 : 1,
        searchBlob: 'harbour',
        capturedAt: `20${10 + (index % 13)}-0${(index % 9) + 1}-15T12:00:00.000Z`,
      });
      if (index % 2 === 0) picked.push(`${mapleId}.dng`);
    }

    const pages = [];
    for (const page of [0, 1, 2, 3]) {
      pages.push(await list(`placeQuery=harbour&rating=5&limit=50&page=${page}`));
    }
    const served = pages.flatMap((body) =>
      (body.results as Array<{ filename: string }>).map((row) => row.filename),
    );

    expect(new Set(served).size).toBe(served.length);
    expect(served).toEqual(picked);
    expect(pages.map((body) => body.more)).toEqual([true, true, false, false]);
  });
});

describe('facets and buckets of a page describe the window its list counts', () => {
  async function totals(query: string): Promise<{ list: number; facets: number; buckets: number }> {
    const app = new Elysia().use(listRoute).use(facetsRoute).use(bucketsRoute);
    const read = async (path: string) =>
      (await (await app.handle(new Request(`http://localhost${path}?${query}`))).json()) as {
        total: number;
      };
    _resetBucketsCacheForTests();
    return {
      list: (await read('/')).total,
      facets: (await read('/facets')).total,
      buckets: (await read('/buckets')).total,
    };
  }

  it('with the in-process engine, on a deep page', async () => {
    setInProcessSearchForTests(honouringK(ranked));

    expect(await totals('placeQuery=greyson&limit=100')).toEqual({
      list: 100,
      facets: 100,
      buckets: 100,
    });
    expect(await totals('placeQuery=greyson&limit=100&page=2')).toEqual({
      list: 250,
      facets: 250,
      buckets: 250,
    });
  });

  it('with the database window, widened by a filter', async () => {
    setInProcessSearchForTests(fakeInProcessSearch(null));
    await saveSearchEngine('meilisearch');

    const shallow = await totals('placeQuery=greyson&rating=5&limit=20');
    const deep = await totals('placeQuery=greyson&rating=5&limit=100&page=1');

    expect(new Set(Object.values(shallow)).size).toBe(1);
    expect(new Set(Object.values(deep)).size).toBe(1);
    expect(deep.list).toBeGreaterThan(shallow.list);
  });
});

describe('windowNeed', () => {
  it('is the rows a page reaches, clamped as the list clamps page and limit', () => {
    expect(windowNeed({})).toBe(100);
    expect(windowNeed({ page: '2', limit: '50' })).toBe(150);
    expect(windowNeed({ page: '-3', limit: '0' })).toBe(1);
    expect(windowNeed({ page: 'abc', limit: 'abc' })).toBe(100);
    expect(windowNeed({ limit: '9999' })).toBe(500);
    expect(windowNeed({ page: '10000', limit: '500' })).toBe(RANKED_WINDOW_MAX);
  });
});

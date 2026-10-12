/**
 * `GET /api/search`'s free-text window (#4514): the engine ranks as deep as the requested page,
 * `total` is the filtered window and `more` says a deeper page can widen it — so a client keeps
 * paging past a full window instead of stopping at its size, and nothing counts every match.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import { listRoute } from './list.ts';
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
import { RANKED_WINDOW_BASE } from '../../db/repos/search.ranked.ts';

let live: LiveTestDatabase;
const ranked: string[] = [];

beforeEach(async () => {
  live = await createLiveTestDatabase();
  const libraryId = insertFolder(live.db, { slug: 'window', path: '/lib' });
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

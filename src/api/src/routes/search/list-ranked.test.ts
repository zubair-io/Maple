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
  run,
  type LiveTestDatabase,
} from '../../db/sqlite/test-sqlite.test-helpers.ts';
import { buildSearchWhere } from '../../db/repos/search.where.ts';
import { setInProcessSearchForTests } from '../../search/search-pool.ts';
import { fakeInProcessSearch } from '../../search/search.test-helpers.ts';
import { RANKED_WINDOW_BASE, RANKED_WINDOW_MAX } from '../../db/repos/search.ranked.ts';
import { requestWindow, windowNeed, windowPage } from './ranked-window.ts';

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
});

afterEach(() => {
  setInProcessSearchForTests(null);
  _resetCacheForTests();
  live.close();
});

async function list(
  query: string,
): Promise<{ total: number; more: boolean; results: unknown[]; rankedBy?: unknown }> {
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

    const first = await list('placeQuery=greyson&limit=75');
    const fourth = await list('placeQuery=greyson&limit=75&page=3');

    expect(first).toMatchObject({ total: RANKED_WINDOW_BASE, more: true });
    expect(fourth).toMatchObject({ total: 250, more: false });
    expect(fourth.results).toHaveLength(25);
    expect(engine.queries.map((q) => q.k)).toEqual([RANKED_WINDOW_BASE, 400]);
  });

  it('widens when a filter leaves a full window short', async () => {
    const engine = honouringK(ranked);
    setInProcessSearchForTests(engine);

    const body = await list('placeQuery=greyson&rating=5&limit=75');

    expect(engine.queries.map((q) => q.k)).toEqual([RANKED_WINDOW_BASE, 400]);
    expect(body).toMatchObject({ total: 125, more: false });
  });
});

describe('an in-process window the filters leave empty', () => {
  it('asks the database too when the child returned fewer hits than asked', async () => {
    setInProcessSearchForTests(honouringK(['gone1', 'gone2', 'gone3']));

    const body = await list('placeQuery=greyson&rating=5&limit=10');

    expect(body.total).toBeGreaterThan(0);
    expect(body.rankedBy).toBeUndefined();
  });

  it('asks the database too when the child had exactly the cap and nothing survived (#4543)', async () => {
    const nowhere = Array.from({ length: RANKED_WINDOW_MAX }, (_, index) => `gone${index}`);
    const engine = honouringK(nowhere);
    setInProcessSearchForTests(engine);

    const body = await list('placeQuery=greyson&limit=10');

    expect(body).toMatchObject({ total: RANKED_WINDOW_BASE, more: true, capped: false });
    expect(body.rankedBy).toBeUndefined();
    expect(engine.queries.map((query) => query.k)).toEqual([
      100,
      400,
      1_600,
      RANKED_WINDOW_MAX + 1,
    ]);
  });

  it('stands when the child ranked past the cap and nothing survived', async () => {
    const nowhere = Array.from({ length: RANKED_WINDOW_MAX + 1 }, (_, index) => `gone${index}`);
    const engine = honouringK(nowhere);
    setInProcessSearchForTests(engine);

    const body = await list('placeQuery=greyson&limit=10');

    expect(body).toMatchObject({ total: 0, more: false, capped: true });
    expect(engine.queries.map((query) => query.k)).toEqual([
      100,
      400,
      1_600,
      RANKED_WINDOW_MAX + 1,
    ]);
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
    expect(pages.map((body) => body.more)).toEqual([false, false, false, false]);
  });
});

describe('paging a selective filter whose survivors sit deep in the ranking (#4514)', () => {
  it('serves every surviving match exactly once, page by page, however far each page widens', async () => {
    setInProcessSearchForTests(fakeInProcessSearch(null));
    const picked: string[] = [];
    for (let index = 0; index < 330; index++) {
      const mapleId = `deep${String(index).padStart(3, '0')}`;
      const survives = index < 5 || (index >= 150 && index % 3 === 0);
      seedSearchAsset(live.db, libraryId, {
        mapleId,
        filename: `${mapleId}.dng`,
        rating: survives ? 4 : 2,
        searchBlob: 'lighthouse',
      });
      if (survives) picked.push(`${mapleId}.dng`);
    }

    const pages = [];
    for (const page of [0, 1, 2, 3, 4]) {
      pages.push(await list(`placeQuery=lighthouse&rating=4&limit=20&page=${page}`));
    }
    const served = pages.flatMap((body) =>
      (body.results as Array<{ filename: string }>).map((row) => row.filename),
    );

    expect(pages[0]!.results).toHaveLength(20);
    expect(new Set(served).size).toBe(served.length);
    expect(served).toEqual(picked);
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

    expect(await totals('placeQuery=greyson&limit=75')).toEqual({
      list: 100,
      facets: 100,
      buckets: 100,
    });
    expect(await totals('placeQuery=greyson&limit=75&page=2')).toEqual({
      list: 250,
      facets: 250,
      buckets: 250,
    });
  });

  it('with the database window, widened by a filter', async () => {
    setInProcessSearchForTests(fakeInProcessSearch(null));

    const shallow = await totals('placeQuery=greyson&rating=5&limit=20');
    const deep = await totals('placeQuery=greyson&rating=5&limit=100&page=1');

    expect(new Set(Object.values(shallow)).size).toBe(1);
    expect(new Set(Object.values(deep)).size).toBe(1);
    expect(shallow.list).toBe(125);
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

describe('the free text a search accepts', () => {
  it('rejects a placeQuery over 1,000 characters with a 400, before any engine sees it', async () => {
    const engine = fakeInProcessSearch(ranked);
    setInProcessSearchForTests(engine);
    const app = new Elysia().use(listRoute).use(facetsRoute).use(bucketsRoute);

    for (const path of ['/', '/facets', '/buckets']) {
      const res = await app.handle(
        new Request(`http://localhost${path}?placeQuery=${'a'.repeat(1_001)}`),
      );
      expect({ path, status: res.status }).toEqual({ path, status: 400 });
    }
    const atLimit = await list(`placeQuery=${'a'.repeat(1_000)}`);
    expect(atLimit.results).toBeDefined();
    expect(engine.queries.every((query) => query.query.length <= 1_000)).toBe(true);
  });
});

describe('cached facets and buckets follow the engine that answers', () => {
  it("never keeps the database's stand-in for the child's window once the child answers", async () => {
    setInProcessSearchForTests(fakeInProcessSearch(null));
    const app = new Elysia().use(facetsRoute).use(bucketsRoute);
    const totals = async () => ({
      facets: (
        (await (
          await app.handle(new Request('http://localhost/facets?placeQuery=greyson&limit=30'))
        ).json()) as { total: number }
      ).total,
      buckets: (
        (await (
          await app.handle(new Request('http://localhost/buckets?placeQuery=greyson&limit=30'))
        ).json()) as { total: number }
      ).total,
    });

    expect(await totals()).toEqual({ facets: RANKED_WINDOW_BASE, buckets: RANKED_WINDOW_BASE });
    setInProcessSearchForTests(honouringK(ranked.slice(0, 5)));
    expect(await totals()).toEqual({ facets: 5, buckets: 5 });
  });
});

describe('a window row deleted between ranking and hydration (#4545)', () => {
  it('is neither served nor counted in the total', async () => {
    setInProcessSearchForTests(honouringK(ranked.slice(0, 5)));
    const built = buildSearchWhere({ placeQuery: 'greyson' });
    if ('error' in built) throw new Error(built.error);
    const window = await requestWindow({ where: built, text: 'greyson', need: 10 });
    run(
      live.db,
      `UPDATE assets SET deleted_at = '2026-10-12T00:00:00Z' WHERE maple_id = ?`,
      ranked[1]!,
    );

    const page = await windowPage(window, { where: built, skip: 0, limit: 10 });

    expect(window.rows).toHaveLength(5);
    expect(page.results.map((row) => row.filename)).toEqual(
      [0, 2, 3, 4].map((index) => `${ranked[index]!}.dng`),
    );
    expect(page.total).toBe(page.results.length);
  });
});

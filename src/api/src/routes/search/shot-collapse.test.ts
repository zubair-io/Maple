/**
 * One tile per shot on every path that takes the shared ranked window (#4557): the list, its
 * facets and buckets, map clusters, a For You collection and hybrid service search all serve the
 * best-ranked copy of each shot and count shots, not files.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import { ObjectId } from '../../db/object-id.ts';
import { seedSearchAsset } from '../../db/repos/search.test-helpers.ts';
import {
  createLiveTestDatabase,
  insertFolder,
  run,
  type LiveTestDatabase,
} from '../../db/sqlite/test-sqlite.test-helpers.ts';
import { invalidateLibraryRoots } from '../../indexer/libraries.cache.ts';
import { setInProcessSearchForTests } from '../../search/search-pool.ts';
import { fakeInProcessSearch } from '../../search/search.test-helpers.ts';
import { generatedSearchesRoutes } from '../generated-searches.ts';
import { mapRoutes } from '../map/index.ts';
import { inProcessServiceSearch } from '../service-asset-search-in-process.ts';
import { bucketsRoute, _resetBucketsCacheForTests } from './buckets.ts';
import { facetsRoute } from './facets.ts';
import { listRoute } from './list.ts';
import { _resetCacheForTests } from './total-cache.ts';

const SECOND = '2018-05-21T17:50:35.000Z';

/** Ranked best first: three copies of `_MG_4006`, a RAW+JPEG pair, and two burst neighbours. */
const RANKED: Array<[string, string, string]> = [
  ['copy-a', '2018/Sunset Beach', '_MG_4006(2).jpg'],
  ['burst-a', '2018/Misc', '_MG_1768.CR2'],
  ['raw', '2018/Misc', '_MG_4006.CR2'],
  ['pair-raw', '2006/Family', 'IMG_0039.CR2'],
  ['burst-b', '2018/Misc', '_MG_1770.CR2'],
  ['copy-b', '2018/Misc', '_MG_4006(1)(1).jpg'],
  ['pair-jpg', '2006/Family', 'IMG_0039.JPG'],
];
const SHOTS = ['_MG_4006(2).jpg', '_MG_1768.CR2', 'IMG_0039.CR2', '_MG_1770.CR2'];

let live: LiveTestDatabase;
let libraryId: string;

beforeEach(async () => {
  live = await createLiveTestDatabase();
  libraryId = insertFolder(live.db, { slug: 'shots', path: '/lib' });
  invalidateLibraryRoots();
  for (const [mapleId, path, filename] of RANKED) {
    seedSearchAsset(live.db, libraryId, {
      mapleId,
      path,
      filename,
      capturedAt: SECOND,
      gps: { lat: 21.27, lng: -157.82 },
      searchBlob: `sunset ${mapleId}`,
    });
  }
  setInProcessSearchForTests(fakeInProcessSearch(RANKED.map(([mapleId]) => mapleId)));
  _resetCacheForTests();
  _resetBucketsCacheForTests();
});

afterEach(() => {
  setInProcessSearchForTests(null);
  _resetCacheForTests();
  invalidateLibraryRoots();
  live.close();
});

const app = new Elysia().use(listRoute).use(facetsRoute).use(bucketsRoute);

async function read<T>(path: string): Promise<T> {
  const res = await app.handle(new Request(`http://localhost${path}`));
  expect(res.status).toBe(200);
  return (await res.json()) as T;
}

type ListBody = { total: number; more: boolean; results: Array<{ filename: string }> };

describe('the list', () => {
  it('serves one tile per shot, the best-ranked copy, and counts shots', async () => {
    const body = await read<ListBody>('/?placeQuery=sunset&limit=10');

    expect(body.results.map((row) => row.filename)).toEqual(SHOTS);
    expect(body).toMatchObject({ total: SHOTS.length, more: false });
  });

  it('pages the collapsed window without repeating or skipping a shot', async () => {
    const pages = await Promise.all(
      [0, 1].map((page) => read<ListBody>(`/?placeQuery=sunset&limit=2&page=${page}`)),
    );

    expect(pages.flatMap((body) => body.results.map((row) => row.filename))).toEqual(SHOTS);
    expect(pages.map((body) => body.total)).toEqual([SHOTS.length, SHOTS.length]);
  });

  it('collapses the database window the same way while the child is down', async () => {
    setInProcessSearchForTests(fakeInProcessSearch(null));

    const body = await read<ListBody>('/?placeQuery=sunset&limit=10');

    expect(body.total).toBe(SHOTS.length);
    expect(new Set(body.results.map((row) => row.filename.slice(0, 8))).size).toBe(SHOTS.length);
  });
});

describe('facets and buckets', () => {
  it('count the shots the list counts', async () => {
    const facets = await read<{ total: number }>('/facets?placeQuery=sunset&limit=10');
    const buckets = await read<{ total: number }>('/buckets?placeQuery=sunset&limit=10');

    expect([facets.total, buckets.total]).toEqual([SHOTS.length, SHOTS.length]);
  });
});

describe('map clusters', () => {
  it('cluster one point per shot', async () => {
    const res = await new Elysia()
      .use(mapRoutes)
      .handle(
        new Request(
          'http://localhost/api/map/clusters?placeQuery=sunset&bbox=-180,-90,180,90&zoom=3',
        ),
      );
    const body = (await res.json()) as { cells: Array<{ count: number }> };

    expect(body.cells.reduce((sum, cell) => sum + cell.count, 0)).toBe(SHOTS.length);
  });
});

describe('a For You collection', () => {
  it('pages one tile per shot', async () => {
    const id = new ObjectId().toHexString();
    run(
      live.db,
      `INSERT INTO generated_searches
         (id, library_id, generated_for, generated_at, model, attempts,
          theme, title, subtitle, query, result_count, cover_asset_id, first_page_ids)
       VALUES (?, ?, '2026-10-12', '2026-10-12T03:00:00.000Z', 'm', 1, 't', 'Sunset', NULL, ?, 3,
               NULL, NULL)`,
      id,
      libraryId,
      JSON.stringify({ placeQuery: 'sunset' }),
    );
    const res = await new Elysia()
      .use(generatedSearchesRoutes)
      .handle(new Request(`http://localhost/api/generated-searches/${id}/assets?limit=10`));
    const body = (await res.json()) as ListBody;

    expect(body.results.map((row) => row.filename)).toEqual(SHOTS);
    expect(body.total).toBe(SHOTS.length);
  });
});

describe('service search', () => {
  it('returns one id per shot, best-ranked first, and fills its limit past collapsed copies', async () => {
    const scope = {
      includeHidden: false,
      mediaTypes: undefined,
      capturedFrom: undefined,
      capturedBefore: undefined,
    };

    const all = await inProcessServiceSearch(scope, 'sunset', 10);
    const top = await inProcessServiceSearch(scope, 'sunset', 3);

    expect(all).toMatchObject({
      ids: ['copy-a', 'burst-a', 'pair-raw', 'burst-b'],
      estimatedTotal: 4,
      more: false,
    });
    expect(top).toMatchObject({ ids: ['copy-a', 'burst-a', 'pair-raw'], more: true });
  });
});

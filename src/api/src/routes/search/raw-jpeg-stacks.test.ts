/**
 * RAW+JPEG stacks in the timeline and search (#5849): with `stack_raw_jpeg` on, a JPEG the
 * discover sweep paired with its RAW leaves the list, its total and the timeline histogram, and
 * the RAW result carries it as `stack.companion`, in the folder listing's shape. Facet groups
 * still count files. Real SQLite, paired by the sweep's own reconcile.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import { ObjectId } from '../../db/object-id.ts';
import { reconcileRawJpegStacks } from '../../db/repos/assets.raw-jpeg-stacks.ts';
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
import { bucketsRoute, _resetBucketsCacheForTests } from './buckets.ts';
import { facetsRoute } from './facets.ts';
import { listRoute } from './list.ts';
import { _resetCacheForTests } from './total-cache.ts';

let live: LiveTestDatabase;
let raw: string;
let jpeg: string;

beforeEach(async () => {
  live = await createLiveTestDatabase();
  const libraryId = insertFolder(live.db, { slug: 'stacks', path: '/lib' });
  invalidateLibraryRoots();
  const seed = (mapleId: string, path: string, filename: string, capturedAt: string) =>
    seedSearchAsset(live.db, libraryId, {
      mapleId,
      path,
      filename,
      capturedAt,
      searchBlob: `harbour ${mapleId}`,
    });
  // The JPEG is newer than the RAW, so a page that failed to fold would lead with it.
  raw = seed('raw', 'trip', 'IMG_1.CR3', '2024-06-01T10:00:00.000Z');
  jpeg = seed('jpeg', 'trip', 'IMG_1.JPG', '2024-06-01T10:00:01.000Z');
  seed('lone', 'trip', 'IMG_2.JPG', '2024-05-01T10:00:00.000Z');
  await reconcileRawJpegStacks(new ObjectId(libraryId), 'trip');
  _resetCacheForTests();
  _resetBucketsCacheForTests();
});

afterEach(() => {
  setInProcessSearchForTests(null);
  _resetCacheForTests();
  _resetBucketsCacheForTests();
  invalidateLibraryRoots();
  live.close();
});

const app = new Elysia().use(listRoute).use(facetsRoute).use(bucketsRoute);

interface Result {
  _id: string;
  filename: string;
  stack?: { companion: Record<string, unknown> };
}

async function get<T>(path: string): Promise<T> {
  const response = await app.handle(new Request(`http://localhost${path}`));
  expect(response.status).toBe(200);
  return (await response.json()) as T;
}

const list = () => get<{ total: number; results: Result[] }>('/');
const histogram = () =>
  get<{ total: number; buckets: Array<{ year: number; month: number; count: number }> }>(
    '/buckets',
  );

function setStacking(value: boolean): void {
  run(
    live.db,
    `INSERT INTO app_settings (id, doc) VALUES ('display', ?)
     ON CONFLICT(id) DO UPDATE SET doc = excluded.doc`,
    JSON.stringify({ stack_raw_jpeg: value }),
  );
}

describe('RAW+JPEG stacks in search and the timeline #5849', () => {
  it('lists the RAW once, carrying its JPEG, and counts the pair as one', async () => {
    const { total, results } = await list();

    expect(total).toBe(2);
    expect(results.map((result) => result.filename)).toEqual(['IMG_1.CR3', 'IMG_2.JPG']);
    expect(results[0]?._id).toBe(raw);
    expect(results[0]?.stack?.companion).toEqual({
      id: jpeg,
      name: 'IMG_1.JPG',
      address: 'stacks:trip/IMG_1.JPG',
      path: '/lib/trip/IMG_1.JPG',
      size: expect.any(Number),
      mtime: expect.any(String),
      ext: 'jpg',
    });
    expect(results[1]?.stack).toBeUndefined();
  });

  it('the timeline histogram and the facet total count the pair once; facet groups count files', async () => {
    const { total, buckets } = await histogram();
    expect(total).toBe(2);
    expect(buckets).toEqual([
      { year: 2024, month: 6, count: 1 },
      { year: 2024, month: 5, count: 1 },
    ]);

    const facets = await get<{
      total: number;
      extensions: Array<{ value: string; count: number }>;
    }>('/facets');
    expect(facets.total).toBe(2);
    expect(facets.extensions).toEqual(
      expect.arrayContaining([
        { value: 'jpg', count: 2 },
        { value: 'cr3', count: 1 },
      ]),
    );
  });

  it('with stacking off, both files are results again and nothing is cached across the switch', async () => {
    await list();
    await histogram();
    setStacking(false);

    const { total, results } = await list();
    expect(total).toBe(3);
    expect(results.map((result) => result.filename)).toEqual([
      'IMG_1.JPG',
      'IMG_1.CR3',
      'IMG_2.JPG',
    ]);
    expect(results.some((result) => result.stack)).toBe(false);
    expect((await histogram()).buckets[0]).toEqual({ year: 2024, month: 6, count: 2 });
  });

  it('a type filter asks for files, so ext=jpg finds the stacked JPEG', async () => {
    const { results } = await get<{ results: Result[] }>('/?ext=jpg');
    expect(results.map((result) => result.filename)).toEqual(['IMG_1.JPG', 'IMG_2.JPG']);
  });

  it('a ranked text search serves the RAW with its JPEG even when the JPEG ranks first', async () => {
    setInProcessSearchForTests(fakeInProcessSearch(['jpeg', 'lone', 'raw']));

    const { results } = await get<{ results: Result[] }>('/?placeQuery=harbour');

    expect(results.map((result) => result.filename)).toEqual(['IMG_2.JPG', 'IMG_1.CR3']);
    expect(results[1]?.stack?.companion).toMatchObject({ id: jpeg, name: 'IMG_1.JPG' });
  });
});

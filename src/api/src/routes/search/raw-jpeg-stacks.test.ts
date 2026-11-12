/**
 * RAW+JPEG stacks in the timeline and search (#5849). Folding is opt-in per request (`stack=1`):
 * a JPEG the discover sweep paired with its RAW leaves the list, its total and the timeline
 * histogram only when its RAW survives the same request, and the RAW result carries it as
 * `stack.companion`, in the folder listing's shape. Facet groups still count files. Real SQLite,
 * paired by the sweep's own reconcile.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import { ObjectId } from '../../db/object-id.ts';
import { reconcileRawJpegStacks } from '../../db/repos/assets.raw-jpeg-stacks.ts';
import { seedSearchAsset } from '../../db/repos/search.test-helpers.ts';
import {
  createLiveTestDatabase,
  insertFolder,
  insertLocation,
  run,
  type LiveTestDatabase,
} from '../../db/sqlite/test-sqlite.test-helpers.ts';
import { invalidateLibraryRoots } from '../../indexer/libraries.cache.ts';
import { setInProcessSearchForTests } from '../../search/search-pool.ts';
import { fakeInProcessSearch } from '../../search/search.test-helpers.ts';
import { mapClustersRoute } from '../map/clusters.ts';
import { bucketsRoute, _resetBucketsCacheForTests } from './buckets.ts';
import { facetsRoute } from './facets.ts';
import { listRoute } from './list.ts';
import { _resetCacheForTests } from './total-cache.ts';

let live: LiveTestDatabase;
let raw: string;
let jpeg: string;
let libraryId: string;

beforeEach(async () => {
  live = await createLiveTestDatabase();
  libraryId = insertFolder(live.db, { slug: 'stacks', path: '/lib' });
  invalidateLibraryRoots();
  const seed = (
    mapleId: string,
    filename: string,
    capturedAt: string,
    gps: { lat: number; lng: number } | null = null,
  ) =>
    seedSearchAsset(live.db, libraryId, {
      mapleId,
      path: 'trip',
      filename,
      capturedAt,
      gps,
      searchBlob: `harbour ${mapleId}`,
    });
  // The JPEG is newer than the RAW, so a page that failed to fold would lead with it. Only the
  // JPEG carries GPS, as when the RAW's location did not parse.
  raw = seed('raw', 'IMG_1.CR3', '2024-06-01T10:00:00.000Z');
  jpeg = seed('jpeg', 'IMG_1.JPG', '2024-06-01T10:00:01.000Z', { lat: 42.65, lng: -73.75 });
  seed('lone', 'IMG_2.JPG', '2024-05-01T10:00:00.000Z');
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

const app = new Elysia().use(listRoute).use(facetsRoute).use(bucketsRoute).use(mapClustersRoute);

interface Result {
  _id: string;
  filename: string;
  stack?: { companion: Record<string, unknown> };
}
interface Page {
  total: number;
  results: Result[];
}
interface Histogram {
  total: number;
  buckets: Array<{ year: number; month: number; count: number }>;
}

async function get<T>(path: string): Promise<T> {
  const response = await app.handle(new Request(`http://localhost${path}`));
  expect(response.status).toBe(200);
  return (await response.json()) as T;
}
const filenames = (page: Page) => page.results.map((result) => result.filename);

describe('RAW+JPEG stacks in search and the timeline #5849', () => {
  it('stack=1 lists the RAW once, carrying its JPEG, and counts the pair as one', async () => {
    const page = await get<Page>('/?stack=1');

    expect(page.total).toBe(2);
    expect(filenames(page)).toEqual(['IMG_1.CR3', 'IMG_2.JPG']);
    expect(page.results[0]?._id).toBe(raw);
    expect(page.results[0]?.stack?.companion).toEqual({
      id: jpeg,
      name: 'IMG_1.JPG',
      address: 'stacks:trip/IMG_1.JPG',
      path: '/lib/trip/IMG_1.JPG',
      size: expect.any(Number),
      mtime: expect.any(String),
      ext: 'jpg',
    });
    expect(page.results[1]?.stack).toBeUndefined();
  });

  it('the timeline histogram and the facet total count the pair once; facet groups count files', async () => {
    const { total, buckets } = await get<Histogram>('/buckets?stack=1');
    expect(total).toBe(2);
    expect(buckets).toEqual([
      { year: 2024, month: 6, count: 1 },
      { year: 2024, month: 5, count: 1 },
    ]);

    const facets = await get<{
      total: number;
      extensions: Array<{ value: string; count: number }>;
    }>('/facets?stack=1');
    expect(facets.total).toBe(2);
    expect(facets.extensions).toEqual(
      expect.arrayContaining([
        { value: 'jpg', count: 2 },
        { value: 'cr3', count: 1 },
      ]),
    );
  });

  it('without stack=1 both files are results, whatever the display setting says', async () => {
    run(
      live.db,
      `INSERT INTO app_settings (id, doc) VALUES ('display', ?)`,
      JSON.stringify({ stack_raw_jpeg: true }),
    );
    await get<Page>('/?stack=1');
    await get<Histogram>('/buckets?stack=1');

    for (const query of ['', '?stack=0']) {
      const page = await get<Page>(`/${query}`);
      expect(page.total).toBe(3);
      expect(filenames(page)).toEqual(['IMG_1.JPG', 'IMG_1.CR3', 'IMG_2.JPG']);
      expect(page.results.some((result) => result.stack)).toBe(false);
      expect((await get<Histogram>(`/buckets${query}`)).buckets[0]).toEqual({
        year: 2024,
        month: 6,
        count: 2,
      });
    }
  });

  it('a stack value other than 0 or 1 is refused', async () => {
    const response = await app.handle(new Request('http://localhost/?stack=true'));
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
  });

  it('a type filter asks for files, so ext=jpg finds the stacked JPEG', async () => {
    const page = await get<Page>('/?ext=jpg&stack=1');
    expect(filenames(page)).toEqual(['IMG_1.JPG', 'IMG_2.JPG']);
  });

  it('a filter only the JPEG matches keeps the JPEG, in the list, its total and the timeline', async () => {
    const page = await get<Page>('/?q=IMG_1.JPG&stack=1');
    expect(page.total).toBe(1);
    expect(filenames(page)).toEqual(['IMG_1.JPG']);
    expect(page.results[0]?.stack).toBeUndefined();

    const histogram = await get<Histogram>('/buckets?q=IMG_1.JPG&stack=1');
    expect(histogram.buckets).toEqual([{ year: 2024, month: 6, count: 1 }]);
  });

  it('a filter both halves match still folds the pair', async () => {
    const page = await get<Page>('/?q=IMG_1&stack=1');
    expect(page.total).toBe(1);
    expect(filenames(page)).toEqual(['IMG_1.CR3']);
    expect(page.results[0]?.stack?.companion).toMatchObject({ id: jpeg });
  });

  it('the map keeps the pin of a JPEG whose RAW has no GPS', async () => {
    const { cells } = await get<{ cells: Array<{ count: number }> }>(
      '/clusters?bbox=-74,42,-73,43&zoom=10&stack=1',
    );
    expect(cells.map((cell) => cell.count)).toEqual([1]);
  });

  it('a ranked text search serves the stack at its best rank, as the RAW with its JPEG', async () => {
    setInProcessSearchForTests(fakeInProcessSearch(['jpeg', 'lone', 'raw']));

    const page = await get<Page>('/?placeQuery=harbour&stack=1');

    expect(page.total).toBe(2);
    expect(filenames(page)).toEqual(['IMG_1.CR3', 'IMG_2.JPG']);
    expect(page.results[0]?.stack?.companion).toMatchObject({ id: jpeg, name: 'IMG_1.JPG' });
  });

  it('a ranked map search keeps the pin of a ranked JPEG whose RAW has no GPS', async () => {
    setInProcessSearchForTests(fakeInProcessSearch(['jpeg', 'lone', 'raw']));

    const { cells } = await get<{ cells: Array<{ count: number }> }>(
      '/clusters?bbox=-74,42,-73,43&zoom=10&placeQuery=harbour&stack=1',
    );

    expect(cells.map((cell) => cell.count)).toEqual([1]);
  });

  it('a ranked map search counts a stack whose halves both have GPS once', async () => {
    run(
      live.db,
      `UPDATE assets SET exif = json_set(coalesce(exif, '{}'), '$.gps', json(?)) WHERE id = ?`,
      JSON.stringify({ lat: 42.65, lng: -73.75 }),
      raw,
    );
    setInProcessSearchForTests(fakeInProcessSearch(['jpeg', 'lone', 'raw']));

    const { cells } = await get<{ cells: Array<{ count: number }> }>(
      '/clusters?bbox=-74,42,-73,43&zoom=10&placeQuery=harbour&stack=1',
    );

    expect(cells.map((cell) => cell.count)).toEqual([1]);
  });

  it('a scope the RAW is not in keeps the JPEG reached through another location', async () => {
    const elsewhere = insertFolder(live.db, { slug: 'elsewhere', path: '/other' });
    insertLocation(live.db, {
      assetId: jpeg,
      libraryId: elsewhere,
      ordinal: 1,
      path: 'copies',
      filename: 'IMG_1.JPG',
    });
    await reconcileRawJpegStacks(new ObjectId(libraryId), 'trip');
    expect(
      live.db.query('SELECT stack_primary_id AS p FROM assets WHERE id = ?').get(jpeg),
    ).toEqual({ p: raw });

    for (const scope of [`libraryId=${elsewhere}`, 'pathPrefix=copies']) {
      const page = await get<Page>(`/?${scope}&stack=1`);
      expect(filenames(page)).toEqual(['IMG_1.JPG']);
      expect(page.total).toBe(1);
    }
  });

  it('a ranked text search keeps a JPEG whose RAW did not rank', async () => {
    setInProcessSearchForTests(fakeInProcessSearch(['jpeg', 'lone']));

    const page = await get<Page>('/?placeQuery=harbour&stack=1');

    expect(page.total).toBe(2);
    expect(filenames(page)).toEqual(['IMG_1.JPG', 'IMG_2.JPG']);
    expect(page.results[0]?.stack).toBeUndefined();
  });

  it('a hidden RAW hides its stack from a ranked search and its map, whether or not it ranked', async () => {
    run(live.db, 'UPDATE assets SET hidden = 1 WHERE id = ?', raw);
    expect(filenames(await get<Page>('/?stack=1'))).toEqual(['IMG_2.JPG']);

    // Both engines: the in-process child (RAW ranked, RAW not ranked) and the database's FTS.
    for (const ranked of [['jpeg', 'lone', 'raw'], ['jpeg', 'lone'], null]) {
      setInProcessSearchForTests(fakeInProcessSearch(ranked));
      _resetCacheForTests();
      const page = await get<Page>('/?placeQuery=harbour&stack=1');
      expect(filenames(page)).toEqual(['IMG_2.JPG']);
      expect(page.total).toBe(1);
      const { cells } = await get<{ cells: unknown[] }>(
        '/clusters?bbox=-74,42,-73,43&zoom=10&placeQuery=harbour&stack=1',
      );
      expect(cells).toEqual([]);
    }

    // Without stack=1 the visible JPEG is an ordinary result.
    setInProcessSearchForTests(fakeInProcessSearch(['jpeg', 'lone', 'raw']));
    expect(filenames(await get<Page>('/?placeQuery=harbour'))).toEqual(['IMG_1.JPG', 'IMG_2.JPG']);
  });
});

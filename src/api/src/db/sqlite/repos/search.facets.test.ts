/**
 * The twelve facet aggregations, against the shared fixture library.
 *
 * Two questions per facet: does it bucket the right assets, and does it apply
 * the search's own filters? The second is what makes a faceted UI usable —
 * "cameras within the current scope" rather than the global universe — and it
 * is the half a `GROUP BY` that forgot the `WHERE` still passes the first
 * question on.
 */

import { describe, expect, test } from 'bun:test';
import { createTestDatabase, testSqliteDb } from '../test-sqlite.test-helpers.ts';
import { searchFacets } from './search.facets.ts';
import { buildSearchWhere, type SearchWhere } from './search.where.ts';
import { seedSearchLibrary, type SeededLibrary } from './search.test-helpers.ts';
import type { SearchQuery } from '../../../routes/search/query-schema.ts';

/** The translated query, or a thrown assertion — tests never expect a 400. */
function where(q: SearchQuery): SearchWhere {
  const built = buildSearchWhere(q);
  if ('error' in built) throw new Error(`unexpected validation error: ${built.error}`);
  return built;
}

/** Bucket counts as a plain object, so an assertion reads as a table. */
function counts(buckets: Array<{ value: string; count: number }>): Record<string, number> {
  return Object.fromEntries(buckets.map((bucket) => [bucket.value, bucket.count]));
}

async function withLibrary<T>(
  body: (
    run: (q: SearchQuery) => Promise<Awaited<ReturnType<typeof searchFacets>>>,
    library: SeededLibrary,
  ) => Promise<T>,
): Promise<T> {
  using handle = await createTestDatabase();
  const library = seedSearchLibrary(handle.db);
  const db = testSqliteDb(handle.db);
  // Awaited, not returned: `using` disposes when this function returns, and
  // returning the promise un-awaited closes the database out from under a body
  // that has more than one query to run.
  return await body((q) => searchFacets(where(q), db), library);
}

describe('searchFacets — the unfiltered library', () => {
  test('counts every live, visible asset and nothing else', async () => {
    await withLibrary(async (facets) => {
      const result = await facets({});
      // Nine visible: the tenth live asset is hidden, and three more are
      // soft-deleted, replaced in place, or missing from disk.
      expect(result.total).toBe(9);
    });
  });

  test('groups cameras by make and model, most common first', async () => {
    await withLibrary(async (facets) => {
      const { cameras } = await facets({});
      expect(cameras[0]).toEqual({ make: 'Apple', model: 'iPhone 15 Pro', count: 2 });
      expect(cameras).toContainEqual({ make: 'SONY', model: 'ILCE-7RM5', count: 1 });
      // The hidden Canon frame is out; the visible one is in.
      expect(cameras).toContainEqual({ make: 'Canon', model: 'EOS R5', count: 1 });
      expect(cameras.reduce((sum, row) => sum + row.count, 0)).toBe(9);
    });
  });

  test('keeps the null lens bucket, as the Mongo pipeline does', async () => {
    await withLibrary(async (facets) => {
      const { lenses } = await facets({});
      expect(lenses.some((row) => row.value === null)).toBe(true);
      expect(lenses.reduce((sum, row) => sum + row.count, 0)).toBe(9);
    });
  });

  test('derives extensions from the canonical filename', async () => {
    await withLibrary(async (facets) => {
      const { extensions } = await facets({});
      expect(counts(extensions)).toEqual({ dng: 5, jpg: 1, tif: 1, png: 1, mp4: 1 });
    });
  });

  test('reports the ISO and capture ranges over the matching set', async () => {
    await withLibrary(async (facets) => {
      const result = await facets({});
      expect(result.iso_range).toEqual({ min: 100, max: 3200 });
      expect(result.capture_range).toEqual({
        from: '2021-12-25T12:00:00.000Z',
        to: '2024-06-02T12:00:00.000Z',
      });
    });
  });

  test('groups the two vision facets and the subject array', async () => {
    await withLibrary(async (facets) => {
      const result = await facets({});
      expect(counts(result.scene_types)).toEqual({ outdoor: 2, indoor: 1, aerial: 1, macro: 1 });
      expect(counts(result.activities)).toEqual({ sailing: 1, cooking: 1 });
      expect(counts(result.subjects)).toEqual({
        boat: 1,
        water: 1,
        bread: 1,
        bridge: 1,
        flower: 1,
      });
    });
  });

  test('labels places as "locality, region" and orders by count', async () => {
    await withLibrary(async (facets) => {
      const { places } = await facets({});
      expect(places[0]).toEqual({ value: 'Albany, New York', count: 2 });
      expect(counts(places)).toEqual({
        'Albany, New York': 2,
        'New York City, New York': 1,
        'Kyoto, Kansai': 1,
      });
    });
  });

  test('counts assets per person, not faces', async () => {
    await withLibrary(async (facets, library) => {
      const { people } = await facets({});
      const byId = Object.fromEntries(people.map((row) => [row.id, row.count]));
      expect(byId[library.people.get('Ada')!]).toBe(2);
      expect(byId[library.people.get('Grace')!]).toBe(2);
    });
  });

  test('reports the screenshot split with an always-zero unknown bucket', async () => {
    await withLibrary(async (facets) => {
      const result = await facets({});
      // The column is NOT NULL DEFAULT 0, so "never classified" is indexed as
      // false and the third state cannot be reported. See #3761.
      expect(result.is_screenshot).toEqual({ true: 1, false: 8, unknown: 0 });
    });
  });
});

describe('searchFacets — scoped to the current search', () => {
  test('a camera filter narrows every other facet with it', async () => {
    await withLibrary(async (facets) => {
      const result = await facets({ camera: 'iPhone 15' });
      expect(result.total).toBe(2);
      expect(counts(result.extensions)).toEqual({ dng: 1, jpg: 1 });
      expect(counts(result.places)).toEqual({ 'Albany, New York': 2 });
      expect(result.iso_range).toEqual({ min: 100, max: 800 });
    });
  });

  test('a place label round-trips through its own filter', async () => {
    await withLibrary(async (facets) => {
      const unfiltered = await facets({});
      const label = unfiltered.places[0]!;
      const scoped = await facets({ place: label.value });
      expect(scoped.total).toBe(label.count);
      expect(counts(scoped.places)).toEqual({ [label.value]: label.count });
    });
  });

  test('hidden=only inverts the default visibility filter', async () => {
    await withLibrary(async (facets) => {
      const result = await facets({ hidden: 'only' });
      expect(result.total).toBe(1);
      expect(result.cameras).toEqual([{ make: 'Canon', model: 'EOS R5', count: 1 }]);
    });
  });

  test('a full-text query narrows the facets to the matching assets', async () => {
    await withLibrary(async (facets) => {
      const result = await facets({ placeQuery: 'lanterns' });
      expect(result.total).toBe(1);
      expect(counts(result.places)).toEqual({ 'Kyoto, Kansai': 1 });
      expect(counts(result.extensions)).toEqual({ dng: 1 });
    });
  });

  test('a date window narrows the capture range to itself', async () => {
    await withLibrary(async (facets) => {
      const result = await facets({ from: '2024-01-01', to: '2024-12-31' });
      expect(result.total).toBe(4);
      expect(result.capture_range?.from.startsWith('2024-02')).toBe(true);
      expect(result.capture_range?.to.startsWith('2024-06')).toBe(true);
    });
  });
});

describe('searchFacets — person filters', () => {
  test('narrows to the assets showing the requested person', async () => {
    using handle = await createTestDatabase();
    const library = seedSearchLibrary(handle.db);
    const db = testSqliteDb(handle.db);
    const ada = library.people.get('Ada')!;

    const built = buildSearchWhere({}, [], [ada]);
    if ('error' in built) throw new Error(built.error);
    const result = await searchFacets(built, db);
    expect(result.total).toBe(2);
    expect(result.people.find((row) => row.id === ada)?.count).toBe(2);
  });

  test('drops every asset showing an excluded person', async () => {
    using handle = await createTestDatabase();
    const library = seedSearchLibrary(handle.db);
    const db = testSqliteDb(handle.db);
    const ada = library.people.get('Ada')!;

    const built = buildSearchWhere({}, [ada], null);
    if ('error' in built) throw new Error(built.error);
    const result = await searchFacets(built, db);
    // Both of Ada's photos go, including the one she shares with Grace.
    expect(result.total).toBe(7);
    expect(result.people.some((row) => row.id === ada)).toBe(false);
  });

  test('a people filter naming nobody matches nothing, not everything', async () => {
    using handle = await createTestDatabase();
    seedSearchLibrary(handle.db);
    const db = testSqliteDb(handle.db);

    const built = buildSearchWhere({}, [], []);
    if ('error' in built) throw new Error(built.error);
    const result = await searchFacets(built, db);
    expect(result.total).toBe(0);
    expect(result.cameras).toEqual([]);
  });
});

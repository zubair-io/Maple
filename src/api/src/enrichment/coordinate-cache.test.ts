/**
 * `CoordinateCache` — the quantisation arithmetic, and the round trip through
 * the `geocode_cache` table.
 *
 * The class reaches storage with no database override, the way production does,
 * so these use `createLiveTestDatabase()` — it installs the test's own database
 * as the process-wide handle for the block. The repository functions underneath
 * have their own tests in `db/sqlite/repos/geocode-cache.repo.test.ts`; what is
 * worth checking here is that the key the class computes is the key it stores
 * under, and that its injectable clock still reaches the stored row.
 */

import { describe, it, expect } from 'bun:test';
import { CoordinateCache, quantize, quantizedKey } from './coordinate-cache.ts';
import type { Place } from '../db/schema.ts';
import { createLiveTestDatabase } from '../db/sqlite/test-sqlite.test-helpers.ts';

describe('quantize / quantizedKey — pure logic', () => {
  it('rounds to 4 decimal places by default', () => {
    expect(quantize(42.65261234, 4)).toBe(42.6526);
    expect(quantize(-73.75624999, 4)).toBe(-73.7562);
  });

  it("does not banker's-round at the .5 boundary", () => {
    // Math.round(...) rounds away from zero on positive halves; document the
    // contract so a test catches a regression to Number.toFixed.
    expect(quantize(0.00005, 4)).toBe(0.0001);
  });

  it('emits the documented key format', () => {
    expect(quantizedKey(42.6526, -73.7562)).toBe('lat:42.6526,lon:-73.7562');
  });

  it('collapses two coordinates within ~11m to the same key', () => {
    // Both lat values round to 42.6526 (0..0.5 below the next 4dp step).
    const a = quantizedKey(42.6526321, -73.7562109);
    const b = quantizedKey(42.6526111, -73.7562444);
    expect(a).toBe(b);
  });
});

describe('CoordinateCache — round-trip', () => {
  it('get() returns null on a cache miss', async () => {
    using live = await createLiveTestDatabase();
    const cache = new CoordinateCache({ geocoderVersion: 1 });
    expect(await cache.get(42.6526, -73.7562)).toBeNull();
  });

  it('set() then get() returns the same Place', async () => {
    using live = await createLiveTestDatabase();
    const cache = new CoordinateCache({ geocoderVersion: 1 });
    const place = makePlace();
    await cache.set(42.6526, -73.7562, place);
    expect(await cache.get(42.6526, -73.7562)).toEqual(place);
  });

  it('set() upserts on the quantised key, not the raw coords', async () => {
    using live = await createLiveTestDatabase();
    const cache = new CoordinateCache({ geocoderVersion: 1 });
    // Both pairs round to (42.6526, -73.7562).
    await cache.set(42.65261234, -73.75623456, makePlace());
    const place2 = { ...makePlace(), display_name: 'Updated' };
    await cache.set(42.65264111, -73.75618901, place2);
    const out = await cache.get(42.6526, -73.7562);
    expect(out!.display_name).toBe('Updated');

    // Only one row for this quantised key.
    const rows = live.db
      .query(`SELECT COUNT(*) AS n FROM geocode_cache WHERE id = ?`)
      .all(cache.keyFor(42.6526, -73.7562)) as Array<{ n: number }>;
    expect(rows[0]!.n).toBe(1);
  });

  it('treats a stale geocoderVersion as a miss', async () => {
    using live = await createLiveTestDatabase();
    const v1Cache = new CoordinateCache({ geocoderVersion: 1 });
    await v1Cache.set(42.6526, -73.7562, makePlace());
    const v2Cache = new CoordinateCache({ geocoderVersion: 2 });
    expect(await v2Cache.get(42.6526, -73.7562)).toBeNull();
  });

  it('set() at v2 overwrites the v1 row', async () => {
    using live = await createLiveTestDatabase();
    const v1Cache = new CoordinateCache({ geocoderVersion: 1 });
    await v1Cache.set(42.6526, -73.7562, makePlace());
    const v2Place = { ...makePlace(), geocoder_version: 2 };
    const v2Cache = new CoordinateCache({ geocoderVersion: 2 });
    await v2Cache.set(42.6526, -73.7562, v2Place);
    expect(await v2Cache.get(42.6526, -73.7562)).toEqual(v2Place);
    // The v1 read still treats the row as a miss because the stored
    // geocoder_version is now 2.
    expect(await v1Cache.get(42.6526, -73.7562)).toBeNull();
  });

  it('records fetched_at from the injected clock on set()', async () => {
    using live = await createLiveTestDatabase();
    const fixed = new Date('2026-05-08T13:00:00.000Z');
    const cache = new CoordinateCache({ geocoderVersion: 1, now: () => fixed });
    await cache.set(42.6526, -73.7562, makePlace());
    const rows = live.db
      .query(`SELECT fetched_at FROM geocode_cache WHERE id = ?`)
      .all(cache.keyFor(42.6526, -73.7562)) as Array<{ fetched_at: string }>;
    expect(rows[0]!.fetched_at).toBe(fixed.toISOString());
  });
});

function makePlace(): Place {
  return {
    source: 'nominatim',
    geocoder_version: 1,
    geocoded_at: '2026-05-08T11:59:00.000Z',
    lat: 42.6526,
    lon: -73.7562,
    display_name: 'New York State Museum',
    address: { city: 'Albany', state: 'New York', state_code: 'NY' },
    pois: [{ name: 'New York State Museum', category: 'tourism', type: 'museum' }],
    rollups: { locality: 'Albany', region: 'New York', country_code: 'us' },
    search_blob: '',
  };
}

/**
 * `geocode_cache` behaviour through the repository.
 *
 * The cases that matter are the ones where the two readers disagree: the
 * worker's version-checked read has to treat a stale entry as a miss so a
 * parser upgrade re-fetches, and the device-facing route's read has to hand the
 * same stale entry back because a slightly old address still names the right
 * folder.
 *
 * The key is opaque text here — the quantisation that produces it is pure
 * arithmetic covered by `enrichment/coordinate-cache.test.ts`, and it stays in
 * that module after the cutover.
 */

import { describe, expect, test } from 'bun:test';
import type { Place } from '../../schema.ts';
import { createTestDatabase, testSqliteDb } from '../test-sqlite.test-helpers.ts';
import { findCachedPlace, getCachedPlace, setCachedPlace } from './geocode-cache.repo.ts';

const KEY = 'lat:42.6526,lon:-73.7562';

function place(overrides: Partial<Place> = {}): Place {
  return {
    source: 'nominatim',
    geocoder_version: 1,
    geocoded_at: '2026-04-01T10:00:00.000Z',
    lat: 42.6526,
    lon: -73.7562,
    display_name: 'Albany, New York',
    address: { city: 'Albany', state: 'New York', country_code: 'us' },
    pois: [],
    rollups: { locality: 'Albany', region: 'New York', country_code: 'us' },
    search_blob: 'albany new york',
    ...overrides,
  };
}

describe('getCachedPlace', () => {
  test('misses on a key nothing has written', async () => {
    using handle = await createTestDatabase();
    expect(await getCachedPlace(KEY, 1, testSqliteDb(handle.db))).toBeNull();
  });

  test('round-trips the whole Place', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const stored = place();
    await setCachedPlace(KEY, stored, 1, undefined, db);
    expect(await getCachedPlace(KEY, 1, db)).toEqual(stored);
  });

  test('reads an entry written by a different geocoder version as a miss', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    await setCachedPlace(KEY, place(), 1, undefined, db);
    expect(await getCachedPlace(KEY, 2, db)).toBeNull();
  });
});

describe('setCachedPlace', () => {
  test('overwrites in place rather than accumulating rows', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    await setCachedPlace(KEY, place({ display_name: 'first' }), 1, undefined, db);
    await setCachedPlace(KEY, place({ display_name: 'second' }), 1, undefined, db);

    expect((await getCachedPlace(KEY, 1, db))?.display_name).toBe('second');
    const rows = await db.read<{ n: number }>(`SELECT COUNT(*) AS n FROM geocode_cache`);
    expect(rows[0]?.n).toBe(1);
  });

  test('a re-fetch after a version bump replaces the stale entry', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    await setCachedPlace(KEY, place({ display_name: 'old parser' }), 1, undefined, db);
    expect(await getCachedPlace(KEY, 2, db)).toBeNull();

    await setCachedPlace(KEY, place({ display_name: 'new parser' }), 2, undefined, db);
    expect((await getCachedPlace(KEY, 2, db))?.display_name).toBe('new parser');
  });

  test('stamps fetched_at so an entry carries its own provenance', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const before = new Date().toISOString();
    await setCachedPlace(KEY, place(), 1, undefined, db);
    const rows = await db.read<{ fetched_at: string }>(
      `SELECT fetched_at FROM geocode_cache WHERE id = ?`,
      [KEY],
    );
    expect(rows[0]!.fetched_at >= before).toBe(true);
  });

  test('takes the instant when the caller owns a clock', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    // `CoordinateCache` injects `now` so its own test can pin the value; the
    // parameter is what lets that keep working after the cutover.
    await setCachedPlace(KEY, place(), 1, '2026-01-01T00:00:00.000Z', db);
    const rows = await db.read<{ fetched_at: string }>(
      `SELECT fetched_at FROM geocode_cache WHERE id = ?`,
      [KEY],
    );
    expect(rows[0]!.fetched_at).toBe('2026-01-01T00:00:00.000Z');
  });
});

describe('findCachedPlace', () => {
  test('returns an entry whatever version wrote it', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    await setCachedPlace(KEY, place({ display_name: 'Albany' }), 1, undefined, db);
    // The route deliberately does not check the version: a stale address is
    // still good enough to pick a destination folder.
    expect((await findCachedPlace(KEY, db))?.display_name).toBe('Albany');
  });

  test('still misses on a key nothing has written', async () => {
    using handle = await createTestDatabase();
    expect(await findCachedPlace(KEY, testSqliteDb(handle.db))).toBeNull();
  });
});

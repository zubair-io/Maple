/**
 * GET /api/geocode/reverse — the device-facing read of the geocode cache.
 *
 * Real SQLite, installed as the process-wide handle for each test, because the
 * route reaches `sqliteDb()` with no override. The one fixture row is written
 * through `setCachedPlace` rather than by hand, so the row this suite reads is
 * the row the geocode worker would actually have left behind.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { Elysia } from 'elysia';
import { quantizedKey } from '../src/enrichment/coordinate-cache.ts';
import { setCachedPlace } from '../src/db/repos/geocode-cache.repo.ts';
import { geocodeReverseRoutes } from '../src/routes/geocode-reverse.ts';
import {
  createLiveTestDatabase,
  type LiveTestDatabase,
} from '../src/db/sqlite/test-sqlite.test-helpers.ts';
import type { Place } from '../src/db/schema.ts';

const app = new Elysia().use(geocodeReverseRoutes);

const TOKYO_STATION: Place = {
  source: 'nominatim',
  geocoder_version: 1,
  geocoded_at: '2026-05-08T12:00:00.000Z',
  lat: 35.6801,
  lon: 139.6901,
  display_name: 'Tokyo Station, Chiyoda, Tokyo, Japan',
  address: { city: 'Tokyo', country: 'Japan', country_code: 'jp' },
  pois: [{ name: 'Tokyo Station', category: 'public_transport', type: 'station' }],
  rollups: { locality: 'Tokyo', region: 'Tokyo', country_code: 'jp' },
  search_blob: 'tokyo station tokyo japan',
};

let live: LiveTestDatabase;

beforeAll(async () => {
  live = await createLiveTestDatabase();
  // Seeded at the default precision of 4. The custom-precision test asks for
  // precision 2, which quantises to a different key —
  // `lat:35.6801,lon:139.6901` vs `lat:35.68,lon:139.69` — so it genuinely
  // misses rather than reading this row through a looser key.
  await setCachedPlace(quantizedKey(35.6801, 139.6901), TOKYO_STATION, 1);
});

afterAll(() => {
  live.close();
});

describe('GET /api/geocode/reverse', () => {
  test('returns the cached Place when present', async () => {
    const res = await app.handle(
      new Request('http://localhost/api/geocode/reverse?lat=35.6801&lon=139.6901'),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.place.pois[0].name).toBe('Tokyo Station');
    expect(body.place.rollups.locality).toBe('Tokyo');
  });

  test('returns 404 when no cache row matches', async () => {
    const res = await app.handle(new Request('http://localhost/api/geocode/reverse?lat=0&lon=0'));
    expect(res.status).toBe(404);
  });

  test('rejects missing params with 400', async () => {
    const res = await app.handle(new Request('http://localhost/api/geocode/reverse?lat=35.68'));
    expect(res.status).toBe(400);
  });

  test('accepts custom precision', async () => {
    const res = await app.handle(
      new Request('http://localhost/api/geocode/reverse?lat=35.6801&lon=139.6901&precision=2'),
    );
    expect(res.status).toBe(404);
  });

  test('?precision=2.5 (non-integer) → 400', async () => {
    const res = await app.handle(
      new Request('http://localhost/api/geocode/reverse?lat=35.6801&lon=139.6901&precision=2.5'),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('precision');
  });
});

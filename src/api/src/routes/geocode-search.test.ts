/**
 * Unit tests for GET /api/geocode/search.
 *
 * Uses mock NominatimClient instances to avoid real HTTP calls.
 */

import { describe, test, expect, beforeAll, beforeEach, afterAll, afterEach } from 'bun:test';
import type { NominatimClient } from '../enrichment/nominatim-client.ts';
import { setGeocodeSearchClientForTests } from './geocode-search.ts';
import type { NominatimSearchResult } from '../enrichment/nominatim-client.ts';

// The handler reads enrichment config from Mongo (loadEnrichmentConfig).
// Isolate the shared db-client singleton to a unique test DB and reset it
// around this file so it neither connects to the real `maple` DB nor leaks the
// connection into later test files (convention from folder.test.ts).
process.env.MAPLE_MONGO_DB = `maple_test_geocode_search_${process.pid}`;
beforeAll(async () => {
  await (await import('../db/client.ts')).closeDb();
});
afterAll(async () => {
  await (await import('../db/client.ts')).closeDb();
});

// ---------------------------------------------------------------------------
// Mock client factory
// ---------------------------------------------------------------------------

const SAMPLE_RESULTS: NominatimSearchResult[] = [
  {
    place_id: 1,
    display_name: 'Paris, Île-de-France, France',
    lat: '48.8566',
    lon: '2.3522',
    address: { city: 'Paris', country: 'France', country_code: 'fr' },
  },
  {
    place_id: 2,
    display_name: 'Paris, TX, USA',
    lat: '33.6609',
    lon: '-95.5555',
    address: { city: 'Paris', state: 'Texas', country: 'USA' },
  },
];

function makeMockClient(opts: {
  searchResult?: NominatimSearchResult[];
  searchError?: Error;
}): NominatimClient {
  return {
    search: async (_q: string, _limit?: number) => {
      if (opts.searchError) throw opts.searchError;
      return opts.searchResult ?? [];
    },
  } as unknown as NominatimClient;
}

// Avoid the Elysia route overhead by testing the route logic via the
// exported handler indirectly (inject mock client, call via fetch).
// For simplicity, test the module logic directly.

// ---------------------------------------------------------------------------
// Import the mapping function directly by testing the NominatimClient.search
// interface and asserting the route's expected response shape.
// ---------------------------------------------------------------------------

// We test this by calling the route through Elysia.
import { geocodeSearchRoutes } from './geocode-search.ts';
import { Elysia } from 'elysia';

const app = new Elysia().use(geocodeSearchRoutes);

beforeEach(() => {
  // Reset the client before each test.
  setGeocodeSearchClientForTests(null);
});

afterEach(() => {
  setGeocodeSearchClientForTests(null);
});

describe('GET /api/geocode/search', () => {
  test('returns 400 when q is missing', async () => {
    setGeocodeSearchClientForTests(makeMockClient({ searchResult: [] }));
    const res = await app.handle(new Request('http://localhost/api/geocode/search'));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/q is required/i);
  });

  test('returns 400 when q is empty string', async () => {
    setGeocodeSearchClientForTests(makeMockClient({ searchResult: [] }));
    const res = await app.handle(new Request('http://localhost/api/geocode/search?q='));
    expect(res.status).toBe(400);
  });

  test('returns 503 when client not configured (null)', async () => {
    // Client left as null → not configured
    const res = await app.handle(new Request('http://localhost/api/geocode/search?q=Paris'));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toMatch(/not configured/i);
  });

  test('returns suggestions array on success', async () => {
    setGeocodeSearchClientForTests(makeMockClient({ searchResult: SAMPLE_RESULTS }));
    const res = await app.handle(new Request('http://localhost/api/geocode/search?q=Paris'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.suggestions)).toBe(true);
    expect(body.suggestions).toHaveLength(2);
    expect(body.suggestions[0].displayName).toBe('Paris, Île-de-France, France');
    expect(body.suggestions[0].lat).toBeCloseTo(48.8566, 3);
    expect(body.suggestions[0].lon).toBeCloseTo(2.3522, 3);
    expect(body.suggestions[0].address).toMatchObject({ city: 'Paris', country: 'France' });
  });

  test('returns empty suggestions when Nominatim finds nothing', async () => {
    setGeocodeSearchClientForTests(makeMockClient({ searchResult: [] }));
    const res = await app.handle(new Request('http://localhost/api/geocode/search?q=xyzxyzxyz'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.suggestions).toEqual([]);
  });

  test('returns 503 on retryable Nominatim error', async () => {
    const { NominatimError } = await import('../enrichment/nominatim-client.ts');
    setGeocodeSearchClientForTests(
      makeMockClient({ searchError: new NominatimError('Nominatim 5xx: 503', true, 503) }),
    );
    const res = await app.handle(new Request('http://localhost/api/geocode/search?q=Paris'));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toMatch(/Geocode search failed/i);
  });

  test('returns 502 on non-retryable Nominatim error', async () => {
    const { NominatimError } = await import('../enrichment/nominatim-client.ts');
    setGeocodeSearchClientForTests(
      makeMockClient({ searchError: new NominatimError('Nominatim 4xx: 400', false, 400) }),
    );
    const res = await app.handle(new Request('http://localhost/api/geocode/search?q=Paris'));
    expect(res.status).toBe(502);
  });

  test('rejects q longer than 500 chars', async () => {
    setGeocodeSearchClientForTests(makeMockClient({ searchResult: [] }));
    const longQ = 'a'.repeat(501);
    const res = await app.handle(
      new Request(`http://localhost/api/geocode/search?q=${encodeURIComponent(longQ)}`),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/maximum length/i);
  });
});

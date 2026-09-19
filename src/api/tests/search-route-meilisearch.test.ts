/**
 * Tests the Meilisearch fast-path on /api/search?placeQuery=...
 *
 * Mocks `meilisearchClient()` via `setMeilisearchClientForTests` rather than
 * running a real Meilisearch instance. The database remains the source of
 * truth: Meilisearch returns ids, the route fetches the same asset rows from
 * the test database, and the test asserts the order Meilisearch dictated.
 *
 * Real SQLite, installed as the process-wide handle for the file.
 *
 * Reference: `docs/indexer-enrichment.md` §5.5 and the Phase 7 brief.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from 'bun:test';
import { Elysia } from 'elysia';
import { signAccessToken } from '../src/auth/tokens.ts';
import {
  setMeilisearchClientForTests,
  type MeilisearchClient,
  type MeilisearchSearchOptions,
  type MeilisearchSearchResult,
} from '../src/enrichment/meilisearch-client.ts';
import { seedSearchAsset } from '../src/db/repos/search.test-helpers.ts';
import {
  createLiveTestDatabase,
  insertFolder,
  type LiveTestDatabase,
} from '../src/db/sqlite/test-sqlite.test-helpers.ts';

process.env.MAPLE_JWT_SECRET = 'x'.repeat(32);
const SECRET = process.env.MAPLE_JWT_SECRET!;
const BEARER =
  'Bearer ' +
  (await signAccessToken(
    {
      sub: '00000000000000000000000a',
      email: 'tester@maple.local',
      role: 'owner',
      file_access: true,
    },
    SECRET,
  ));

const PRIOR_MEILI_URL = process.env.MAPLE_MEILISEARCH_URL;

function fmtAuth(): Record<string, string> {
  return { Authorization: BEARER };
}

let live: LiveTestDatabase;
let folder: string;

interface MockMeili extends MeilisearchClient {
  configured: boolean;
  searchImpl: (q: string, opts: MeilisearchSearchOptions) => Promise<MeilisearchSearchResult>;
  searchCalls: Array<{ q: string; opts: MeilisearchSearchOptions }>;
}

function makeMockMeili(impl: MockMeili['searchImpl']): MockMeili {
  const calls: MockMeili['searchCalls'] = [];
  return {
    configured: true,
    searchImpl: impl,
    searchCalls: calls,
    isConfigured: () => true,
    semanticConfigured: () => false,
    health: async () => true,
    ensureIndex: async () => {},
    upsert: async () => {},
    upsertOrThrow: async () => {},
    tombstone: async () => {},
    search: async (q, opts = {}) => {
      calls.push({ q, opts });
      return impl(q, opts);
    },
  };
}

beforeAll(async () => {
  live = await createLiveTestDatabase();
  // One library at `/lib` so `abs_path` comes back as `/lib/<name>`.
  folder = insertFolder(live.db, { path: '/lib', slug: 'lib' });

  seedSearchAsset(live.db, folder, {
    filename: 'albany-museum.dng',
    path: '',
    mapleId: 'maple-albany',
    rating: 5,
    flag: 1,
    capturedAt: '2024-06-01T12:00:00.000Z',
    cameraMake: 'Sony',
    cameraModel: 'A7R V',
    lens: 'FE 24-70mm',
    iso: 200,
    aperture: 4.0,
    focalLength: 35,
    gps: { lat: 42.65, lng: -73.75 },
    placeDoc: {
      source: 'nominatim',
      geocoder_version: 1,
      geocoded_at: '2026-05-08T00:00:00.000Z',
      lat: 42.65,
      lon: -73.75,
      display_name: 'New York State Museum, Albany',
      address: { city: 'Albany', state: 'New York', state_code: 'NY' },
      pois: [{ name: 'New York State Museum', category: 'tourism', type: 'museum' }],
      rollups: { locality: 'Albany', region: 'New York', country_code: 'us' },
      search_blob: 'albany ny museum new york state',
    },
    searchBlob: 'albany ny museum new york state',
  });

  seedSearchAsset(live.db, folder, {
    filename: 'nyc-park.dng',
    path: '',
    mapleId: 'maple-nyc',
    rating: 4,
    capturedAt: '2024-07-01T12:00:00.000Z',
    cameraMake: 'Sony',
    cameraModel: 'A7R V',
    lens: 'FE 24-70mm',
    iso: 200,
    aperture: 4.0,
    focalLength: 35,
    gps: { lat: 40.78, lng: -73.96 },
    placeDoc: {
      source: 'nominatim',
      geocoder_version: 1,
      geocoded_at: '2026-05-08T00:00:00.000Z',
      lat: 40.78,
      lon: -73.96,
      display_name: 'Central Park, New York',
      address: { city: 'New York', state: 'New York', state_code: 'NY' },
      pois: [{ name: 'Central Park', category: 'leisure', type: 'park' }],
      rollups: { locality: 'New York', region: 'New York', country_code: 'us' },
      search_blob: 'new york ny park central',
    },
    searchBlob: 'new york ny park central',
  });
});

beforeEach(async () => {
  const { _resetBucketsCacheForTests, _resetCacheForTests } =
    await import('../src/routes/search.ts');
  _resetBucketsCacheForTests();
  // The list route's `total` cache (#2128) is module-scoped for the process
  // lifetime — without this, a different test file's `total` for the same
  // query-param shape (e.g. an identical placeQuery string) could leak in
  // here, or this file's own results could leak into a later file.
  _resetCacheForTests();
});

afterEach(() => {
  setMeilisearchClientForTests(null);
});

afterAll(() => {
  live.close();
  if (PRIOR_MEILI_URL === undefined) delete process.env.MAPLE_MEILISEARCH_URL;
  else process.env.MAPLE_MEILISEARCH_URL = PRIOR_MEILI_URL;
});

describe('/api/search?placeQuery — Meilisearch path', () => {
  it('falls back to the database when the client is unconfigured', async () => {
    // No mock injected — the singleton's isConfigured() returns false
    // because MAPLE_MEILISEARCH_URL is unset in this suite.
    delete process.env.MAPLE_MEILISEARCH_URL;
    setMeilisearchClientForTests(null);
    const { searchRoutes } = await import('../src/routes/search.ts');
    const { requireAuth } = await import('../src/auth/middleware.ts');
    const app = new Elysia().use(requireAuth).use(searchRoutes);

    const r = await app.handle(
      new Request('http://localhost/api/search?placeQuery=Albany', {
        headers: fmtAuth(),
      }),
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      total: number;
      results: Array<{ filename: string }>;
    };
    expect(body.total).toBeGreaterThanOrEqual(1);
    expect(body.results[0]!.filename).toBe('albany-museum.dng');
  });

  it('uses Meilisearch when configured, returning ids in Meili order', async () => {
    // Meilisearch returns NYC first, Albany second — opposite of the
    // relevance order the database would produce, so the ordering proves
    // which path served the request.
    const mock = makeMockMeili(async () => ({
      ids: ['maple-nyc', 'maple-albany'],
      estimatedTotal: 2,
    }));
    setMeilisearchClientForTests(mock);

    const { searchRoutes } = await import('../src/routes/search.ts');
    const { requireAuth } = await import('../src/auth/middleware.ts');
    const app = new Elysia().use(requireAuth).use(searchRoutes);

    const r = await app.handle(
      new Request('http://localhost/api/search?placeQuery=NY', {
        headers: fmtAuth(),
      }),
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      total: number;
      results: Array<{ filename: string }>;
    };
    expect(body.total).toBe(2);
    expect(body.results.map((r) => r.filename)).toEqual(['nyc-park.dng', 'albany-museum.dng']);

    // The route should have called Meili exactly once with the trimmed
    // query and the route's pagination defaults.
    expect(mock.searchCalls.length).toBe(1);
    expect(mock.searchCalls[0]!.q).toBe('NY');
    expect(mock.searchCalls[0]!.opts.offset).toBe(0);
    expect(mock.searchCalls[0]!.opts.limit).toBe(100);
  });

  it("'Musum' (typo) returns the museum doc via mocked Meilisearch", async () => {
    const mock = makeMockMeili(async (q) => {
      // Mocked typo tolerance: any non-empty `q` that contains "mus"
      // matches the museum row.
      if (q.toLowerCase().includes('mus')) {
        return { ids: ['maple-albany'], estimatedTotal: 1 };
      }
      return { ids: [], estimatedTotal: 0 };
    });
    setMeilisearchClientForTests(mock);

    const { searchRoutes } = await import('../src/routes/search.ts');
    const { requireAuth } = await import('../src/auth/middleware.ts');
    const app = new Elysia().use(requireAuth).use(searchRoutes);

    const r = await app.handle(
      new Request('http://localhost/api/search?placeQuery=Musum', {
        headers: fmtAuth(),
      }),
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      total: number;
      results: Array<{ filename: string }>;
    };
    expect(body.total).toBe(1);
    expect(body.results[0]!.filename).toBe('albany-museum.dng');
  });

  it('falls back to the database when Meilisearch throws — request still 200', async () => {
    let calls = 0;
    const mock = makeMockMeili(async () => {
      calls += 1;
      throw new Error('ECONNREFUSED meili.lan');
    });
    setMeilisearchClientForTests(mock);

    const { searchRoutes } = await import('../src/routes/search.ts');
    const { requireAuth } = await import('../src/auth/middleware.ts');
    const app = new Elysia().use(requireAuth).use(searchRoutes);

    const r = await app.handle(
      new Request('http://localhost/api/search?placeQuery=Albany', {
        headers: fmtAuth(),
      }),
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      total: number;
      results: Array<{ filename: string }>;
    };
    expect(calls).toBe(1);
    // The full-text path finds the Albany row through its search blob.
    expect(body.total).toBeGreaterThanOrEqual(1);
    const names = body.results.map((r) => r.filename);
    expect(names).toContain('albany-museum.dng');
  });

  it('passes folderId through to the Meilisearch filter when libraryId is set', async () => {
    const mock = makeMockMeili(async () => ({
      ids: ['maple-albany'],
      estimatedTotal: 1,
    }));
    setMeilisearchClientForTests(mock);

    const { searchRoutes } = await import('../src/routes/search.ts');
    const { requireAuth } = await import('../src/auth/middleware.ts');
    const app = new Elysia().use(requireAuth).use(searchRoutes);

    const url = `http://localhost/api/search?placeQuery=Albany&libraryId=${folder}`;
    const r = await app.handle(new Request(url, { headers: fmtAuth() }));
    expect(r.status).toBe(200);
    expect(mock.searchCalls.length).toBe(1);
    expect(mock.searchCalls[0]!.opts.folderId).toBe(folder);
  });

  it('passes semantic + people through to the Meilisearch options', async () => {
    // Semantic-capable mock so the route forwards `semantic: true`.
    const mock = makeMockMeili(async () => ({
      ids: ['maple-albany'],
      estimatedTotal: 1,
    }));
    mock.semanticConfigured = () => true;
    setMeilisearchClientForTests(mock);

    const { searchRoutes } = await import('../src/routes/search.ts');
    const { requireAuth } = await import('../src/auth/middleware.ts');
    const app = new Elysia().use(requireAuth).use(searchRoutes);

    const url =
      'http://localhost/api/search?placeQuery=museum&people=' + encodeURIComponent('Greyson, Maya');
    const r = await app.handle(new Request(url, { headers: fmtAuth() }));
    expect(r.status).toBe(200);
    expect(mock.searchCalls.length).toBe(1);
    expect(mock.searchCalls[0]!.opts.semantic).toBe(true);
    expect(mock.searchCalls[0]!.opts.people).toEqual(['Greyson', 'Maya']);
  });

  it('strips a natural-language date from placeQuery before the Meili call and applies captured_at', async () => {
    // Both seeded assets are captured in 2024; constrain to a month that
    // only matches the Albany row (June). The residual text ("museum") is
    // what reaches Meili — the date is folded into the Mongo re-fetch.
    const mock = makeMockMeili(async () => ({
      ids: ['maple-albany', 'maple-nyc'],
      estimatedTotal: 2,
    }));
    setMeilisearchClientForTests(mock);

    const { searchRoutes } = await import('../src/routes/search.ts');
    const { requireAuth } = await import('../src/auth/middleware.ts');
    const app = new Elysia().use(requireAuth).use(searchRoutes);

    const url = 'http://localhost/api/search?placeQuery=' + encodeURIComponent('museum June 2024');
    const r = await app.handle(new Request(url, { headers: fmtAuth() }));
    expect(r.status).toBe(200);
    // The date substring is stripped — Meili sees only the residual text.
    expect(mock.searchCalls.length).toBe(1);
    expect(mock.searchCalls[0]!.q).toBe('museum');
    // captured_at June 2024 narrows the re-fetch to the Albany row
    // (2024-06-01); the NYC row is 2024-07-01.
    const body = (await r.json()) as { results: Array<{ filename: string }> };
    const names = body.results.map((x) => x.filename);
    expect(names).toContain('albany-museum.dng');
    expect(names).not.toContain('nyc-park.dng');
  });

  it('pure-date placeQuery bypasses Meili and filters by captured_at', async () => {
    let meiliCalls = 0;
    const mock = makeMockMeili(async () => {
      meiliCalls += 1;
      return { ids: [], estimatedTotal: 0 };
    });
    setMeilisearchClientForTests(mock);

    const { searchRoutes } = await import('../src/routes/search.ts');
    const { requireAuth } = await import('../src/auth/middleware.ts');
    const app = new Elysia().use(requireAuth).use(searchRoutes);

    // "2024" resolves to a whole-year range with empty residual text — the
    // route must NOT touch Meili and instead run a plain structured query.
    const r = await app.handle(
      new Request('http://localhost/api/search?placeQuery=2024', { headers: fmtAuth() }),
    );
    expect(r.status).toBe(200);
    expect(meiliCalls).toBe(0);
    const body = (await r.json()) as { total: number; results: Array<{ filename: string }> };
    // Both seeded rows are captured in 2024.
    expect(body.total).toBe(2);
    const names = body.results.map((x) => x.filename).sort();
    expect(names).toEqual(['albany-museum.dng', 'nyc-park.dng']);
  });
});

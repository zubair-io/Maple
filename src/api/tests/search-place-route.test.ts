/**
 * Tests for /api/search?placeQuery=... — free-text place search.
 *
 * Real SQLite, installed as the process-wide handle for the file. The two
 * tests this suite used to carry about MongoDB's own index creation and its
 * boot-time `place.search_blob` backfill have gone with the engine: they
 * asserted on `ensureIndexes()` in `db/client.ts`, not on this route, and the
 * full-text index here is a table the schema declares and a trigger keeps in
 * step (`db/sqlite/ddl/search.ts`).
 *
 * Reference: `docs/indexer-enrichment.md` §5.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { Elysia } from 'elysia';
import { signAccessToken } from '../src/auth/tokens.ts';
import { parseNominatimResponse } from '../src/enrichment/place-parser.ts';
import { seedSearchAsset, type SeedAsset } from '../src/db/repos/search.test-helpers.ts';
import {
  createLiveTestDatabase,
  insertFolder,
  type LiveTestDatabase,
} from '../src/db/sqlite/test-sqlite.test-helpers.ts';

// JWT bootstrap MUST run before any module that touches `requireAuth`.
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

function fmtAuth(): Record<string, string> {
  return { Authorization: BEARER };
}

let live: LiveTestDatabase;

/** Build a `Place` document via the production parser so the search blob
 * matches what the worker would actually write. */
function placeFor(raw: Parameters<typeof parseNominatimResponse>[0], lat = 0, lon = 0) {
  return parseNominatimResponse(raw, lat, lon, 1, () => new Date('2026-05-08T12:00:00.000Z'));
}

/**
 * One fixture asset.
 *
 * `search_blob` is the union of the place blob, the caption and the OCR text,
 * which is what the indexer synthesises for the full-text index. Composed here
 * rather than derived, so the fixture states outright what each row is
 * findable by.
 */
function asset(
  filename: string,
  place: ReturnType<typeof placeFor> | null,
  extra: Partial<SeedAsset> = {},
): SeedAsset {
  const blob = [place?.search_blob ?? '', extra.description ?? '', extra.ocrText ?? '']
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  return {
    filename,
    path: '',
    capturedAt: '2024-06-01T12:00:00.000Z',
    cameraMake: 'Sony',
    cameraModel: 'A7R V',
    lens: 'FE 24-70mm',
    iso: 200,
    aperture: 4.0,
    focalLength: 35,
    gps: { lat: 42.65, lng: -73.75 },
    placeDoc: place,
    searchBlob: blob.length === 0 ? null : blob,
    ...extra,
  };
}

beforeAll(async () => {
  live = await createLiveTestDatabase();
  const libraryId = insertFolder(live.db, { path: '/lib', slug: 'lib' });

  const albanyMuseum = placeFor({
    category: 'tourism',
    type: 'museum',
    name: 'New York State Museum',
    display_name: 'New York State Museum, Albany',
    address: {
      house_number: '222',
      road: 'Madison Avenue',
      city: 'Albany',
      county: 'Albany County',
      state: 'New York',
      'ISO3166-2-lvl4': 'US-NY',
      country: 'United States',
      country_code: 'us',
      tourism: 'New York State Museum',
    },
  });

  const nycCentralPark = placeFor({
    category: 'leisure',
    type: 'park',
    name: 'Central Park',
    display_name: 'Central Park, Manhattan, New York',
    address: {
      city: 'New York',
      state: 'New York',
      'ISO3166-2-lvl4': 'US-NY',
      country: 'United States',
      country_code: 'us',
      leisure: 'Central Park',
    },
  });

  const sfPark = placeFor({
    category: 'leisure',
    type: 'park',
    name: 'Golden Gate Park',
    address: {
      city: 'San Francisco',
      state: 'California',
      'ISO3166-2-lvl4': 'US-CA',
      country: 'United States',
      country_code: 'us',
    },
  });

  const parisLouvre = placeFor({
    category: 'tourism',
    type: 'museum',
    name: 'Musee du Louvre',
    address: {
      city: 'Paris',
      state: 'Ile-de-France',
      country: 'France',
      country_code: 'fr',
    },
  });

  const seeds: SeedAsset[] = [
    asset('albany-museum.dng', albanyMuseum, {
      rating: 5,
      flag: 1,
      cameraMake: 'Hasselblad',
      cameraModel: 'L3D-100c',
    }),
    asset('nyc-park.dng', nycCentralPark, {
      rating: 4,
      capturedAt: '2024-07-01T12:00:00.000Z',
    }),
    asset('sf-park.dng', sfPark, { rating: 3, capturedAt: '2024-08-01T12:00:00.000Z' }),
    asset('paris.dng', parisLouvre, { rating: 3, capturedAt: '2024-09-01T12:00:00.000Z' }),
    // No place and no text at all — must never match a placeQuery.
    asset('no-place.jpg', null, { capturedAt: null, gps: null }),
    // Soft-deleted Albany row — must NOT match.
    asset('albany-deleted.dng', albanyMuseum, { deletedAt: '2026-01-01T00:00:00.000Z' }),
    // A row with NO place but a caption that mentions "telescope". Asserts the
    // unified blob picks up the description.
    asset('telescope.jpg', null, {
      capturedAt: null,
      gps: null,
      description: 'A photograph of a brass telescope on a tripod',
    }),
    // A row with NO place but OCR text — asserts the OCR half contributes.
    asset('menu.jpg', null, {
      capturedAt: null,
      gps: null,
      ocrText: 'BRUNCH MENU\nEspresso $4\nCroissant $3',
    }),
  ];
  for (const seed of seeds) seedSearchAsset(live.db, libraryId, seed);
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

afterAll(() => {
  live.close();
});

interface PlaceRow {
  id: string;
  filename: string;
  place: { display_name: string | null; address: { city?: string } } | null;
}

async function search(qs: string): Promise<{
  status: number;
  body: { total: number; results: PlaceRow[] };
}> {
  const { searchRoutes } = await import('../src/routes/search.ts');
  const { requireAuth } = await import('../src/auth/middleware.ts');
  const app = new Elysia().use(requireAuth).use(searchRoutes);
  const r = await app.handle(
    new Request(`http://localhost/api/search?${qs}`, { headers: fmtAuth() }),
  );
  return { status: r.status, body: (await r.json()) as never };
}

describe('/api/search?placeQuery', () => {
  it("'Albany NY' matches the Albany asset, not New York City", async () => {
    const { status, body } = await search(`placeQuery=${encodeURIComponent('Albany NY')}`);
    expect(status).toBe(200);
    // The terms are ORed, but Albany is the unique discriminator here, so the
    // leading match must be the Albany row.
    expect(body.total).toBeGreaterThanOrEqual(1);
    expect(body.results[0]!.filename).toBe('albany-museum.dng');
    const filenames = body.results.map((r) => r.filename);
    // The Paris asset must NOT match.
    expect(filenames).not.toContain('paris.dng');
    // The asset with no indexed text must NOT match.
    expect(filenames).not.toContain('no-place.jpg');
    // Soft-deleted must NOT match.
    expect(filenames).not.toContain('albany-deleted.dng');
  });

  it("'NY' matches both NY assets (Albany museum + NYC park)", async () => {
    const { status, body } = await search('placeQuery=NY');
    expect(status).toBe(200);
    expect(body.total).toBe(2);
    const names = new Set(body.results.map((r) => r.filename));
    expect(names.has('albany-museum.dng')).toBe(true);
    expect(names.has('nyc-park.dng')).toBe(true);
    expect(names.has('sf-park.dng')).toBe(false);
    expect(names.has('paris.dng')).toBe(false);
  });

  it("'Park' matches both park-typed POIs (Central Park + Golden Gate Park)", async () => {
    const { status, body } = await search('placeQuery=Park');
    expect(status).toBe(200);
    // Both park assets match: Central Park (POI name + type) and Golden Gate
    // Park (POI name + type).
    const names = new Set(body.results.map((r) => r.filename));
    expect(names.has('nyc-park.dng')).toBe(true);
    expect(names.has('sf-park.dng')).toBe(true);
    expect(body.total).toBe(2);
  });

  it('AND-restricts with structured filters (camera=Hasselblad)', async () => {
    // placeQuery=NY would normally match 2 rows (albany + nyc-park); adding
    // camera=Hasselblad narrows to the Albany asset only.
    const { status, body } = await search('placeQuery=NY&camera=Hasselblad');
    expect(status).toBe(200);
    expect(body.total).toBe(1);
    expect(body.results[0]!.filename).toBe('albany-museum.dng');
  });

  it('relevance ranks closer matches first (multi-token query)', async () => {
    // Both Albany and NYC blobs contain "New York"; the Albany blob also
    // contains "Albany", so it ranks higher for "Albany New York".
    const { status, body } = await search(`placeQuery=${encodeURIComponent('Albany New York')}`);
    expect(status).toBe(200);
    expect(body.results[0]!.filename).toBe('albany-museum.dng');
    // The NYC park row is also a match (it shares "New York") and must rank
    // BELOW Albany. Its capture date is later (2024-07) than Albany's
    // (2024-06) — if the sort were captured_at-first, NYC would lead.
    const albIdx = body.results.findIndex((r) => r.filename === 'albany-museum.dng');
    const nycIdx = body.results.findIndex((r) => r.filename === 'nyc-park.dng');
    expect(albIdx).toBeLessThan(nycIdx);
  });

  it('placeQuery returns the same SearchResult shape including `place`', async () => {
    const { status, body } = await search('placeQuery=Albany');
    expect(status).toBe(200);
    expect(body.results.length).toBeGreaterThanOrEqual(1);
    const albany = body.results.find((r) => r.filename === 'albany-museum.dng');
    expect(albany).toBeDefined();
    expect(albany!.id).toBe('fs:/lib/albany-museum.dng');
    expect(albany!.place).not.toBeNull();
    expect(albany!.place!.address.city).toBe('Albany');
  });

  it("'Musum' (typo) returns no matches — the sidecar is what fixes that", async () => {
    const { status, body } = await search('placeQuery=Musum');
    expect(status).toBe(200);
    // The database path has no typo tolerance, by design: Meilisearch is the
    // branch that provides it, and this is the fallback beneath it.
    expect(body.total).toBe(0);
  });

  it('matches description-only rows via the unified search blob', async () => {
    const { status, body } = await search('placeQuery=telescope');
    expect(status).toBe(200);
    expect(body.total).toBeGreaterThanOrEqual(1);
    expect(new Set(body.results.map((r) => r.filename)).has('telescope.jpg')).toBe(true);
  });

  it('matches OCR-text rows via the unified search blob', async () => {
    // The OCR text is "BRUNCH MENU\nEspresso …" — the blob normalises
    // whitespace and case, so "espresso" matches.
    const { status, body } = await search('placeQuery=espresso');
    expect(status).toBe(200);
    expect(body.total).toBeGreaterThanOrEqual(1);
    expect(new Set(body.results.map((r) => r.filename)).has('menu.jpg')).toBe(true);
  });
});

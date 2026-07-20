/**
 * Tests for /api/search?placeQuery=... — Phase 3 free-text place search.
 *
 * Mirrors `tests/search-route.test.ts`'s skip-if-Mongo-unreachable pattern.
 * Uses a process-unique DB so concurrent test runs don't collide.
 *
 * Reference: `docs/indexer-enrichment.md` §5.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { Elysia } from 'elysia';
import { MongoClient, ObjectId } from 'mongodb';
import { signAccessToken } from '../src/auth/tokens.ts';
import { parseNominatimResponse } from '../src/enrichment/place-parser.ts';

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
    },
    SECRET,
  ));

const TEST_DB = `maple_test_search_place_${process.pid}`;
const PRIOR_MONGO_DB = process.env.MAPLE_MONGO_DB;
process.env.MAPLE_MONGO_DB = TEST_DB;

const MONGO_URI = process.env.MAPLE_MONGO_URI ?? 'mongodb://localhost:27017';

function fmtAuth(): Record<string, string> {
  return { Authorization: BEARER };
}

let mongo: MongoClient | null = null;
let mongoReachable = false;
const folder = new ObjectId();

async function tryConnect(): Promise<MongoClient | null> {
  const c = new MongoClient(MONGO_URI, {
    serverSelectionTimeoutMS: 1500,
    connectTimeoutMS: 1500,
  });
  try {
    await c.connect();
    await c.db('admin').command({ ping: 1 });
    return c;
  } catch {
    try {
      await c.close();
    } catch {}
    return null;
  }
}

/** Build a `Place` document via the production parser so the search_blob
 * matches what the worker would actually write. */
function placeFor(raw: Parameters<typeof parseNominatimResponse>[0], lat = 0, lon = 0) {
  return parseNominatimResponse(raw, lat, lon, 1, () => new Date('2026-05-08T12:00:00.000Z'));
}

/**
 * Post drop-abs-path-2026-05-21: helper to translate the legacy
 * `{ folder_id, abs_path, filename }` triple into the persisted
 * `fileinfo[0]` shape. Keeps the seed fixtures readable while routing
 * the asset's location through the content-addressed pointer the
 * server actually reads.
 */
function fi(filename: string) {
  return [{ library_id: folder, path: '', filename, deleted_at: null }];
}

beforeAll(async () => {
  mongo = await tryConnect();
  mongoReachable = mongo !== null;
  if (!mongoReachable) {
    console.log('[search-place-route.test] skipping: MongoDB unreachable at', MONGO_URI);
    return;
  }
  const db = mongo!.db(TEST_DB);
  await db.dropDatabase();
  await db.collection('folders').insertOne({
    _id: folder,
    path: '/lib',
    label: 'lib',
    last_scan: null,
    file_count: 0,
    created_at: new Date().toISOString(),
  } as never);
  const { invalidateLibraryRoots } = await import('../src/indexer/libraries.cache.ts');
  invalidateLibraryRoots();

  // Four place-bearing assets + one without place to confirm the partial
  // text index excludes it from $text matches.
  const baseExif = {
    captured_at: '2024-06-01T12:00:00.000Z',
    camera_make: 'Sony',
    camera_model: 'A7R V',
    lens: 'FE 24-70mm',
    iso: 200,
    aperture: 4.0,
    shutter: '1/250',
    focal_length: 35,
    gps: { lat: 42.65, lng: -73.75 },
  };

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

  // Asset without `place` — must NOT match any placeQuery.
  await db.collection('assets').insertMany([
    {
      fileinfo: fi('albany-museum.dng'),
      size: 1024,
      mtime: 1000,
      rating: 5,
      flag: 1,
      color_label: '',
      indexed_at: new Date().toISOString(),
      exif: { ...baseExif, camera_make: 'Hasselblad', camera_model: 'L3D-100c' },
      place: albanyMuseum,
    },
    {
      fileinfo: fi('nyc-park.dng'),
      size: 1024,
      mtime: 2000,
      rating: 4,
      flag: 0,
      color_label: '',
      indexed_at: new Date().toISOString(),
      exif: { ...baseExif, captured_at: '2024-07-01T12:00:00.000Z' },
      place: nycCentralPark,
    },
    {
      fileinfo: fi('sf-park.dng'),
      size: 1024,
      mtime: 3000,
      rating: 3,
      flag: 0,
      color_label: '',
      indexed_at: new Date().toISOString(),
      exif: { ...baseExif, captured_at: '2024-08-01T12:00:00.000Z' },
      place: sfPark,
    },
    {
      fileinfo: fi('paris.dng'),
      size: 1024,
      mtime: 4000,
      rating: 3,
      flag: 0,
      color_label: '',
      indexed_at: new Date().toISOString(),
      exif: { ...baseExif, captured_at: '2024-09-01T12:00:00.000Z' },
      place: parisLouvre,
    },
    {
      fileinfo: fi('no-place.jpg'),
      size: 512,
      mtime: 5000,
      rating: 0,
      flag: 0,
      color_label: '',
      indexed_at: new Date().toISOString(),
      exif: null,
      place: null,
    },
    // Soft-deleted Albany row — must NOT match.
    {
      fileinfo: fi('albany-deleted.dng'),
      size: 256,
      mtime: 6000,
      rating: 0,
      flag: 0,
      color_label: '',
      indexed_at: new Date().toISOString(),
      exif: baseExif,
      place: albanyMuseum,
      deleted_at: new Date().toISOString(),
    },
    // Phase 8: a row with NO place but a description that mentions
    // "telescope". Asserts the unified search_blob picks up description.
    {
      fileinfo: fi('telescope.jpg'),
      size: 512,
      mtime: 7000,
      rating: 0,
      flag: 0,
      color_label: '',
      indexed_at: new Date().toISOString(),
      exif: null,
      place: null,
      description: 'A photograph of a brass telescope on a tripod',
    },
    // Phase 8: a row with NO place but OCR text. Asserts ocr_text
    // contributes to the unified blob.
    {
      fileinfo: fi('menu.jpg'),
      size: 512,
      mtime: 8000,
      rating: 0,
      flag: 0,
      color_label: '',
      indexed_at: new Date().toISOString(),
      exif: null,
      place: null,
      ocr_text: 'BRUNCH MENU\nEspresso $4\nCroissant $3',
    },
  ]);

  // Build the text + facet indexes via the same path as production.
  // ensureIndexes() will create both `place_search_blob_text` and
  // `place_rollups`.
  for (const name of [
    'users',
    'credentials',
    'invites',
    'refresh_tokens',
    'challenges',
    'folders',
  ]) {
    try {
      await db.createCollection(name);
    } catch {}
  }
  // Reset the singleton DB connection so ensureIndexes uses TEST_DB.
  const { closeDb, ensureIndexes } = await import('../src/db/client.ts');
  await closeDb();
  await ensureIndexes();
});

beforeEach(async () => {
  if (!mongoReachable) return;
  const { _resetBucketsCacheForTests, _resetCacheForTests } =
    await import('../src/routes/search.ts');
  _resetBucketsCacheForTests();
  // The list route's `total` cache (#2128) is module-scoped for the
  // process lifetime — without this, a different test file's `total` for
  // the same query-param shape (e.g. an identical placeQuery string) could
  // leak in here, or this file's own results could leak into a later file.
  _resetCacheForTests();
});

afterAll(async () => {
  if (mongo && mongoReachable) {
    try {
      await mongo.db(TEST_DB).dropDatabase();
    } catch {}
    try {
      await mongo.close();
    } catch {}
  }
  try {
    const { closeDb } = await import('../src/db/client.ts');
    await closeDb();
  } catch {}
  if (PRIOR_MONGO_DB === undefined) delete process.env.MAPLE_MONGO_DB;
  else process.env.MAPLE_MONGO_DB = PRIOR_MONGO_DB;
});

describe('/api/search?placeQuery', () => {
  it('ensureIndexes creates search_blob_text and place_rollups, drops legacy index', async () => {
    if (!mongoReachable) return;
    const db = mongo!.db(TEST_DB);
    const indexes = await db.collection('assets').indexes();
    const names = new Set(indexes.map((i) => i.name as string));
    expect(names.has('search_blob_text')).toBe(true);
    expect(names.has('place_rollups')).toBe(true);
    // Phase 8 — text index moved off `place.search_blob` onto the
    // unified `asset.search_blob`. The old index must be gone.
    expect(names.has('place_search_blob_text')).toBe(false);
  });

  it("'Albany NY' matches the Albany asset, not New York City", async () => {
    if (!mongoReachable) return;
    const { searchRoutes } = await import('../src/routes/search.ts');
    const { requireAuth } = await import('../src/auth/middleware.ts');
    const app = new Elysia().use(requireAuth).use(searchRoutes);

    const r = await app.handle(
      new Request(`http://localhost/api/search?placeQuery=${encodeURIComponent('Albany NY')}`, {
        headers: fmtAuth(),
      }),
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      total: number;
      results: Array<{ filename: string; place: { display_name: string | null } | null }>;
    };
    // Mongo $text 'Albany NY' is OR-of-words, but Albany is the unique
    // discriminator here. The leading match must be the Albany row.
    expect(body.total).toBeGreaterThanOrEqual(1);
    expect(body.results[0]!.filename).toBe('albany-museum.dng');
    // The Paris asset must NOT match.
    const filenames = body.results.map((r) => r.filename);
    expect(filenames).not.toContain('paris.dng');
    // The no-place asset must NOT match (partial index excludes it).
    expect(filenames).not.toContain('no-place.jpg');
    // Soft-deleted must NOT match.
    expect(filenames).not.toContain('albany-deleted.dng');
  });

  it("'NY' matches both NY assets (Albany museum + NYC park)", async () => {
    if (!mongoReachable) return;
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
    const names = new Set(body.results.map((r) => r.filename));
    expect(names.has('albany-museum.dng')).toBe(true);
    expect(names.has('nyc-park.dng')).toBe(true);
    expect(names.has('sf-park.dng')).toBe(false);
    expect(names.has('paris.dng')).toBe(false);
  });

  it("'Park' matches both park-typed POIs (Central Park + Golden Gate Park)", async () => {
    if (!mongoReachable) return;
    const { searchRoutes } = await import('../src/routes/search.ts');
    const { requireAuth } = await import('../src/auth/middleware.ts');
    const app = new Elysia().use(requireAuth).use(searchRoutes);

    const r = await app.handle(
      new Request('http://localhost/api/search?placeQuery=Park', {
        headers: fmtAuth(),
      }),
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      total: number;
      results: Array<{ filename: string }>;
    };
    // Both park assets match: Central Park (POI name + type) and Golden
    // Gate Park (POI name + type).
    const names = new Set(body.results.map((r) => r.filename));
    expect(names.has('nyc-park.dng')).toBe(true);
    expect(names.has('sf-park.dng')).toBe(true);
    expect(body.total).toBe(2);
  });

  it('AND-restricts with structured filters (camera=Hasselblad)', async () => {
    if (!mongoReachable) return;
    const { searchRoutes } = await import('../src/routes/search.ts');
    const { requireAuth } = await import('../src/auth/middleware.ts');
    const app = new Elysia().use(requireAuth).use(searchRoutes);

    // placeQuery=NY would normally match 2 rows (albany + nyc-park);
    // adding camera=Hasselblad narrows to the Albany asset only.
    const r = await app.handle(
      new Request('http://localhost/api/search?placeQuery=NY&camera=Hasselblad', {
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

  it('text-score ranks closer matches first (multi-token query)', async () => {
    if (!mongoReachable) return;
    const { searchRoutes } = await import('../src/routes/search.ts');
    const { requireAuth } = await import('../src/auth/middleware.ts');
    const app = new Elysia().use(requireAuth).use(searchRoutes);

    // Both Albany and NYC blobs contain "New York"; the Albany blob also
    // contains "Albany" so its text score for "Albany New York" is higher.
    const r = await app.handle(
      new Request(
        `http://localhost/api/search?placeQuery=${encodeURIComponent('Albany New York')}`,
        { headers: fmtAuth() },
      ),
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      total: number;
      results: Array<{ filename: string }>;
    };
    expect(body.results[0]!.filename).toBe('albany-museum.dng');
    // The NYC park row is also a match (shares "New York"); it must rank
    // BELOW Albany. The capture date for NYC is later (2024-07) than
    // Albany (2024-06) — if the sort were captured_at-first, NYC would
    // lead. Score-first sort puts Albany on top.
    const albIdx = body.results.findIndex((r) => r.filename === 'albany-museum.dng');
    const nycIdx = body.results.findIndex((r) => r.filename === 'nyc-park.dng');
    expect(albIdx).toBeLessThan(nycIdx);
  });

  it('placeQuery returns the same SearchResult shape including `place`', async () => {
    if (!mongoReachable) return;
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
      results: Array<{
        id: string;
        filename: string;
        place: { display_name: string | null; address: { city?: string } } | null;
      }>;
    };
    expect(body.results.length).toBeGreaterThanOrEqual(1);
    const albany = body.results.find((r) => r.filename === 'albany-museum.dng');
    expect(albany).toBeDefined();
    expect(albany!.id).toBe('fs:/lib/albany-museum.dng');
    expect(albany!.place).not.toBeNull();
    expect(albany!.place!.address.city).toBe('Albany');
  });

  it("'Musum' (typo) returns no matches (Phase 7 will fix this)", async () => {
    if (!mongoReachable) return;
    const { searchRoutes } = await import('../src/routes/search.ts');
    const { requireAuth } = await import('../src/auth/middleware.ts');
    const app = new Elysia().use(requireAuth).use(searchRoutes);

    const r = await app.handle(
      new Request('http://localhost/api/search?placeQuery=Musum', {
        headers: fmtAuth(),
      }),
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as { total: number };
    // Phase 3 has no typo tolerance — Mongo $text doesn't support it.
    // Documented behaviour: returns 0.
    expect(body.total).toBe(0);
  });

  it('backfills search_blob for legacy place rows (idempotent)', async () => {
    if (!mongoReachable) return;
    const db = mongo!.db(TEST_DB);
    // The boot-time backfill is gated on the `migrations` sentinel so it
    // runs exactly once per database lifetime (avoiding a 0.6s COLLSCAN
    // on every API boot). The beforeAll() above already triggered the
    // first run — wipe the sentinel here so this test's legacy-row
    // assertion can exercise the backfill against a freshly-inserted
    // legacy-shaped doc.
    await db.collection('migrations').deleteMany({
      _id: {
        $in: ['place-search-blob-backfill', 'asset-search-blob-backfill'],
      },
    } as Parameters<ReturnType<typeof db.collection>['deleteMany']>[0]);
    // Insert a legacy-shaped doc: place set, but search_blob empty (the
    // Phase 2 worker shipped this shape before Phase 3 landed). The
    // backfill in ensureIndexes should populate search_blob.
    const legacyId = new ObjectId();
    await db.collection('assets').insertOne({
      _id: legacyId,
      fileinfo: fi('legacy.dng'),
      size: 1024,
      mtime: 9999,
      rating: 0,
      flag: 0,
      color_label: '',
      indexed_at: new Date().toISOString(),
      exif: null,
      place: {
        source: 'nominatim',
        geocoder_version: 1,
        geocoded_at: '2026-05-01T00:00:00.000Z',
        lat: 0,
        lon: 0,
        display_name: 'Legacy',
        address: { city: 'Boston', state: 'Massachusetts', state_code: 'MA' },
        pois: [{ name: 'Boston Common', category: 'leisure', type: 'park' }],
        rollups: { locality: 'Boston', region: 'Massachusetts', country_code: 'us' },
        search_blob: '', // legacy: empty
      },
    });

    const { ensureIndexes } = await import('../src/db/client.ts');
    await ensureIndexes();

    const after = await db.collection('assets').findOne({ _id: legacyId });
    const blob = (after as { place?: { search_blob?: string } }).place?.search_blob;
    expect(typeof blob).toBe('string');
    expect(blob!.length).toBeGreaterThan(0);
    const tokens = blob!.split(' ');
    expect(tokens).toContain('boston');
    expect(tokens).toContain('ma');
    expect(tokens).toContain('park');
    expect(tokens).toContain('common');

    // Idempotent: a second ensureIndexes call must NOT change the blob
    // (the predicate filters to `search_blob: ""` rows; the row is no
    // longer empty).
    await ensureIndexes();
    const afterAgain = await db.collection('assets').findOne({ _id: legacyId });
    expect((afterAgain as { place?: { search_blob?: string } }).place?.search_blob).toBe(blob);

    // The new asset should appear in placeQuery results too — proves the
    // text index covers backfilled rows.
    const { searchRoutes } = await import('../src/routes/search.ts');
    const { requireAuth } = await import('../src/auth/middleware.ts');
    const app = new Elysia().use(requireAuth).use(searchRoutes);
    const r = await app.handle(
      new Request('http://localhost/api/search?placeQuery=Boston', {
        headers: fmtAuth(),
      }),
    );
    const body = (await r.json()) as {
      results: Array<{ filename: string }>;
    };
    const names = body.results.map((r) => r.filename);
    expect(names).toContain('legacy.dng');

    // Cleanup so subsequent tests' counts are stable.
    await db.collection('assets').deleteOne({ _id: legacyId });
  });

  it('Phase 8: matches description-only rows via unified search_blob', async () => {
    if (!mongoReachable) return;
    const { searchRoutes } = await import('../src/routes/search.ts');
    const { requireAuth } = await import('../src/auth/middleware.ts');
    const app = new Elysia().use(requireAuth).use(searchRoutes);

    const r = await app.handle(
      new Request('http://localhost/api/search?placeQuery=telescope', {
        headers: fmtAuth(),
      }),
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      total: number;
      results: Array<{ filename: string }>;
    };
    expect(body.total).toBeGreaterThanOrEqual(1);
    const names = new Set(body.results.map((r) => r.filename));
    expect(names.has('telescope.jpg')).toBe(true);
  });

  it('Phase 8: matches OCR-text rows via unified search_blob', async () => {
    if (!mongoReachable) return;
    const { searchRoutes } = await import('../src/routes/search.ts');
    const { requireAuth } = await import('../src/auth/middleware.ts');
    const app = new Elysia().use(requireAuth).use(searchRoutes);

    // OCR text contains "BRUNCH MENU\nEspresso..." — the unified
    // backfill normalises whitespace, lowercases, and tokenises so
    // "espresso" should match.
    const r = await app.handle(
      new Request('http://localhost/api/search?placeQuery=espresso', {
        headers: fmtAuth(),
      }),
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      total: number;
      results: Array<{ filename: string }>;
    };
    expect(body.total).toBeGreaterThanOrEqual(1);
    const names = new Set(body.results.map((r) => r.filename));
    expect(names.has('menu.jpg')).toBe(true);
  });
});

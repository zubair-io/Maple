/**
 * Tests for the S7 `scope` query param on GET /api/search (#644).
 *
 * Backend-side semantics:
 *   - `photos` / absent → full live set (today's behaviour).
 *   - `places`          → assets with non-null `exif.gps`.
 *   - `people`          → assets with at least one entry in `faces`.
 *   - `albums`          → short-circuit; empty `results` + `notImplemented: true`.
 *
 * Skip-passes if MongoDB is unreachable.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { Elysia } from 'elysia';
import { MongoClient, ObjectId } from 'mongodb';
import {
  baseSeeds,
  fmtAuth,
  legacyToFileinfo,
  materializeSeeds,
  seedFolders,
  tryConnect,
} from './_setup.ts';

const TEST_DB = `maple_test_search_scope_${process.pid}`;
const PRIOR_MONGO_DB = process.env.MAPLE_MONGO_DB;
process.env.MAPLE_MONGO_DB = TEST_DB;

let mongo: MongoClient | null = null;
let mongoReachable = false;
const folderA = new ObjectId();
const folderB = new ObjectId();

beforeAll(async () => {
  mongo = await tryConnect();
  mongoReachable = mongo !== null;
  if (!mongoReachable) {
    console.log('[search/scope.test] skipping: MongoDB unreachable');
    return;
  }
  const db = mongo!.db(TEST_DB);
  await db.dropDatabase();
  await seedFolders(db, folderA, folderB);

  // baseSeeds gives us 4 live + 1 deleted. Of the live rows: one has
  // gps (the Hasselblad row), three don't. Augment with two extra rows
  // so we can prove the faces filter independently of gps.
  const seeds = baseSeeds(folderA, folderB);
  const extras = [
    {
      // Live row with a single detected face but no GPS.
      fileinfo: [legacyToFileinfo(folderA, '/lib-a/face-only.jpg', 'face-only.jpg')],
      size: 100,
      mtime: Date.now() - 5000,
      rating: 0,
      flag: 0 as const,
      color_label: '',
      indexed_at: new Date().toISOString(),
      exif: null,
      faces: [
        {
          bbox: { x: 0.1, y: 0.1, w: 0.3, h: 0.3 },
          person_id: null,
          confidence: 0.9,
        },
      ],
    },
    {
      // Live row with BOTH gps and a face — covered by both scopes.
      fileinfo: [legacyToFileinfo(folderA, '/lib-a/gps-and-face.jpg', 'gps-and-face.jpg')],
      size: 200,
      mtime: Date.now() - 6000,
      rating: 0,
      flag: 0 as const,
      color_label: '',
      indexed_at: new Date().toISOString(),
      exif: {
        captured_at: '2024-08-01T00:00:00.000Z',
        camera_make: 'Apple',
        camera_model: 'iPhone',
        lens: null,
        iso: 100,
        aperture: 2.0,
        shutter: '1/100',
        focal_length: 26,
        gps: { lat: 40.7, lng: -74.0 },
      },
      faces: [
        {
          bbox: { x: 0.2, y: 0.2, w: 0.4, h: 0.4 },
          person_id: null,
          confidence: 0.95,
        },
      ],
    },
  ];

  await db
    .collection('assets')
    .insertMany([...materializeSeeds(seeds), ...materializeSeeds(extras as never)] as never);

  const { closeDb } = await import('../../src/db/client.ts');
  await closeDb();
});

beforeEach(async () => {
  if (!mongoReachable) return;
  // The list route's `total` cache (#2128) is module-scoped for the
  // process lifetime — without this, a different test file's `total` for
  // the same query-param shape (e.g. no filters at all — several suites
  // in tests/search/ hit that exact case) would leak into this file's
  // assertions, or vice versa. Mirrors the buckets-cache reset already
  // used by buckets.test.ts / search-place-route.test.ts.
  const { _resetCacheForTests } = await import('../../src/routes/search.ts');
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
    const { closeDb } = await import('../../src/db/client.ts');
    await closeDb();
  } catch {}
  if (PRIOR_MONGO_DB === undefined) delete process.env.MAPLE_MONGO_DB;
  else process.env.MAPLE_MONGO_DB = PRIOR_MONGO_DB;
});

describe('/api/search?scope=', () => {
  it('returns the full live set when scope is absent', async () => {
    if (!mongoReachable) return;
    const { searchRoutes } = await import('../../src/routes/search.ts');
    const { requireAuth } = await import('../../src/auth/middleware.ts');
    const app = new Elysia().use(requireAuth).use(searchRoutes);

    const r = await app.handle(new Request('http://localhost/api/search', { headers: fmtAuth() }));
    expect(r.status).toBe(200);
    const body = (await r.json()) as { total: number; notImplemented?: boolean };
    // 4 base live + 2 extras = 6
    expect(body.total).toBe(6);
    expect(body.notImplemented).toBeUndefined();
  });

  it('scope=photos is a no-op alias for the default set', async () => {
    if (!mongoReachable) return;
    const { searchRoutes } = await import('../../src/routes/search.ts');
    const { requireAuth } = await import('../../src/auth/middleware.ts');
    const app = new Elysia().use(requireAuth).use(searchRoutes);

    const r = await app.handle(
      new Request('http://localhost/api/search?scope=photos', { headers: fmtAuth() }),
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as { total: number; notImplemented?: boolean };
    expect(body.total).toBe(6);
    expect(body.notImplemented).toBeUndefined();
  });

  it('scope=places narrows to assets with exif.gps', async () => {
    if (!mongoReachable) return;
    const { searchRoutes } = await import('../../src/routes/search.ts');
    const { requireAuth } = await import('../../src/auth/middleware.ts');
    const app = new Elysia().use(requireAuth).use(searchRoutes);

    const r = await app.handle(
      new Request('http://localhost/api/search?scope=places', { headers: fmtAuth() }),
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      total: number;
      results: Array<{ filename: string }>;
      notImplemented?: boolean;
    };
    // Hasselblad (gps) + gps-and-face = 2
    expect(body.total).toBe(2);
    const names = body.results.map((r) => r.filename).sort();
    expect(names).toEqual(['dji-mavic3pro-100mp.dng', 'gps-and-face.jpg']);
    expect(body.notImplemented).toBeUndefined();
  });

  it('scope=people narrows to assets with at least one face', async () => {
    if (!mongoReachable) return;
    const { searchRoutes } = await import('../../src/routes/search.ts');
    const { requireAuth } = await import('../../src/auth/middleware.ts');
    const app = new Elysia().use(requireAuth).use(searchRoutes);

    const r = await app.handle(
      new Request('http://localhost/api/search?scope=people', { headers: fmtAuth() }),
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      total: number;
      results: Array<{ filename: string }>;
      notImplemented?: boolean;
    };
    // face-only + gps-and-face = 2
    expect(body.total).toBe(2);
    const names = body.results.map((r) => r.filename).sort();
    expect(names).toEqual(['face-only.jpg', 'gps-and-face.jpg']);
    expect(body.notImplemented).toBeUndefined();
  });

  it('scope=albums short-circuits with notImplemented=true', async () => {
    if (!mongoReachable) return;
    const { searchRoutes } = await import('../../src/routes/search.ts');
    const { requireAuth } = await import('../../src/auth/middleware.ts');
    const app = new Elysia().use(requireAuth).use(searchRoutes);

    const r = await app.handle(
      new Request('http://localhost/api/search?scope=albums', { headers: fmtAuth() }),
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      total: number;
      results: unknown[];
      notImplemented?: boolean;
    };
    expect(body.total).toBe(0);
    expect(body.results).toEqual([]);
    expect(body.notImplemented).toBe(true);
  });

  it('rejects an unknown scope value with 400', async () => {
    if (!mongoReachable) return;
    const { searchRoutes } = await import('../../src/routes/search.ts');
    const { requireAuth } = await import('../../src/auth/middleware.ts');
    const app = new Elysia().use(requireAuth).use(searchRoutes);

    const r = await app.handle(
      new Request('http://localhost/api/search?scope=notarealscope', { headers: fmtAuth() }),
    );
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error: string };
    expect(body.error).toContain('scope');
  });

  it('scope filter composes with q (AND semantics)', async () => {
    if (!mongoReachable) return;
    const { searchRoutes } = await import('../../src/routes/search.ts');
    const { requireAuth } = await import('../../src/auth/middleware.ts');
    const app = new Elysia().use(requireAuth).use(searchRoutes);

    // gps-and-face is the only Places-scope row whose filename matches "gps".
    const r = await app.handle(
      new Request('http://localhost/api/search?scope=places&q=gps', { headers: fmtAuth() }),
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      total: number;
      results: Array<{ filename: string }>;
    };
    expect(body.total).toBe(1);
    expect(body.results[0]!.filename).toBe('gps-and-face.jpg');
  });
});

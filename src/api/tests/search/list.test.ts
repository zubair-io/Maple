/**
 * Tests for GET /api/search — the paginated result list endpoint.
 *
 * Bare-Elysia `app.handle` style; mirrors `tests/auth/enforcement.test.ts`.
 * Skip-passes if MongoDB is unreachable.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { Elysia } from 'elysia';
import { MongoClient, ObjectId } from 'mongodb';
import { baseSeeds, fmtAuth, seedFolders, tryConnect } from './_setup.ts';

// Each test run uses a unique DB so concurrent dev work / CI shards don't collide.
const TEST_DB = `maple_test_search_list_${process.pid}`;
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
    console.log('[search/list.test] skipping: MongoDB unreachable');
    return;
  }
  const db = mongo!.db(TEST_DB);
  await db.dropDatabase();
  await seedFolders(db, folderA, folderB);
  await db.collection('assets').insertMany(baseSeeds(folderA, folderB));

  // Reset the singleton DB connection — earlier tests in the suite may have
  // already cached `_db` pointing at a different database. Without this, the
  // route under test would query the wrong DB.
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
  // Reset the singleton so downstream tests in the same bun process get a
  // fresh connection that re-reads MAPLE_MONGO_DB at connect time.
  try {
    const { closeDb } = await import('../../src/db/client.ts');
    await closeDb();
  } catch {}
  // Restore env so we don't leak the test DB name to other suites.
  if (PRIOR_MONGO_DB === undefined) delete process.env.MAPLE_MONGO_DB;
  else process.env.MAPLE_MONGO_DB = PRIOR_MONGO_DB;
});

describe('/api/search', () => {
  it('requires a bearer', async () => {
    if (!mongoReachable) return;
    const { searchRoutes } = await import('../../src/routes/search.ts');
    const { requireAuth } = await import('../../src/auth/middleware.ts');
    const app = new Elysia().use(requireAuth).use(searchRoutes);
    const r = await app.handle(new Request('http://localhost/api/search'));
    expect(r.status).toBe(401);
  });

  it('returns all live assets (4) when no filters', async () => {
    if (!mongoReachable) return;
    const { searchRoutes } = await import('../../src/routes/search.ts');
    const { requireAuth } = await import('../../src/auth/middleware.ts');
    const app = new Elysia().use(requireAuth).use(searchRoutes);

    const r = await app.handle(new Request('http://localhost/api/search', { headers: fmtAuth() }));
    expect(r.status).toBe(200);
    const body = (await r.json()) as { total: number; results: unknown[] };
    expect(body.total).toBe(4);
    expect(body.results.length).toBe(4);
  });

  it('filters by free-text q against filename', async () => {
    if (!mongoReachable) return;
    const { searchRoutes } = await import('../../src/routes/search.ts');
    const { requireAuth } = await import('../../src/auth/middleware.ts');
    const app = new Elysia().use(requireAuth).use(searchRoutes);

    const r = await app.handle(
      new Request('http://localhost/api/search?q=sunset', {
        headers: fmtAuth(),
      }),
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      total: number;
      results: Array<{ filename: string; id: string }>;
    };
    expect(body.total).toBe(1);
    expect(body.results[0]!.filename).toBe('sunset.cr3');
    expect(body.results[0]!.id).toBe('fs:/lib-a/sunset.cr3');
  });

  it('filters by camera (substring on make + model)', async () => {
    if (!mongoReachable) return;
    const { searchRoutes } = await import('../../src/routes/search.ts');
    const { requireAuth } = await import('../../src/auth/middleware.ts');
    const app = new Elysia().use(requireAuth).use(searchRoutes);

    const r = await app.handle(
      new Request('http://localhost/api/search?camera=Hasselblad', {
        headers: fmtAuth(),
      }),
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      total: number;
      results: Array<{ filename: string }>;
    };
    expect(body.total).toBe(1);
    expect(body.results[0]!.filename).toBe('dji-mavic3pro-100mp.dng');
  });

  it('filters by date range', async () => {
    if (!mongoReachable) return;
    const { searchRoutes } = await import('../../src/routes/search.ts');
    const { requireAuth } = await import('../../src/auth/middleware.ts');
    const app = new Elysia().use(requireAuth).use(searchRoutes);

    const r = await app.handle(
      new Request('http://localhost/api/search?from=2024-01-01&to=2024-12-31', {
        headers: fmtAuth(),
      }),
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      total: number;
      results: Array<{ filename: string }>;
    };
    // Hasselblad (2024-06-01) + Sony (2024-01-15) = 2
    expect(body.total).toBe(2);
  });

  it('filters by rating threshold', async () => {
    if (!mongoReachable) return;
    const { searchRoutes } = await import('../../src/routes/search.ts');
    const { requireAuth } = await import('../../src/auth/middleware.ts');
    const app = new Elysia().use(requireAuth).use(searchRoutes);

    const r = await app.handle(
      new Request('http://localhost/api/search?rating=4', {
        headers: fmtAuth(),
      }),
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as { total: number };
    // Hasselblad (5) + Sony (4) = 2
    expect(body.total).toBe(2);
  });

  it('scopes by libraryId', async () => {
    if (!mongoReachable) return;
    const { searchRoutes } = await import('../../src/routes/search.ts');
    const { requireAuth } = await import('../../src/auth/middleware.ts');
    const app = new Elysia().use(requireAuth).use(searchRoutes);

    const r = await app.handle(
      new Request(`http://localhost/api/search?libraryId=${folderA.toHexString()}`, {
        headers: fmtAuth(),
      }),
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      total: number;
      results: Array<{ folder_id: string }>;
    };
    expect(body.total).toBe(2);
    for (const row of body.results) {
      expect(row.folder_id).toBe(folderA.toHexString());
    }
  });

  it('filters by ext', async () => {
    if (!mongoReachable) return;
    const { searchRoutes } = await import('../../src/routes/search.ts');
    const { requireAuth } = await import('../../src/auth/middleware.ts');
    const app = new Elysia().use(requireAuth).use(searchRoutes);

    const r = await app.handle(
      new Request('http://localhost/api/search?ext=dng,cr3', {
        headers: fmtAuth(),
      }),
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      total: number;
      results: Array<{ filename: string }>;
    };
    expect(body.total).toBe(2);
    const names = body.results.map((r) => r.filename).sort();
    expect(names).toEqual(['dji-mavic3pro-100mp.dng', 'sunset.cr3']);
  });

  it('rejects invalid ext', async () => {
    if (!mongoReachable) return;
    const { searchRoutes } = await import('../../src/routes/search.ts');
    const { requireAuth } = await import('../../src/auth/middleware.ts');
    const app = new Elysia().use(requireAuth).use(searchRoutes);

    const r = await app.handle(
      new Request('http://localhost/api/search?ext=dng;cr3', {
        headers: fmtAuth(),
      }),
    );
    expect(r.status).toBe(400);
  });

  it('returns no matches for nonsense q', async () => {
    if (!mongoReachable) return;
    const { searchRoutes } = await import('../../src/routes/search.ts');
    const { requireAuth } = await import('../../src/auth/middleware.ts');
    const app = new Elysia().use(requireAuth).use(searchRoutes);

    const r = await app.handle(
      new Request('http://localhost/api/search?q=notarealfilename_xyzpdq', {
        headers: fmtAuth(),
      }),
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as { total: number; results: unknown[] };
    expect(body.total).toBe(0);
    expect(body.results.length).toBe(0);
  });

  it('paginates with limit + page', async () => {
    if (!mongoReachable) return;
    const { searchRoutes } = await import('../../src/routes/search.ts');
    const { requireAuth } = await import('../../src/auth/middleware.ts');
    const app = new Elysia().use(requireAuth).use(searchRoutes);

    const r1 = await app.handle(
      new Request('http://localhost/api/search?limit=2&page=0', {
        headers: fmtAuth(),
      }),
    );
    const r2 = await app.handle(
      new Request('http://localhost/api/search?limit=2&page=1', {
        headers: fmtAuth(),
      }),
    );
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    const b1 = (await r1.json()) as {
      total: number;
      results: Array<{ _id: string }>;
    };
    const b2 = (await r2.json()) as {
      total: number;
      results: Array<{ _id: string }>;
    };
    expect(b1.total).toBe(4);
    expect(b1.results.length).toBe(2);
    expect(b2.results.length).toBe(2);
    // Pages don't overlap.
    const ids1 = new Set(b1.results.map((r) => r._id));
    const ids2 = new Set(b2.results.map((r) => r._id));
    for (const id of ids2) expect(ids1.has(id)).toBe(false);
  });

  it('clamps an over-cap limit to 500', async () => {
    if (!mongoReachable) return;
    const { searchRoutes } = await import('../../src/routes/search.ts');
    const { requireAuth } = await import('../../src/auth/middleware.ts');
    const app = new Elysia().use(requireAuth).use(searchRoutes);

    // A caller asking past the cap gets it clamped, not honored — guards the
    // page-size ceiling against accidental changes.
    const r = await app.handle(
      new Request('http://localhost/api/search?limit=9999', { headers: fmtAuth() }),
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as { limit: number; results: unknown[] };
    expect(body.limit).toBe(500);
    expect(body.results.length).toBeLessThanOrEqual(500);
  });

  it('clamps an over-cap page to 10_000 (#2359)', async () => {
    if (!mongoReachable) return;
    const { searchRoutes } = await import('../../src/routes/search.ts');
    const { requireAuth } = await import('../../src/auth/middleware.ts');
    const app = new Elysia().use(requireAuth).use(searchRoutes);

    // Previously clamped to Number.MAX_SAFE_INTEGER, letting `skip = page *
    // limit` blow up for a trivially-crafted request. A page past the
    // ceiling is clamped, not honored, and still returns 200 rather than
    // erroring.
    //
    // Only the clamp itself is asserted. `results.length === 0` would be a
    // dataset-dependent side effect: page 10_000 is `skip = 10_000 * limit`,
    // so a corpus that large would legitimately return rows there and the
    // test would start failing for a reason that has nothing to do with the
    // ceiling.
    const overCap = await app.handle(
      new Request('http://localhost/api/search?page=99999999999', { headers: fmtAuth() }),
    );
    expect(overCap.status).toBe(200);
    expect(((await overCap.json()) as { page: number }).page).toBe(10_000);

    // The ceiling is where it claims to be, not merely "big numbers get
    // reduced to something": the last in-range page is returned unclamped.
    const atCap = await app.handle(
      new Request('http://localhost/api/search?page=10000', { headers: fmtAuth() }),
    );
    expect(atCap.status).toBe(200);
    expect(((await atCap.json()) as { page: number }).page).toBe(10_000);

    const belowCap = await app.handle(
      new Request('http://localhost/api/search?page=9999', { headers: fmtAuth() }),
    );
    expect(belowCap.status).toBe(200);
    expect(((await belowCap.json()) as { page: number }).page).toBe(9_999);
  });

  it('excludes soft-deleted rows', async () => {
    if (!mongoReachable) return;
    const { searchRoutes } = await import('../../src/routes/search.ts');
    const { requireAuth } = await import('../../src/auth/middleware.ts');
    const app = new Elysia().use(requireAuth).use(searchRoutes);

    const r = await app.handle(
      new Request('http://localhost/api/search?q=deleted', {
        headers: fmtAuth(),
      }),
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as { total: number };
    expect(body.total).toBe(0);
  });

  it('projects phasset_links (drives cross-device synced badge)', async () => {
    if (!mongoReachable) return;
    // Insert a row with phasset_links carrying BOTH a phid and a cloud id —
    // mirrors what backup-ingest writes when the device had iCloud Photos on.
    const db = mongo!.db(TEST_DB);
    const folderID = new ObjectId();
    await db.collection('folders').insertOne({
      _id: folderID,
      path: '/lib-c',
      label: 'lib-c',
      last_scan: null,
      file_count: 0,
      created_at: new Date().toISOString(),
    } as never);
    const { invalidateLibraryRoots } = await import('../../src/indexer/libraries.cache.ts');
    invalidateLibraryRoots();
    await db.collection('assets').insertOne({
      fileinfo: [
        {
          library_id: folderID,
          path: '',
          filename: 'with-phasset-links.heic',
          deleted_at: null,
        },
      ],
      size: 128,
      mtime: Date.now(),
      rating: 0,
      flag: 0,
      color_label: '',
      indexed_at: new Date().toISOString(),
      exif: null,
      phasset_links: [
        {
          device_id: 'device-A',
          phasset_local_id: 'DEVICE_A_PHID',
          phasset_cloud_id: 'icloud-XYZ',
          first_seen: new Date(),
        },
        {
          device_id: 'device-B',
          phasset_local_id: 'DEVICE_B_PHID',
          // Second device's row deliberately lacks a cloud id — exercises
          // the projection's "optional per-entry" behavior.
          first_seen: new Date(),
        },
      ],
    } as any);

    const { searchRoutes } = await import('../../src/routes/search.ts');
    const { requireAuth } = await import('../../src/auth/middleware.ts');
    const app = new Elysia().use(requireAuth).use(searchRoutes);

    const r = await app.handle(
      new Request(`http://localhost/api/search?libraryId=${folderID.toHexString()}`, {
        headers: fmtAuth(),
      }),
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      results: Array<{
        filename: string;
        phasset_links?: Array<{
          phasset_local_id: string;
          phasset_cloud_id?: string;
        }>;
      }>;
    };
    const hit = body.results.find((x) => x.filename === 'with-phasset-links.heic');
    expect(hit).toBeTruthy();
    expect(hit!.phasset_links).toBeTruthy();
    expect(hit!.phasset_links!.length).toBe(2);
    const byPhid = new Map(hit!.phasset_links!.map((l) => [l.phasset_local_id, l]));
    expect(byPhid.get('DEVICE_A_PHID')?.phasset_cloud_id).toBe('icloud-XYZ');
    expect(byPhid.get('DEVICE_B_PHID')?.phasset_cloud_id).toBeUndefined();
    // device_id and first_seen are stripped (merged-timeline doesn't need them).
    for (const link of hit!.phasset_links!) {
      expect((link as any).device_id).toBeUndefined();
      expect((link as any).first_seen).toBeUndefined();
    }
  });
});

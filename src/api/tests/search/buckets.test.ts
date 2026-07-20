/**
 * Tests for GET /api/search/buckets — year/month histogram for the
 * Timeline view — and the timeline-related filters (`pathPrefix`,
 * `hasCapturedAt`, bare-date widening) on GET /api/search.
 *
 * Owns its own self-contained fixtures (under folderC) so the suite can
 * make exact-count assertions without entangling with the list/facets
 * suites' base seed.
 *
 * Skip-passes if MongoDB is unreachable.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { Elysia } from 'elysia';
import { MongoClient, ObjectId } from 'mongodb';
import {
  backfillCapturedYearMonth,
  fmtAuth,
  materializeSeeds,
  seedFolders,
  tryConnect,
  type Seed,
} from './_setup.ts';

const TEST_DB = `maple_test_search_buckets_${process.pid}`;
const PRIOR_MONGO_DB = process.env.MAPLE_MONGO_DB;
process.env.MAPLE_MONGO_DB = TEST_DB;

let mongo: MongoClient | null = null;
let mongoReachable = false;

const folderC = new ObjectId();
// Marker prefix on filenames so we can scope this file's queries with `q`
// without entangling with global state.
const TL_MARK = `tl_${process.pid}`;

beforeAll(async () => {
  mongo = await tryConnect();
  mongoReachable = mongo !== null;
  if (!mongoReachable) {
    console.log('[search/buckets.test] skipping: MongoDB unreachable');
    return;
  }
  const db = mongo!.db(TEST_DB);
  await db.dropDatabase();

  // Buckets fixtures predate fileinfo[]; we keep them in the legacy
  // `{ folder_id, abs_path, filename }` shape for readability and let
  // `materializeSeeds` rewrite them to fileinfo[] at insert time. The
  // route under test reads `fileinfo.path` for `pathPrefix` matching
  // (post drop-abs-path-2026-05-21), so the assertion's `/A/`-style
  // wire prefixes still hit because `legacyToFileinfo` derives the
  // directory portion of each abs_path.
  await db.collection('folders').insertOne({
    _id: folderC,
    path: '/',
    label: 'buckets-lib',
    last_scan: null,
    file_count: 0,
    created_at: new Date().toISOString(),
  } as never);
  const { invalidateLibraryRoots } = await import('../../src/indexer/libraries.cache.ts');
  invalidateLibraryRoots();
  // `seedFolders` is the convention for the list/facets suites; this
  // file owns its own folderC so we inline the equivalent. Reference
  // here to keep the import path consistent with the other suites.
  void seedFolders;

  const seeds: Seed[] = [
    // pathPrefix fixtures: /A/1.dng, /A/B/2.dng, /C/3.dng. Plus a regex-
    // special path /A (1)/photo.dng to exercise escapeRegex.
    {
      folder_id: folderC,
      abs_path: '/A/1.dng',
      filename: `${TL_MARK}_pp1.tlraw`,
      size: 1024,
      mtime: 1,
      rating: 0,
      flag: 0,
      color_label: '',
      indexed_at: new Date().toISOString(),
      exif: {
        captured_at: '2025-03-10T12:00:00.000Z',
        camera_make: 'Nikon',
        camera_model: 'Z9',
        lens: null,
        iso: 200,
        aperture: 4.0,
        shutter: '1/500',
        focal_length: 85,
        gps: null,
      },
    },
    {
      folder_id: folderC,
      abs_path: '/A/B/2.dng',
      filename: `${TL_MARK}_pp2.tlraw`,
      size: 1024,
      mtime: 2,
      rating: 0,
      flag: 0,
      color_label: '',
      indexed_at: new Date().toISOString(),
      exif: {
        captured_at: '2025-03-15T12:00:00.000Z',
        camera_make: 'Nikon',
        camera_model: 'Z9',
        lens: null,
        iso: 200,
        aperture: 4.0,
        shutter: '1/500',
        focal_length: 85,
        gps: null,
      },
    },
    {
      folder_id: folderC,
      abs_path: '/C/3.dng',
      filename: `${TL_MARK}_pp3.tlraw`,
      size: 1024,
      mtime: 3,
      rating: 0,
      flag: 0,
      color_label: '',
      indexed_at: new Date().toISOString(),
      exif: {
        captured_at: '2025-04-10T12:00:00.000Z',
        camera_make: 'Nikon',
        camera_model: 'Z9',
        lens: null,
        iso: 200,
        aperture: 4.0,
        shutter: '1/500',
        focal_length: 85,
        gps: null,
      },
    },
    // Path with regex specials — verifies `escapeRegex` is wired.
    {
      folder_id: folderC,
      abs_path: '/A (1)/photo.dng',
      filename: `${TL_MARK}_pp4.tlraw`,
      size: 1024,
      mtime: 4,
      rating: 0,
      flag: 0,
      color_label: '',
      indexed_at: new Date().toISOString(),
      exif: {
        captured_at: '2025-05-10T12:00:00.000Z',
        camera_make: 'Nikon',
        camera_model: 'Z9',
        lens: null,
        iso: 200,
        aperture: 4.0,
        shutter: '1/500',
        focal_length: 85,
        gps: null,
      },
    },
    // pathPrefix + camera composition fixture: a row that matches /A/
    // but is NOT a Nikon — used to confirm AND-ing.
    {
      folder_id: folderC,
      abs_path: '/A/canon.dng',
      filename: `${TL_MARK}_pp5.tlraw`,
      size: 1024,
      mtime: 5,
      rating: 0,
      flag: 0,
      color_label: '',
      indexed_at: new Date().toISOString(),
      exif: {
        captured_at: '2025-06-10T12:00:00.000Z',
        camera_make: 'CanonTL',
        camera_model: 'EOS-TL',
        lens: null,
        iso: 200,
        aperture: 4.0,
        shutter: '1/500',
        focal_length: 85,
        gps: null,
      },
    },
    // Buckets fixture: assets across 2 years × 3 months for /buckets shape.
    // Counts: 2026/05=2, 2026/04=1, 2025/12=3 — so the sort is across years
    // and months and we can assert ordering deterministically.
    ...[
      { date: '2026-05-01T12:00:00.000Z', n: 2 },
      { date: '2026-04-01T12:00:00.000Z', n: 1 },
      { date: '2025-12-01T12:00:00.000Z', n: 3 },
    ].flatMap((b, gi) =>
      Array.from(
        { length: b.n },
        (_, i) =>
          ({
            folder_id: folderC,
            abs_path: `/buckets/${gi}-${i}.dng`,
            filename: `${TL_MARK}_b${gi}_${i}.tlraw`,
            size: 1024,
            mtime: 100 + gi * 10 + i,
            rating: 0,
            flag: 0 as -1 | 0 | 1,
            color_label: '',
            indexed_at: new Date().toISOString(),
            exif: {
              captured_at: b.date,
              camera_make: 'BucketCam',
              camera_model: 'BC-1',
              lens: null,
              iso: 200,
              aperture: 4.0,
              shutter: '1/500',
              focal_length: 85,
              gps: null,
            },
          }) as Seed,
      ),
    ),
    // Untimed rows — explicit null AND missing-field — to test the
    // (b)-branch missing-exif handling in /buckets.
    {
      folder_id: folderC,
      abs_path: '/buckets/untimed-null.dng',
      filename: `${TL_MARK}_un_null.tlraw`,
      size: 1024,
      mtime: 200,
      rating: 0,
      flag: 0,
      color_label: '',
      indexed_at: new Date().toISOString(),
      exif: {
        captured_at: null,
        camera_make: null,
        camera_model: null,
        lens: null,
        iso: null,
        aperture: null,
        shutter: null,
        focal_length: null,
        gps: null,
      },
    },
    // No `exif` key at all — Mongo stores this as a missing field.
    {
      folder_id: folderC,
      abs_path: '/buckets/untimed-missing.dng',
      filename: `${TL_MARK}_un_missing.tlraw`,
      size: 1024,
      mtime: 201,
      rating: 0,
      flag: 0,
      color_label: '',
      indexed_at: new Date().toISOString(),
      // exif intentionally omitted
    },
    // Date-boundary regression (S1): last-day-of-month capture. Used to
    // confirm that `to=2025-07-31` includes this row even though its
    // stored captured_at is `2025-07-31T23:30:00.000Z` (lexicographically
    // greater than the bare date).
    {
      folder_id: folderC,
      abs_path: '/boundary/last-day.dng',
      filename: `${TL_MARK}_eom.tlraw`,
      size: 1024,
      mtime: 400,
      rating: 0,
      flag: 0,
      color_label: '',
      indexed_at: new Date().toISOString(),
      exif: {
        captured_at: '2025-07-31T23:30:00.000Z',
        camera_make: 'BoundaryCam',
        camera_model: 'B-1',
        lens: null,
        iso: 200,
        aperture: 4.0,
        shutter: '1/500',
        focal_length: 85,
        gps: null,
      },
    },
    // Soft-deleted under /A/ — must NOT appear in pathPrefix or buckets.
    {
      folder_id: folderC,
      abs_path: '/A/deleted-tl.dng',
      filename: `${TL_MARK}_del.tlraw`,
      size: 1024,
      mtime: 300,
      rating: 0,
      flag: 0,
      color_label: '',
      indexed_at: new Date().toISOString(),
      exif: {
        captured_at: '2025-03-20T12:00:00.000Z',
        camera_make: 'Nikon',
        camera_model: 'Z9',
        lens: null,
        iso: 200,
        aperture: 4.0,
        shutter: '1/500',
        focal_length: 85,
        gps: null,
      },
      deleted_at: new Date().toISOString(),
    },
    // Soft-deleted AND untimed: regression seed for the `/buckets`
    // empty-query path. Before the buckets `untimedFilter` was switched
    // from spread-and-override-$or to `$and`, the soft-delete `$or`
    // clause produced by `applyLiveFilter({})` was silently dropped
    // when building `untimedFilter`, and this row leaked into
    // `untimed_count`. Now it must not.
    {
      folder_id: folderC,
      abs_path: '/buckets/deleted-untimed.dng',
      filename: `${TL_MARK}_del_untimed.tlraw`,
      size: 1024,
      mtime: 250,
      rating: 0,
      flag: 0,
      color_label: '',
      indexed_at: new Date().toISOString(),
      exif: null,
      deleted_at: new Date().toISOString(),
    },
  ];
  await db.collection('assets').insertMany(materializeSeeds(seeds) as never[]);
  await backfillCapturedYearMonth(db);

  // Reset the singleton DB connection — earlier tests in the suite may have
  // already cached `_db` pointing at a different database.
  const { closeDb } = await import('../../src/db/client.ts');
  await closeDb();
});

beforeEach(async () => {
  // Bucket responses are cached for 30 s — wipe between tests so each
  // assertion sees fresh aggregation results. Dynamic import: a
  // top-level static import would cause search.ts (and transitively
  // db/client.ts) to load BEFORE the file-level `process.env.MAPLE_MONGO_DB`
  // line ran, so the DB client would cache the default DB and the tests
  // would talk to the wrong database.
  const { _resetBucketsCacheForTests, _resetCacheForTests } =
    await import('../../src/routes/search.ts');
  _resetBucketsCacheForTests();
  // The list route's `total` cache (#2128) is likewise module-scoped for
  // the process lifetime — this file's own pathPrefix/timeline queries
  // hit `/api/search` directly (not just `/buckets`), and a *different*
  // test file using the same query-param shape (e.g. no filters at all)
  // would otherwise read back a `total` cached against that other file's
  // (different) TEST_DB. Reset alongside the buckets cache for the same
  // reason.
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

describe('/api/search timeline filters + buckets', () => {
  it('pathPrefix=/A/ returns rows under /A/ but not /C/', async () => {
    if (!mongoReachable) return;
    const { searchRoutes } = await import('../../src/routes/search.ts');
    const { requireAuth } = await import('../../src/auth/middleware.ts');
    const app = new Elysia().use(requireAuth).use(searchRoutes);

    const r = await app.handle(
      new Request(`http://localhost/api/search?pathPrefix=/A/&libraryId=${folderC.toHexString()}`, {
        headers: fmtAuth(),
      }),
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      total: number;
      results: Array<{ abs_path: string }>;
    };
    // /A/1.dng + /A/B/2.dng + /A/canon.dng. The /A (1)/photo.dng does NOT
    // start with the literal "/A/" so it's excluded. /C/3.dng is excluded.
    // Soft-deleted /A/deleted-tl.dng is excluded.
    // Post drop-abs-path-2026-05-21 the resolved abs_path is computed
    // from `fileinfo[0]` (library root + relDir + filename) at projection
    // time, so the assertions key off `fileinfo`-derived path prefixes
    // rather than raw legacy strings. Each seed's filename carries
    // `TL_MARK` plus a `_pp<n>` suffix; the test confirms the right
    // subset is returned by checking those suffixes.
    const paths = body.results.map((r) => r.abs_path);
    expect(paths.some((p) => p.startsWith('/A/') && p.endsWith('_pp1.tlraw'))).toBe(true);
    expect(paths.some((p) => p.startsWith('/A/B/') && p.endsWith('_pp2.tlraw'))).toBe(true);
    expect(paths.some((p) => p.startsWith('/A/') && p.endsWith('_pp5.tlraw'))).toBe(true);
    expect(paths.some((p) => p.startsWith('/C/'))).toBe(false);
    expect(paths.some((p) => p.includes('_del.tlraw'))).toBe(false);
    expect(body.total).toBe(3);
  });

  it('pathPrefix escapes regex specials (parentheses)', async () => {
    if (!mongoReachable) return;
    const { searchRoutes } = await import('../../src/routes/search.ts');
    const { requireAuth } = await import('../../src/auth/middleware.ts');
    const app = new Elysia().use(requireAuth).use(searchRoutes);

    const r = await app.handle(
      new Request(
        // /A (1)/ contains regex specials; without escapeRegex the regex
        // would be illegal or match unintended paths.
        `http://localhost/api/search?pathPrefix=${encodeURIComponent('/A (1)/')}&libraryId=${folderC.toHexString()}`,
        { headers: fmtAuth() },
      ),
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      total: number;
      results: Array<{ abs_path: string }>;
    };
    expect(body.total).toBe(1);
    // Resolved abs_path is composed from `fileinfo[0]` (library root + relDir
    // + filename); the seed's filename has the `TL_MARK`-prefixed sentinel
    // so check the directory portion + suffix instead of the legacy stub
    // basename.
    expect(body.results[0]!.abs_path.startsWith('/A (1)/')).toBe(true);
    expect(body.results[0]!.abs_path.endsWith('_pp4.tlraw')).toBe(true);
  });

  it('pathPrefix composes (AND) with q free-text', async () => {
    if (!mongoReachable) return;
    const { searchRoutes } = await import('../../src/routes/search.ts');
    const { requireAuth } = await import('../../src/auth/middleware.ts');
    const app = new Elysia().use(requireAuth).use(searchRoutes);

    // q matches both `${TL_MARK}_pp1.tlraw` (under /A/) and would match
    // `${TL_MARK}_pp3.tlraw` (under /C/) — adding pathPrefix=/A/ trims
    // it to just the row under /A/.
    const r = await app.handle(
      new Request(
        `http://localhost/api/search?q=${encodeURIComponent(TL_MARK)}&pathPrefix=/A/&libraryId=${folderC.toHexString()}`,
        { headers: fmtAuth() },
      ),
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      total: number;
      results: Array<{ abs_path: string }>;
    };
    expect(body.total).toBe(3);
    for (const row of body.results) {
      expect(row.abs_path.startsWith('/A/')).toBe(true);
    }
  });

  it('pathPrefix composes (AND) with camera (exercises $or → $and switch)', async () => {
    if (!mongoReachable) return;
    const { searchRoutes } = await import('../../src/routes/search.ts');
    const { requireAuth } = await import('../../src/auth/middleware.ts');
    const app = new Elysia().use(requireAuth).use(searchRoutes);

    // camera builds a $or; with q ALSO set, the existing code switches
    // those into a $and-of-$ors. pathPrefix is a top-level abs_path field
    // that must AND with that.
    const r = await app.handle(
      new Request(
        `http://localhost/api/search?camera=CanonTL&pathPrefix=/A/&libraryId=${folderC.toHexString()}`,
        { headers: fmtAuth() },
      ),
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      total: number;
      results: Array<{ abs_path: string }>;
    };
    expect(body.total).toBe(1);
    // Resolved abs_path key — see the pathPrefix=/A/ test above for the
    // background on why we assert on directory + filename-suffix rather
    // than the legacy stub basename.
    expect(body.results[0]!.abs_path.startsWith('/A/')).toBe(true);
    expect(body.results[0]!.abs_path.endsWith('_pp5.tlraw')).toBe(true);

    // And the same query with q + camera + pathPrefix — exercises the
    // explicit $and lift in buildFilter.
    const r2 = await app.handle(
      new Request(
        `http://localhost/api/search?q=${encodeURIComponent(TL_MARK)}&camera=CanonTL&pathPrefix=/A/&libraryId=${folderC.toHexString()}`,
        { headers: fmtAuth() },
      ),
    );
    expect(r2.status).toBe(200);
    const body2 = (await r2.json()) as { total: number };
    expect(body2.total).toBe(1);
  });

  it('hasCapturedAt=true excludes null AND missing-exif rows', async () => {
    if (!mongoReachable) return;
    const { searchRoutes } = await import('../../src/routes/search.ts');
    const { requireAuth } = await import('../../src/auth/middleware.ts');
    const app = new Elysia().use(requireAuth).use(searchRoutes);

    const r = await app.handle(
      new Request(
        // pathPrefix=/buckets/ scopes to the buckets fixture so we know the
        // exact composition: 2+1+3 timed + 2 untimed (one null, one missing).
        `http://localhost/api/search?pathPrefix=/buckets/&hasCapturedAt=true&libraryId=${folderC.toHexString()}&limit=200`,
        { headers: fmtAuth() },
      ),
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      total: number;
      results: Array<{ captured_at: string | null }>;
    };
    expect(body.total).toBe(6);
    for (const row of body.results) {
      expect(row.captured_at).not.toBeNull();
    }
  });

  it('hasCapturedAt=true composes with from/to without losing constraints', async () => {
    if (!mongoReachable) return;
    const { searchRoutes } = await import('../../src/routes/search.ts');
    const { requireAuth } = await import('../../src/auth/middleware.ts');
    const app = new Elysia().use(requireAuth).use(searchRoutes);

    // 2026 only — should match the 2 + 1 = 3 buckets fixture rows.
    const r = await app.handle(
      new Request(
        `http://localhost/api/search?pathPrefix=/buckets/&hasCapturedAt=true&from=2026-01-01&to=2026-12-31&libraryId=${folderC.toHexString()}&limit=200`,
        { headers: fmtAuth() },
      ),
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as { total: number };
    expect(body.total).toBe(3);
  });

  it('/buckets returns expected shape, sorted year/month desc', async () => {
    if (!mongoReachable) return;
    const { searchRoutes } = await import('../../src/routes/search.ts');
    const { requireAuth } = await import('../../src/auth/middleware.ts');
    const app = new Elysia().use(requireAuth).use(searchRoutes);

    const r = await app.handle(
      new Request(
        `http://localhost/api/search/buckets?pathPrefix=/buckets/&libraryId=${folderC.toHexString()}`,
        { headers: fmtAuth() },
      ),
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      total: number;
      buckets: Array<{ year: number; month: number; count: number }>;
      untimed_count: number;
    };
    expect(body.buckets).toEqual([
      { year: 2026, month: 5, count: 2 },
      { year: 2026, month: 4, count: 1 },
      { year: 2025, month: 12, count: 3 },
    ]);
    expect(body.total).toBe(6);
    expect(body.untimed_count).toBe(2);
  });

  it('/buckets untimed_count counts both null captured_at and missing exif', async () => {
    if (!mongoReachable) return;
    const { searchRoutes } = await import('../../src/routes/search.ts');
    const { requireAuth } = await import('../../src/auth/middleware.ts');
    const app = new Elysia().use(requireAuth).use(searchRoutes);

    const r = await app.handle(
      new Request(
        `http://localhost/api/search/buckets?pathPrefix=/buckets/&libraryId=${folderC.toHexString()}`,
        { headers: fmtAuth() },
      ),
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as { untimed_count: number };
    // Two seeded under /buckets/: one with `exif.captured_at: null`,
    // one with no `exif` field at all. Both must count. The third
    // /buckets/ row (`deleted-untimed.dng`) is soft-deleted, so the
    // live-row filter must drop it from `untimed_count`.
    expect(body.untimed_count).toBe(2);
  });

  it('/buckets with no filter excludes soft-deleted untimed rows', async () => {
    // Regression for the spread-vs-$and bug in `untimedFilter`. With no
    // top-level filter, `applyLiveFilter({})` returns the live-row
    // clause as `{ $or: [{ deleted_at: null }, { deleted_at: { $exists: false } }] }`.
    // Building `untimedFilter` as `{ ...finalFilter, $or: [...] }` used
    // to overwrite the live-row `$or` and count soft-deleted untimed
    // rows; switching to `{ $and: [finalFilter, { $or: [...] }] }` keeps
    // both predicates restrictive.
    if (!mongoReachable) return;
    const { searchRoutes } = await import('../../src/routes/search.ts');
    const { requireAuth } = await import('../../src/auth/middleware.ts');
    const app = new Elysia().use(requireAuth).use(searchRoutes);

    const r = await app.handle(
      new Request('http://localhost/api/search/buckets', {
        headers: fmtAuth(),
      }),
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as { untimed_count: number };
    // Across every seeded row in the test DB, exactly two are live AND
    // untimed (`/buckets/null-captured.dng`, `/buckets/no-exif.dng`).
    // The third untimed row (`/buckets/deleted-untimed.dng`) is
    // soft-deleted and must NOT contribute.
    expect(body.untimed_count).toBe(2);
  });

  it('/buckets honours pathPrefix and excludes soft-deleted rows', async () => {
    if (!mongoReachable) return;
    const { searchRoutes } = await import('../../src/routes/search.ts');
    const { requireAuth } = await import('../../src/auth/middleware.ts');
    const app = new Elysia().use(requireAuth).use(searchRoutes);

    // pathPrefix=/A/ has /A/1.dng (2025-03), /A/B/2.dng (2025-03),
    // /A/canon.dng (2025-06). The soft-deleted /A/deleted-tl.dng must NOT
    // appear in either timed or untimed counts.
    const r = await app.handle(
      new Request(
        `http://localhost/api/search/buckets?pathPrefix=/A/&libraryId=${folderC.toHexString()}`,
        { headers: fmtAuth() },
      ),
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      total: number;
      buckets: Array<{ year: number; month: number; count: number }>;
      untimed_count: number;
    };
    expect(body.total).toBe(3);
    expect(body.untimed_count).toBe(0);
    expect(body.buckets).toEqual([
      { year: 2025, month: 6, count: 1 },
      { year: 2025, month: 3, count: 2 },
    ]);
  });

  it('/buckets with empty result returns total: 0 + status 200', async () => {
    if (!mongoReachable) return;
    const { searchRoutes } = await import('../../src/routes/search.ts');
    const { requireAuth } = await import('../../src/auth/middleware.ts');
    const app = new Elysia().use(requireAuth).use(searchRoutes);

    const r = await app.handle(
      new Request(
        `http://localhost/api/search/buckets?pathPrefix=/does-not-exist/&libraryId=${folderC.toHexString()}`,
        { headers: fmtAuth() },
      ),
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      total: number;
      buckets: unknown[];
      untimed_count: number;
    };
    expect(body.total).toBe(0);
    expect(body.buckets).toEqual([]);
    expect(body.untimed_count).toBe(0);
  });

  it('rejects pathPrefix > 1024 chars', async () => {
    if (!mongoReachable) return;
    const { searchRoutes } = await import('../../src/routes/search.ts');
    const { requireAuth } = await import('../../src/auth/middleware.ts');
    const app = new Elysia().use(requireAuth).use(searchRoutes);

    const longPrefix = '/' + 'x'.repeat(1024);
    const r = await app.handle(
      new Request(`http://localhost/api/search?pathPrefix=${encodeURIComponent(longPrefix)}`, {
        headers: fmtAuth(),
      }),
    );
    expect(r.status).toBe(400);
  });

  it('date-boundary: bare to=YYYY-MM-DD includes last-day captures (S1)', async () => {
    if (!mongoReachable) return;
    const { searchRoutes } = await import('../../src/routes/search.ts');
    const { requireAuth } = await import('../../src/auth/middleware.ts');
    const app = new Elysia().use(requireAuth).use(searchRoutes);
    // Boundary fixture: 2025-07-31T23:30:00Z. With bare-date $lte: "2025-07-31"
    // and lex compare against the stored ISO datetime, this row would be
    // excluded. The widenToDate helper must extend `to` to T23:59:59.999Z.
    const r = await app.handle(
      new Request(
        `http://localhost/api/search?from=2025-07-01&to=2025-07-31&libraryId=${folderC.toHexString()}&q=${encodeURIComponent(TL_MARK)}`,
        { headers: fmtAuth() },
      ),
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      total: number;
      results: Array<{ abs_path: string }>;
    };
    expect(body.total).toBe(1);
    // Resolved abs_path key — see the pathPrefix=/A/ test for the
    // background on why we assert directory + filename-suffix.
    expect(body.results[0]!.abs_path.startsWith('/boundary/')).toBe(true);
    expect(body.results[0]!.abs_path.endsWith('_eom.tlraw')).toBe(true);
  });

  it('date-boundary: bare from=YYYY-MM-DD includes 00:00 captures (S1)', async () => {
    if (!mongoReachable) return;
    const { searchRoutes } = await import('../../src/routes/search.ts');
    const { requireAuth } = await import('../../src/auth/middleware.ts');
    const app = new Elysia().use(requireAuth).use(searchRoutes);
    // The 2026/04/01T12:00 bucket fixture should appear when from=2026-04-01.
    const r = await app.handle(
      new Request(
        `http://localhost/api/search?from=2026-04-01&to=2026-04-01&libraryId=${folderC.toHexString()}&q=${encodeURIComponent(TL_MARK)}`,
        { headers: fmtAuth() },
      ),
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as { total: number };
    expect(body.total).toBe(1);
  });

  it('date-boundary: full ISO datetimes pass through unchanged', async () => {
    if (!mongoReachable) return;
    const { searchRoutes } = await import('../../src/routes/search.ts');
    const { requireAuth } = await import('../../src/auth/middleware.ts');
    const app = new Elysia().use(requireAuth).use(searchRoutes);
    // Caller already passes a full datetime — must NOT be widened.
    const r = await app.handle(
      new Request(
        `http://localhost/api/search?from=${encodeURIComponent('2025-07-01T00:00:00.000Z')}&to=${encodeURIComponent('2025-07-31T22:00:00.000Z')}&libraryId=${folderC.toHexString()}&q=${encodeURIComponent(TL_MARK)}`,
        { headers: fmtAuth() },
      ),
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as { total: number };
    // Boundary fixture's captured_at is 23:30 — explicit to=22:00 must exclude it.
    expect(body.total).toBe(0);
  });

  it('hasCapturedAt=true with from-only constraint (no to)', async () => {
    if (!mongoReachable) return;
    const { searchRoutes } = await import('../../src/routes/search.ts');
    const { requireAuth } = await import('../../src/auth/middleware.ts');
    const app = new Elysia().use(requireAuth).use(searchRoutes);
    const r = await app.handle(
      new Request(
        `http://localhost/api/search?from=2026-01-01&hasCapturedAt=true&libraryId=${folderC.toHexString()}&q=${encodeURIComponent(TL_MARK)}`,
        { headers: fmtAuth() },
      ),
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as { total: number };
    // Bucket fixtures: 2026/05=2 + 2026/04=1 = 3 rows in 2026.
    expect(body.total).toBe(3);
  });

  it('hasCapturedAt=true with to-only constraint (no from)', async () => {
    if (!mongoReachable) return;
    const { searchRoutes } = await import('../../src/routes/search.ts');
    const { requireAuth } = await import('../../src/auth/middleware.ts');
    const app = new Elysia().use(requireAuth).use(searchRoutes);
    const r = await app.handle(
      new Request(
        `http://localhost/api/search?to=2024-12-31&hasCapturedAt=true&libraryId=${folderC.toHexString()}&q=${encodeURIComponent(TL_MARK)}`,
        { headers: fmtAuth() },
      ),
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as { total: number };
    // No fixtures earlier than 2025; all marker rows are 2025+.
    expect(body.total).toBe(0);
  });

  it('/buckets without pathPrefix matches everything in scope', async () => {
    if (!mongoReachable) return;
    const { searchRoutes } = await import('../../src/routes/search.ts');
    const { requireAuth } = await import('../../src/auth/middleware.ts');
    const app = new Elysia().use(requireAuth).use(searchRoutes);
    const r = await app.handle(
      new Request(
        `http://localhost/api/search/buckets?libraryId=${folderC.toHexString()}&q=${encodeURIComponent(TL_MARK)}`,
        { headers: fmtAuth() },
      ),
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      total: number;
      buckets: Array<{ year: number; month: number; count: number }>;
      untimed_count: number;
    };
    // Every TL-marked timed row goes into a bucket; untimed counts both null
    // and missing-exif rows.
    expect(body.untimed_count).toBe(2);
    expect(body.total).toBeGreaterThan(0);
    // Buckets are sorted year DESC then month DESC.
    for (let i = 1; i < body.buckets.length; i += 1) {
      const prev = body.buckets[i - 1]!;
      const cur = body.buckets[i]!;
      const prevKey = prev.year * 100 + prev.month;
      const curKey = cur.year * 100 + cur.month;
      expect(prevKey).toBeGreaterThan(curKey);
    }
  });

  it('/buckets composes with q free-text', async () => {
    if (!mongoReachable) return;
    const { searchRoutes } = await import('../../src/routes/search.ts');
    const { requireAuth } = await import('../../src/auth/middleware.ts');
    const app = new Elysia().use(requireAuth).use(searchRoutes);
    const r = await app.handle(
      new Request(
        `http://localhost/api/search/buckets?q=${encodeURIComponent('_eom')}&libraryId=${folderC.toHexString()}`,
        { headers: fmtAuth() },
      ),
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      total: number;
      buckets: Array<{ year: number; month: number; count: number }>;
    };
    // Only the boundary fixture matches the substring "_eom" — exactly 1
    // photo in 2025/07.
    expect(body.total).toBe(1);
    expect(body.buckets).toHaveLength(1);
    expect(body.buckets[0]!.year).toBe(2025);
    expect(body.buckets[0]!.month).toBe(7);
  });

  it('/buckets large libraries return all buckets (no 600 cap)', async () => {
    if (!mongoReachable) return;
    // Sanity: confirm the previous "too many buckets" cap is gone. With the
    // current fixture set (≪ 600 buckets), this just asserts the endpoint
    // returns 200 — the absence of a 400 here is what the test pins.
    const { searchRoutes } = await import('../../src/routes/search.ts');
    const { requireAuth } = await import('../../src/auth/middleware.ts');
    const app = new Elysia().use(requireAuth).use(searchRoutes);
    const r = await app.handle(
      new Request(`http://localhost/api/search/buckets?libraryId=${folderC.toHexString()}`, {
        headers: fmtAuth(),
      }),
    );
    expect(r.status).toBe(200);
  });

  it('ensureIndexes creates the fileinfo replacement indexes (idempotent)', async () => {
    if (!mongoReachable) return;
    const { ensureIndexes } = await import('../../src/db/client.ts');
    // Pre-create the auxiliary collections that ensureIndexes touches —
    // some Mongo operations (e.g. dropIndex on a fresh namespace) raise
    // NamespaceNotFound rather than IndexNotFound, which the production
    // code path doesn't need to handle because real deploys always have
    // these collections populated by the time ensureIndexes runs.
    const db = mongo!.db(TEST_DB);
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
    // Idempotent: call twice, second call must not throw.
    await ensureIndexes();
    await ensureIndexes();
    const indexes = await db.collection('assets').indexes();
    const names = new Set(indexes.map((i) => i.name as string));
    // The fileinfo replacement indexes are gated on the
    // `drop-abs-path-2026-05-21` migration. The migration runs only
    // when every live row has fileinfo[]; this suite's seed rows DO
    // carry fileinfo[] (via materializeSeeds), so the migration
    // proceeds and the new indexes land.
    // Pre-PR-7 fixture rows (other suites in the same bun process)
    // can defer the migration — when the migration is pending the
    // legacy `abs_path_1` index survives. Accept either state to
    // keep the assertion stable across suite-execution orders, while
    // still proving SOME content-addressed lookup path is in place.
    const hasFileinfoLib = names.has('fileinfo.library_id_1');
    const hasLegacyAbsPath = names.has('abs_path_1');
    expect(hasFileinfoLib || hasLegacyAbsPath).toBe(true);
  });
});

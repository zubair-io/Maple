/**
 * Regression coverage for #2128 — `GET /api/search` fetched and
 * blocking-sorted the entire matching set on every request.
 *
 * Two things are covered here:
 *   1. Plan-shape: the default-sort (`captured_desc`), library-scoped query
 *      must resolve to `LIMIT <- FETCH <- IXSCAN`, examining at most `limit`
 *      documents — not a blocking `SORT` over the whole matching set. This
 *      asserts directly on `explain('executionStats')` against the real
 *      `assets` collection (bypassing the HTTP layer, since `.explain()`
 *      isn't exposed over the wire) using the actual `buildFilter` /
 *      `applyLiveFilter` / `pickSort` helpers so the test tracks reality
 *      instead of a hand-rolled filter that could drift from the route.
 *   2. Count-cache: `total` (backed by `countDocuments`, a second
 *      independent O(N) scan even once the find is indexed) is cached for
 *      30 s keyed on the filter set, mirroring the buckets cache.
 *
 * Skip-passes if MongoDB is unreachable.
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { Elysia } from 'elysia';
import { MongoClient, ObjectId } from 'mongodb';
import { fmtAuth, tryConnect } from './_setup.ts';
import type { AssetDoc } from '../../src/db/schema.ts';

const TEST_DB = `maple_test_search_list_perf_${process.pid}`;
const PRIOR_MONGO_DB = process.env.MAPLE_MONGO_DB;
process.env.MAPLE_MONGO_DB = TEST_DB;

// "A few thousand is plenty" per #2128 — enough that the matching set
// (everything shares one `fileinfo.library_id`, so the equality bound
// isn't selective) comfortably exceeds `limit`, which is what makes the
// missing compound index bite. Verified empirically against this exact
// seed shape + the real `ensureIndexes()` output before landing this test.
const N = 3000;
const LIMIT = 120;

let mongo: MongoClient | null = null;
let mongoReachable = false;
const libraryId = new ObjectId();

const CAMS = [
  ['Hasselblad', 'L2D-20c'],
  ['Apple', 'iPhone 15 Pro'],
  ['SONY', 'ILCE-7RM5'],
  ['Canon', 'EOS R5'],
] as const;

function makeSeedDoc(i: number): Record<string, unknown> {
  const [make, model] = CAMS[i % CAMS.length]!;
  const captured = new Date(
    Date.UTC(2015 + (i % 10), i % 12, (i % 27) + 1, i % 24, i % 60, i % 60),
  ).toISOString();
  return {
    fileinfo: [
      {
        library_id: libraryId,
        path: `2024/${i % 50}`,
        filename: `DJI_${String(i).padStart(6, '0')}.dng`,
        deleted_at: null,
        missing_since: null,
      },
    ],
    size: 50_000_000 + i,
    mtime: 1_700_000_000_000 + i,
    rating: 0,
    flag: 0,
    color_label: '',
    exif: {
      captured_at: captured,
      camera_make: make,
      camera_model: model,
      lens: '24mm f/2.8',
      iso: 100,
      aperture: 2.8,
      shutter: '1/500',
      focal_length: 24,
      gps: null,
    },
    indexed_at: captured,
    deleted_at: null,
  };
}

/** Walk a winning-plan tree (classic `inputStage`/`inputStages` shape) and
 * report whether a blocking `SORT` stage appears anywhere in it. */
function hasSortStage(stage: unknown): boolean {
  if (!stage || typeof stage !== 'object') return false;
  const s = stage as { stage?: string; inputStage?: unknown; inputStages?: unknown[] };
  if (s.stage === 'SORT') return true;
  if (s.inputStage) return hasSortStage(s.inputStage);
  if (Array.isArray(s.inputStages)) return s.inputStages.some(hasSortStage);
  return false;
}

beforeAll(async () => {
  mongo = await tryConnect();
  mongoReachable = mongo !== null;
  if (!mongoReachable) {
    console.log('[search/list-perf.test] skipping: MongoDB unreachable');
    return;
  }
  const db = mongo!.db(TEST_DB);
  await db.dropDatabase();

  const docs: Record<string, unknown>[] = [];
  for (let i = 0; i < N; i++) docs.push(makeSeedDoc(i));
  // Batch inserts — a single 3000-doc insertMany is fine, but batching
  // mirrors the seeding convention used by the throwaway perf harness this
  // test was derived from and keeps any single batch small.
  const BATCH = 1000;
  for (let i = 0; i < docs.length; i += BATCH) {
    await db.collection('assets').insertMany(docs.slice(i, i + BATCH) as never[]);
  }

  // Pre-create the auxiliary collections `ensureIndexes` touches — some
  // Mongo operations (e.g. dropIndex on a fresh namespace) raise
  // NamespaceNotFound rather than IndexNotFound, which the production code
  // path doesn't need to handle because real deploys always have these
  // collections populated by the time ensureIndexes runs. Mirrors
  // buckets.test.ts's `ensureIndexes creates ...` test.
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

  // Reset the singleton DB connection so `ensureIndexes` (and the route
  // under test) target TEST_DB rather than whatever an earlier suite left
  // cached, then build the real index set — this is what the plan-shape
  // assertion below depends on.
  const { closeDb, ensureIndexes } = await import('../../src/db/client.ts');
  await closeDb();
  await ensureIndexes();
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

describe('GET /api/search — default-sort query plan (#2128)', () => {
  it('resolves the default-sort, library-scoped, hasCapturedAt query to an index-only LIMIT — no blocking SORT, no more than `limit` docs examined', async () => {
    if (!mongoReachable) return;
    const { buildFilter, applyLiveFilter } = await import('../../src/routes/search/query.ts');
    const { pickSort } = await import('../../src/routes/search/sort.ts');

    // Mirrors the issue's repro exactly:
    //   GET /api/search?libraryId=<id>&hasCapturedAt=true&sort=captured_desc&page=0&limit=120
    const filterOrError = buildFilter({
      libraryId: libraryId.toHexString(),
      hasCapturedAt: 'true',
    });
    if ('error' in filterOrError) throw new Error(filterOrError.error);
    const finalFilter = applyLiveFilter(filterOrError);
    const sortSpec = pickSort('captured_desc');

    const db = mongo!.db(TEST_DB);
    const exp = await db
      .collection<AssetDoc>('assets')
      .find(finalFilter)
      .sort(sortSpec)
      .skip(0)
      .limit(LIMIT)
      .explain('executionStats');
    const stats = exp.executionStats as {
      totalDocsExamined: number;
      executionStages: unknown;
    };

    expect(stats.totalDocsExamined).toBeLessThanOrEqual(LIMIT);
    expect(hasSortStage(stats.executionStages)).toBe(false);
  });
});

describe('GET /api/search — total-count cache (#2128)', () => {
  it('serves `total` from cache within the TTL, and reflects new data once reset', async () => {
    if (!mongoReachable) return;
    const { searchRoutes, _resetCacheForTests } = await import('../../src/routes/search.ts');
    const { requireAuth } = await import('../../src/auth/middleware.ts');
    _resetCacheForTests();

    const app = new Elysia().use(requireAuth).use(searchRoutes);
    const url = `http://localhost/api/search?libraryId=${libraryId.toHexString()}&hasCapturedAt=true&limit=${LIMIT}`;

    const r1 = await app.handle(new Request(url, { headers: fmtAuth() }));
    expect(r1.status).toBe(200);
    const body1 = (await r1.json()) as { total: number };
    expect(body1.total).toBe(N);

    // Insert more matching docs directly (bypassing the route) — the true
    // count is now higher, but a same-key request within the 30 s TTL must
    // still return the stale cached value.
    const db = mongo!.db(TEST_DB);
    await db.collection('assets').insertMany([makeSeedDoc(N), makeSeedDoc(N + 1)] as never[]);

    const r2 = await app.handle(new Request(url, { headers: fmtAuth() }));
    expect(r2.status).toBe(200);
    const body2 = (await r2.json()) as { total: number };
    expect(body2.total).toBe(N);

    // Busting the cache picks up the new true count on the next request.
    _resetCacheForTests();
    const r3 = await app.handle(new Request(url, { headers: fmtAuth() }));
    expect(r3.status).toBe(200);
    const body3 = (await r3.json()) as { total: number };
    expect(body3.total).toBe(N + 2);

    // Clean up the extra docs so later tests in this file see the original N.
    await db.collection('assets').deleteMany({
      'fileinfo.filename': {
        $in: [`DJI_${String(N).padStart(6, '0')}.dng`, `DJI_${String(N + 1).padStart(6, '0')}.dng`],
      },
    });
    _resetCacheForTests();
  });

  it("keys the cache on the full filter set — a different filter is not served from another filter's cache entry", async () => {
    if (!mongoReachable) return;
    const { searchRoutes, _resetCacheForTests } = await import('../../src/routes/search.ts');
    const { requireAuth } = await import('../../src/auth/middleware.ts');
    _resetCacheForTests();

    const app = new Elysia().use(requireAuth).use(searchRoutes);
    const otherLibraryId = new ObjectId().toHexString();

    const rMatching = await app.handle(
      new Request(
        `http://localhost/api/search?libraryId=${libraryId.toHexString()}&hasCapturedAt=true&limit=${LIMIT}`,
        { headers: fmtAuth() },
      ),
    );
    const rOther = await app.handle(
      new Request(`http://localhost/api/search?libraryId=${otherLibraryId}&limit=${LIMIT}`, {
        headers: fmtAuth(),
      }),
    );
    expect(rMatching.status).toBe(200);
    expect(rOther.status).toBe(200);
    const bodyMatching = (await rMatching.json()) as { total: number };
    const bodyOther = (await rOther.json()) as { total: number };
    expect(bodyMatching.total).toBe(N);
    expect(bodyOther.total).toBe(0);
    _resetCacheForTests();
  });
});

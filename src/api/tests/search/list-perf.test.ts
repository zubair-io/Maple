/**
 * Regression coverage for #2128 — `GET /api/search` fetched and
 * blocking-sorted the entire matching set on every request, and counted it
 * again on top.
 *
 * What survives here is the second half: `total` is cached for 30 s keyed on
 * the filter set, mirroring the buckets cache. The first half — the plan
 * shape — moved with the query itself: `db/sqlite/repos/search.query-plan.test.ts`
 * pins the page statement to the ordered live index with `EXPLAIN QUERY PLAN`,
 * including the filtered case that was the original bug, and it does so
 * against the statement the route actually issues rather than a filter
 * rebuilt in the test.
 *
 * Real SQLite, installed as the process-wide handle for the file.
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { Elysia } from 'elysia';
import { fmtAuth } from './_setup.ts';
import { newObjectIdHex } from '../../src/db/sqlite/object-id.ts';
import { seedSearchAsset } from '../../src/db/sqlite/repos/search.test-helpers.ts';
import {
  createLiveTestDatabase,
  insertFolder,
  run,
  type LiveTestDatabase,
} from '../../src/db/sqlite/test-sqlite.test-helpers.ts';

// Enough rows that the matching set comfortably exceeds `limit` — the page
// and the count answer different questions, and a cache that served one from
// the other would not be visible on a three-row fixture.
const N = 3000;
const LIMIT = 120;

let live: LiveTestDatabase;
let libraryId: string;

const CAMS = [
  ['Hasselblad', 'L2D-20c'],
  ['Apple', 'iPhone 15 Pro'],
  ['SONY', 'ILCE-7RM5'],
  ['Canon', 'EOS R5'],
] as const;

/** One seeded row, varying enough to be distinguishable but all matching. */
function seedRow(index: number): string {
  const [cameraMake, cameraModel] = CAMS[index % CAMS.length]!;
  const capturedAt = new Date(
    Date.UTC(2015 + (index % 10), index % 12, (index % 27) + 1, index % 24, index % 60, index % 60),
  ).toISOString();
  return seedSearchAsset(live.db, libraryId, {
    filename: `DJI_${String(index).padStart(6, '0')}.dng`,
    path: `2024/${index % 50}`,
    capturedAt,
    cameraMake,
    cameraModel,
    lens: '24mm f/2.8',
    iso: 100,
    aperture: 2.8,
    focalLength: 24,
  });
}

beforeAll(async () => {
  live = await createLiveTestDatabase();
  libraryId = insertFolder(live.db, { path: '/lib-perf', slug: 'lib-perf' });
  live.db.transaction(() => {
    for (let i = 0; i < N; i += 1) seedRow(i);
  })();
});

afterAll(() => {
  live.close();
});

async function searchApp() {
  const { searchRoutes } = await import('../../src/routes/search.ts');
  const { requireAuth } = await import('../../src/auth/middleware.ts');
  return new Elysia().use(requireAuth).use(searchRoutes);
}

type SearchApp = Awaited<ReturnType<typeof searchApp>>;

async function total(app: SearchApp, url: string): Promise<number> {
  const r = await app.handle(new Request(url, { headers: fmtAuth() }));
  expect(r.status).toBe(200);
  return ((await r.json()) as { total: number }).total;
}

describe('GET /api/search — total-count cache (#2128)', () => {
  it('serves `total` from cache within the TTL, and reflects new data once reset', async () => {
    const { _resetCacheForTests } = await import('../../src/routes/search.ts');
    _resetCacheForTests();

    const app = await searchApp();
    const url = `http://localhost/api/search?libraryId=${libraryId}&hasCapturedAt=true&limit=${LIMIT}`;

    expect(await total(app, url)).toBe(N);

    // Insert more matching rows directly (bypassing the route) — the true
    // count is now higher, but a same-key request within the 30 s TTL must
    // still return the stale cached value.
    const extra = [seedRow(N), seedRow(N + 1)];
    expect(await total(app, url)).toBe(N);

    // Busting the cache picks up the new true count on the next request.
    _resetCacheForTests();
    expect(await total(app, url)).toBe(N + 2);

    // Clean up the extra rows so later tests in this file see the original N.
    for (const id of extra) run(live.db, `DELETE FROM assets WHERE id = ?`, id);
    _resetCacheForTests();
  });

  it("keys the cache on the full filter set — a different filter is not served from another filter's cache entry", async () => {
    const { _resetCacheForTests } = await import('../../src/routes/search.ts');
    _resetCacheForTests();

    const app = await searchApp();
    const otherLibraryId = newObjectIdHex();

    const matching = await total(
      app,
      `http://localhost/api/search?libraryId=${libraryId}&hasCapturedAt=true&limit=${LIMIT}`,
    );
    const other = await total(
      app,
      `http://localhost/api/search?libraryId=${otherLibraryId}&limit=${LIMIT}`,
    );
    expect(matching).toBe(N);
    expect(other).toBe(0);
    _resetCacheForTests();
  });
});

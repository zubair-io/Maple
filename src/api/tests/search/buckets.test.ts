/**
 * Tests for GET /api/search/buckets — year/month histogram for the
 * Timeline view — and the timeline-related filters (`pathPrefix`,
 * `hasCapturedAt`, bare-date widening) on GET /api/search.
 *
 * Owns its own self-contained fixtures (under one library whose root is `/`)
 * so the suite can make exact-count assertions without entangling with the
 * list/facets suites' base seed.
 *
 * Real SQLite, installed as the process-wide handle for the file.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { Elysia } from 'elysia';
import { fmtAuth } from './_setup.ts';
import { seedSearchAsset, type SeedAsset } from '../../src/db/repos/search.test-helpers.ts';
import {
  createLiveTestDatabase,
  insertFolder,
  type LiveTestDatabase,
} from '../../src/db/sqlite/test-sqlite.test-helpers.ts';

let live: LiveTestDatabase;
let libraryId: string;

// Marker prefix on filenames so the suite can scope its queries with `q`.
const TL_MARK = `tl_${process.pid}`;

/** A Nikon row at `path`, captured on `capturedAt`. */
function nikon(path: string, name: string, capturedAt: string): SeedAsset {
  return {
    filename: `${TL_MARK}_${name}.tlraw`,
    path,
    capturedAt,
    cameraMake: 'Nikon',
    cameraModel: 'Z9',
    iso: 200,
    aperture: 4.0,
    focalLength: 85,
  };
}

beforeAll(async () => {
  live = await createLiveTestDatabase();
  // Root `/` so an asset at `path: 'A'` resolves to `/A/<filename>` and the
  // wire assertions can read as absolute paths.
  libraryId = insertFolder(live.db, { path: '/', slug: 'buckets-lib' });

  const seeds: SeedAsset[] = [
    // pathPrefix fixtures: A/1, A/B/2, C/3. Plus a path carrying characters
    // that used to be regex metacharacters — `A (1)` must not match `A`.
    nikon('A', 'pp1', '2025-03-10T12:00:00.000Z'),
    nikon('A/B', 'pp2', '2025-03-15T12:00:00.000Z'),
    nikon('C', 'pp3', '2025-04-10T12:00:00.000Z'),
    nikon('A (1)', 'pp4', '2025-05-10T12:00:00.000Z'),
    // pathPrefix + camera composition fixture: a row under A that is NOT a
    // Nikon — used to confirm AND-ing.
    {
      filename: `${TL_MARK}_pp5.tlraw`,
      path: 'A',
      capturedAt: '2025-06-10T12:00:00.000Z',
      cameraMake: 'CanonTL',
      cameraModel: 'EOS-TL',
      iso: 200,
      aperture: 4.0,
      focalLength: 85,
    },
    // Buckets fixture: assets across 2 years × 3 months for the /buckets
    // shape. Counts 2026/05=2, 2026/04=1, 2025/12=3 — so the sort runs
    // across both years and months and the ordering is deterministic.
    ...[
      { date: '2026-05-01T12:00:00.000Z', n: 2 },
      { date: '2026-04-01T12:00:00.000Z', n: 1 },
      { date: '2025-12-01T12:00:00.000Z', n: 3 },
    ].flatMap((bucket, gi) =>
      Array.from({ length: bucket.n }, (_, i) => ({
        filename: `${TL_MARK}_b${gi}_${i}.tlraw`,
        path: 'buckets',
        capturedAt: bucket.date,
        cameraMake: 'BucketCam',
        cameraModel: 'BC-1',
        iso: 200,
        aperture: 4.0,
        focalLength: 85,
      })),
    ),
    // Two untimed rows under `buckets`, for the histogram's second branch.
    { filename: `${TL_MARK}_un_null.tlraw`, path: 'buckets', capturedAt: null },
    { filename: `${TL_MARK}_un_missing.tlraw`, path: 'buckets', capturedAt: null },
    // Date-boundary regression (S1): a last-day-of-month capture. Confirms
    // `to=2025-07-31` includes this row even though its stored captured_at is
    // 23:30 — lexicographically greater than the bare date.
    {
      filename: `${TL_MARK}_eom.tlraw`,
      path: 'boundary',
      capturedAt: '2025-07-31T23:30:00.000Z',
      cameraMake: 'BoundaryCam',
      cameraModel: 'B-1',
      iso: 200,
      aperture: 4.0,
      focalLength: 85,
    },
    // Soft-deleted under A — must NOT appear in pathPrefix results or buckets.
    { ...nikon('A', 'del', '2025-03-20T12:00:00.000Z'), deletedAt: '2026-01-01T00:00:00.000Z' },
    // Soft-deleted AND untimed: must not leak into `untimed_count`, which is
    // the regression the Mongo route needed an explicit `$and` for.
    {
      filename: `${TL_MARK}_del_untimed.tlraw`,
      path: 'buckets',
      capturedAt: null,
      deletedAt: '2026-01-01T00:00:00.000Z',
    },
  ];
  for (const seed of seeds) seedSearchAsset(live.db, libraryId, seed);
});

beforeEach(async () => {
  // Bucket responses are cached for 30 s — wipe between tests so each
  // assertion sees fresh aggregation results. The list route's `total` cache
  // (#2128) is likewise module-scoped for the process lifetime, and this file
  // hits `/api/search` directly as well as `/buckets`, so both are reset.
  const { _resetBucketsCacheForTests, _resetCacheForTests } =
    await import('../../src/routes/search.ts');
  _resetBucketsCacheForTests();
  _resetCacheForTests();
});

afterAll(() => {
  live.close();
});

interface ListBody {
  total: number;
  results: Array<{ abs_path: string; captured_at: string | null }>;
}

interface BucketsBody {
  total: number;
  buckets: Array<{ year: number; month: number; count: number }>;
  untimed_count: number;
}

async function get(path: string): Promise<{ status: number; body: unknown }> {
  const { searchRoutes } = await import('../../src/routes/search.ts');
  const { requireAuth } = await import('../../src/auth/middleware.ts');
  const app = new Elysia().use(requireAuth).use(searchRoutes);
  const r = await app.handle(new Request(`http://localhost${path}`, { headers: fmtAuth() }));
  return { status: r.status, body: await r.json() };
}

/** `GET /api/search`, already scoped to this file's library. */
async function search(qs: string): Promise<{ status: number; body: ListBody }> {
  const { status, body } = await get(`/api/search?libraryId=${libraryId}&${qs}`);
  return { status, body: body as ListBody };
}

/** `GET /api/search/buckets`, already scoped to this file's library. */
async function buckets(qs = ''): Promise<{ status: number; body: BucketsBody }> {
  const { status, body } = await get(`/api/search/buckets?libraryId=${libraryId}&${qs}`);
  return { status, body: body as BucketsBody };
}

describe('/api/search timeline filters + buckets', () => {
  it('pathPrefix=/A/ returns rows under /A/ but not /C/', async () => {
    const { status, body } = await search('pathPrefix=/A/');
    expect(status).toBe(200);
    // A/1 + A/B/2 + A/canon. `A (1)/photo` does NOT start with the literal
    // "A/" so it is excluded, as is C/3 and the soft-deleted row under A.
    const paths = body.results.map((r) => r.abs_path);
    expect(paths.some((p) => p.startsWith('/A/') && p.endsWith('_pp1.tlraw'))).toBe(true);
    expect(paths.some((p) => p.startsWith('/A/B/') && p.endsWith('_pp2.tlraw'))).toBe(true);
    expect(paths.some((p) => p.startsWith('/A/') && p.endsWith('_pp5.tlraw'))).toBe(true);
    expect(paths.some((p) => p.startsWith('/C/'))).toBe(false);
    expect(paths.some((p) => p.includes('_del.tlraw'))).toBe(false);
    expect(body.total).toBe(3);
  });

  it('pathPrefix treats punctuation literally (parentheses)', async () => {
    // `A (1)` used to be interpolated into a regex, where the parentheses
    // were a capture group. It is an equality test and a prefix comparison
    // now, so the characters carry no meaning and this matches one row.
    const { status, body } = await search(`pathPrefix=${encodeURIComponent('/A (1)/')}`);
    expect(status).toBe(200);
    expect(body.total).toBe(1);
    expect(body.results[0]!.abs_path.startsWith('/A (1)/')).toBe(true);
    expect(body.results[0]!.abs_path.endsWith('_pp4.tlraw')).toBe(true);
  });

  it('pathPrefix composes (AND) with q free-text', async () => {
    // q matches every marker row, including the one under C — adding
    // pathPrefix=/A/ trims it to the rows under A.
    const { status, body } = await search(`q=${encodeURIComponent(TL_MARK)}&pathPrefix=/A/`);
    expect(status).toBe(200);
    expect(body.total).toBe(3);
    for (const row of body.results) expect(row.abs_path.startsWith('/A/')).toBe(true);
  });

  it('pathPrefix composes (AND) with camera', async () => {
    const { status, body } = await search('camera=CanonTL&pathPrefix=/A/');
    expect(status).toBe(200);
    expect(body.total).toBe(1);
    expect(body.results[0]!.abs_path.startsWith('/A/')).toBe(true);
    expect(body.results[0]!.abs_path.endsWith('_pp5.tlraw')).toBe(true);

    // The same query with q as well — three filters over three different
    // tables, all of which must narrow rather than replace each other.
    const both = await search(`q=${encodeURIComponent(TL_MARK)}&camera=CanonTL&pathPrefix=/A/`);
    expect(both.status).toBe(200);
    expect(both.body.total).toBe(1);
  });

  it('hasCapturedAt=true excludes undated rows', async () => {
    // pathPrefix=/buckets/ scopes to the buckets fixture so the composition
    // is known: 2+1+3 timed, plus 2 untimed.
    const { status, body } = await search('pathPrefix=/buckets/&hasCapturedAt=true&limit=200');
    expect(status).toBe(200);
    expect(body.total).toBe(6);
    for (const row of body.results) expect(row.captured_at).not.toBeNull();
  });

  it('hasCapturedAt=true composes with from/to without losing constraints', async () => {
    // 2026 only — the 2 + 1 = 3 buckets fixture rows.
    const { status, body } = await search(
      'pathPrefix=/buckets/&hasCapturedAt=true&from=2026-01-01&to=2026-12-31&limit=200',
    );
    expect(status).toBe(200);
    expect(body.total).toBe(3);
  });

  it('/buckets returns expected shape, sorted year/month desc', async () => {
    const { status, body } = await buckets('pathPrefix=/buckets/');
    expect(status).toBe(200);
    expect(body.buckets).toEqual([
      { year: 2026, month: 5, count: 2 },
      { year: 2026, month: 4, count: 1 },
      { year: 2025, month: 12, count: 3 },
    ]);
    expect(body.total).toBe(6);
    expect(body.untimed_count).toBe(2);
  });

  it('/buckets untimed_count excludes the soft-deleted undated row', async () => {
    const { status, body } = await buckets('pathPrefix=/buckets/');
    expect(status).toBe(200);
    // Three undated rows are seeded under `buckets`; the third is
    // soft-deleted, so the live predicate must drop it.
    expect(body.untimed_count).toBe(2);
  });

  it('/buckets with no filter excludes soft-deleted untimed rows', async () => {
    // Regression for the Mongo route's spread-vs-`$and` bug in
    // `untimedFilter`, where the soft-delete clause was silently overwritten
    // and this row leaked into `untimed_count`. The predicate is composed in
    // one place now (`searchWhereSql`), so there is nothing left to overwrite
    // — this holds that.
    const { status, body } = await get('/api/search/buckets');
    expect(status).toBe(200);
    expect((body as BucketsBody).untimed_count).toBe(2);
  });

  it('/buckets honours pathPrefix and excludes soft-deleted rows', async () => {
    // pathPrefix=/A/ has A/1 (2025-03), A/B/2 (2025-03), A/canon (2025-06).
    // The soft-deleted row under A must appear in neither count.
    const { status, body } = await buckets('pathPrefix=/A/');
    expect(status).toBe(200);
    expect(body.total).toBe(3);
    expect(body.untimed_count).toBe(0);
    expect(body.buckets).toEqual([
      { year: 2025, month: 6, count: 1 },
      { year: 2025, month: 3, count: 2 },
    ]);
  });

  it('/buckets with empty result returns total: 0 + status 200', async () => {
    const { status, body } = await buckets('pathPrefix=/does-not-exist/');
    expect(status).toBe(200);
    expect(body.total).toBe(0);
    expect(body.buckets).toEqual([]);
    expect(body.untimed_count).toBe(0);
  });

  it('rejects pathPrefix > 1024 chars', async () => {
    const longPrefix = '/' + 'x'.repeat(1024);
    const { status } = await get(`/api/search?pathPrefix=${encodeURIComponent(longPrefix)}`);
    expect(status).toBe(400);
  });

  it('date-boundary: bare to=YYYY-MM-DD includes last-day captures (S1)', async () => {
    // Boundary fixture: 2025-07-31T23:30:00Z. With a bare `to` of
    // "2025-07-31" compared lexicographically against the stored ISO
    // datetime, this row would be excluded — `widenToDate` extends the bound
    // to T23:59:59.999Z.
    const { status, body } = await search(
      `from=2025-07-01&to=2025-07-31&q=${encodeURIComponent(TL_MARK)}`,
    );
    expect(status).toBe(200);
    expect(body.total).toBe(1);
    expect(body.results[0]!.abs_path.startsWith('/boundary/')).toBe(true);
    expect(body.results[0]!.abs_path.endsWith('_eom.tlraw')).toBe(true);
  });

  it('date-boundary: bare from=YYYY-MM-DD includes 00:00 captures (S1)', async () => {
    // The 2026-04-01T12:00 bucket fixture should appear when from=2026-04-01.
    const { status, body } = await search(
      `from=2026-04-01&to=2026-04-01&q=${encodeURIComponent(TL_MARK)}`,
    );
    expect(status).toBe(200);
    expect(body.total).toBe(1);
  });

  it('date-boundary: full ISO datetimes pass through unchanged', async () => {
    // A caller who already passed a full datetime must not have it widened.
    const { status, body } = await search(
      `from=${encodeURIComponent('2025-07-01T00:00:00.000Z')}` +
        `&to=${encodeURIComponent('2025-07-31T22:00:00.000Z')}` +
        `&q=${encodeURIComponent(TL_MARK)}`,
    );
    expect(status).toBe(200);
    // The boundary fixture's capture is at 23:30 — an explicit 22:00 upper
    // bound must exclude it.
    expect(body.total).toBe(0);
  });

  it('hasCapturedAt=true with from-only constraint (no to)', async () => {
    const { status, body } = await search(
      `from=2026-01-01&hasCapturedAt=true&q=${encodeURIComponent(TL_MARK)}`,
    );
    expect(status).toBe(200);
    // Bucket fixtures: 2026/05=2 + 2026/04=1 = 3 rows in 2026.
    expect(body.total).toBe(3);
  });

  it('hasCapturedAt=true with to-only constraint (no from)', async () => {
    const { status, body } = await search(
      `to=2024-12-31&hasCapturedAt=true&q=${encodeURIComponent(TL_MARK)}`,
    );
    expect(status).toBe(200);
    // No fixtures earlier than 2025; all marker rows are 2025+.
    expect(body.total).toBe(0);
  });

  it('/buckets without pathPrefix matches everything in scope', async () => {
    const { status, body } = await buckets(`q=${encodeURIComponent(TL_MARK)}`);
    expect(status).toBe(200);
    // Every marked timed row goes into a bucket; the undated ones are
    // counted separately.
    expect(body.untimed_count).toBe(2);
    expect(body.total).toBeGreaterThan(0);
    // Buckets are sorted year DESC then month DESC.
    for (let i = 1; i < body.buckets.length; i += 1) {
      const prev = body.buckets[i - 1]!;
      const cur = body.buckets[i]!;
      expect(prev.year * 100 + prev.month).toBeGreaterThan(cur.year * 100 + cur.month);
    }
  });

  it('/buckets composes with q free-text', async () => {
    const { status, body } = await buckets(`q=${encodeURIComponent('_eom')}`);
    expect(status).toBe(200);
    // Only the boundary fixture matches the substring "_eom" — exactly one
    // photo, in 2025/07.
    expect(body.total).toBe(1);
    expect(body.buckets).toHaveLength(1);
    expect(body.buckets[0]!.year).toBe(2025);
    expect(body.buckets[0]!.month).toBe(7);
  });

  it('/buckets large libraries return all buckets (no 600 cap)', async () => {
    // Sanity: confirm the previous "too many buckets" cap is gone. With the
    // current fixture set (≪ 600 buckets), this just asserts the endpoint
    // returns 200 — the absence of a 400 here is what the test pins.
    const { status } = await buckets();
    expect(status).toBe(200);
  });
});

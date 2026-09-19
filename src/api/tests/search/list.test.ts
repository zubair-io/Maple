/**
 * Tests for GET /api/search — the paginated result list endpoint.
 *
 * Bare-Elysia `app.handle` style; mirrors `tests/auth/enforcement.test.ts`.
 * Real SQLite, installed as the process-wide handle for the file.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { Elysia } from 'elysia';
import { fmtAuth, seedBaseLibrary, seedLibraries, type SeededLibraries } from './_setup.ts';
import { insertPhassetLink } from '../../src/db/sqlite/repos/assets.test-helpers.ts';
import { seedSearchAsset } from '../../src/db/sqlite/repos/search.test-helpers.ts';
import {
  createLiveTestDatabase,
  insertFolder,
  type LiveTestDatabase,
} from '../../src/db/sqlite/test-sqlite.test-helpers.ts';

let live: LiveTestDatabase;
let libraries: SeededLibraries;

beforeAll(async () => {
  live = await createLiveTestDatabase();
  libraries = seedBaseLibrary(live.db);
});

beforeEach(async () => {
  // The list route's `total` cache (#2128) is module-scoped for the process
  // lifetime — without this, a different test file's `total` for the same
  // query-param shape (e.g. no filters at all — several suites in
  // tests/search/ hit that exact case) would leak into this file's
  // assertions, or vice versa. Mirrors the buckets-cache reset already used
  // by buckets.test.ts / search-place-route.test.ts.
  const { _resetCacheForTests } = await import('../../src/routes/search.ts');
  _resetCacheForTests();
});

afterAll(() => {
  live.close();
});

/** The search app, and a request through it with the standard bearer. */
async function search(
  qs: string,
  headers: Record<string, string> = fmtAuth(),
): Promise<{ status: number; body: Record<string, unknown> }> {
  const { searchRoutes } = await import('../../src/routes/search.ts');
  const { requireAuth } = await import('../../src/auth/middleware.ts');
  const app = new Elysia().use(requireAuth).use(searchRoutes);
  const r = await app.handle(new Request(`http://localhost/api/search${qs}`, { headers }));
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, unknown> };
}

/** `results`, typed for the fields these assertions read. */
function rows(body: Record<string, unknown>): Array<{
  _id: string;
  id: string;
  filename: string;
  folder_id: string;
  phasset_links?: Array<{ phasset_local_id: string; phasset_cloud_id?: string }>;
}> {
  return body.results as ReturnType<typeof rows>;
}

describe('/api/search', () => {
  it('requires a bearer', async () => {
    const { status } = await search('', {});
    expect(status).toBe(401);
  });

  it('returns all live assets (4) when no filters', async () => {
    const { status, body } = await search('');
    expect(status).toBe(200);
    expect(body.total).toBe(4);
    expect(rows(body).length).toBe(4);
  });

  it('filters by free-text q against filename', async () => {
    const { status, body } = await search('?q=sunset');
    expect(status).toBe(200);
    expect(body.total).toBe(1);
    expect(rows(body)[0]!.filename).toBe('sunset.cr3');
    expect(rows(body)[0]!.id).toBe('fs:/lib-a/sunset.cr3');
  });

  it('filters by camera (substring on make + model)', async () => {
    const { status, body } = await search('?camera=Hasselblad');
    expect(status).toBe(200);
    expect(body.total).toBe(1);
    expect(rows(body)[0]!.filename).toBe('dji-mavic3pro-100mp.dng');
  });

  it('filters by date range', async () => {
    const { status, body } = await search('?from=2024-01-01&to=2024-12-31');
    expect(status).toBe(200);
    // Hasselblad (2024-06-01) + Sony (2024-01-15) = 2
    expect(body.total).toBe(2);
  });

  it('filters by rating threshold', async () => {
    const { status, body } = await search('?rating=4');
    expect(status).toBe(200);
    // Hasselblad (5) + Sony (4) = 2
    expect(body.total).toBe(2);
  });

  it('scopes by libraryId', async () => {
    const { status, body } = await search(`?libraryId=${libraries.folderA}`);
    expect(status).toBe(200);
    expect(body.total).toBe(2);
    for (const row of rows(body)) expect(row.folder_id).toBe(libraries.folderA);
  });

  it('filters by ext', async () => {
    const { status, body } = await search('?ext=dng,cr3');
    expect(status).toBe(200);
    expect(body.total).toBe(2);
    const names = rows(body)
      .map((r) => r.filename)
      .sort();
    expect(names).toEqual(['dji-mavic3pro-100mp.dng', 'sunset.cr3']);
  });

  it('rejects invalid ext', async () => {
    const { status } = await search('?ext=dng;cr3');
    expect(status).toBe(400);
  });

  it('returns no matches for nonsense q', async () => {
    const { status, body } = await search('?q=notarealfilename_xyzpdq');
    expect(status).toBe(200);
    expect(body.total).toBe(0);
    expect(rows(body).length).toBe(0);
  });

  it('paginates with limit + page', async () => {
    const first = await search('?limit=2&page=0');
    const second = await search('?limit=2&page=1');
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.body.total).toBe(4);
    expect(rows(first.body).length).toBe(2);
    expect(rows(second.body).length).toBe(2);
    // Pages don't overlap.
    const ids1 = new Set(rows(first.body).map((r) => r._id));
    for (const row of rows(second.body)) expect(ids1.has(row._id)).toBe(false);
  });

  it('clamps an over-cap limit to 500', async () => {
    // A caller asking past the cap gets it clamped, not honored — guards the
    // page-size ceiling against accidental changes.
    const { status, body } = await search('?limit=9999');
    expect(status).toBe(200);
    expect(body.limit).toBe(500);
    expect(rows(body).length).toBeLessThanOrEqual(500);
  });

  it('clamps an over-cap page to 10_000 (#2359)', async () => {
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
    const overCap = await search('?page=99999999999');
    expect(overCap.status).toBe(200);
    expect(overCap.body.page).toBe(10_000);

    // The ceiling is where it claims to be, not merely "big numbers get
    // reduced to something": the last in-range page is returned unclamped.
    const atCap = await search('?page=10000');
    expect(atCap.status).toBe(200);
    expect(atCap.body.page).toBe(10_000);

    const belowCap = await search('?page=9999');
    expect(belowCap.status).toBe(200);
    expect(belowCap.body.page).toBe(9_999);
  });

  it('excludes soft-deleted rows', async () => {
    const { status, body } = await search('?q=deleted');
    expect(status).toBe(200);
    expect(body.total).toBe(0);
  });

  it('projects phasset_links (drives cross-device synced badge)', async () => {
    // A row with PhotoKit links carrying BOTH a local id and a cloud id —
    // mirrors what backup-ingest writes when the device had iCloud Photos on.
    // Its own library so the assertion can scope to it.
    const folderC = insertFolder(live.db, { path: '/lib-c', slug: 'lib-c' });
    const assetId = seedSearchAsset(live.db, folderC, {
      filename: 'with-phasset-links.heic',
      path: '',
      capturedAt: null,
    });
    insertPhassetLink(live.db, {
      assetId,
      deviceId: 'device-A',
      phassetLocalId: 'DEVICE_A_PHID',
      phassetCloudId: 'icloud-XYZ',
    });
    // The second device's row deliberately lacks a cloud id — exercises the
    // projection's "optional per-entry" behaviour.
    insertPhassetLink(live.db, {
      assetId,
      deviceId: 'device-B',
      phassetLocalId: 'DEVICE_B_PHID',
    });

    const { status, body } = await search(`?libraryId=${folderC}`);
    expect(status).toBe(200);
    const hit = rows(body).find((x) => x.filename === 'with-phasset-links.heic');
    expect(hit).toBeTruthy();
    expect(hit!.phasset_links).toBeTruthy();
    expect(hit!.phasset_links!.length).toBe(2);
    const byPhid = new Map(hit!.phasset_links!.map((l) => [l.phasset_local_id, l]));
    expect(byPhid.get('DEVICE_A_PHID')?.phasset_cloud_id).toBe('icloud-XYZ');
    expect(byPhid.get('DEVICE_B_PHID')?.phasset_cloud_id).toBeUndefined();
    // device_id and first_seen are stripped (merged-timeline doesn't need them).
    for (const link of hit!.phasset_links!) {
      expect((link as Record<string, unknown>).device_id).toBeUndefined();
      expect((link as Record<string, unknown>).first_seen).toBeUndefined();
    }
  });
});

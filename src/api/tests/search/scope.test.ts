/**
 * Tests for the S7 `scope` query param on GET /api/search (#644).
 *
 * Backend-side semantics:
 *   - `photos` / absent → full live set (today's behaviour).
 *   - `places`          → assets with GPS.
 *   - `people`          → assets with at least one detected face.
 *   - `albums`          → short-circuit; empty `results` + `notImplemented: true`.
 *
 * Real SQLite, installed as the process-wide handle for the file.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { Elysia } from 'elysia';
import { fmtAuth, seedBaseLibrary } from './_setup.ts';
import { insertFace } from '../../src/db/sqlite/repos/assets.test-helpers.ts';
import { seedSearchAsset } from '../../src/db/sqlite/repos/search.test-helpers.ts';
import {
  createLiveTestDatabase,
  type LiveTestDatabase,
} from '../../src/db/sqlite/test-sqlite.test-helpers.ts';

let live: LiveTestDatabase;

beforeAll(async () => {
  live = await createLiveTestDatabase();
  // The base fixture gives 4 live + 1 deleted. Of the live rows: one has GPS
  // (the Hasselblad row), three don't. Two extra rows prove the faces filter
  // independently of GPS.
  const { folderA } = seedBaseLibrary(live.db);

  // Live row with a single detected face but no GPS.
  const faceOnly = seedSearchAsset(live.db, folderA, {
    filename: 'face-only.jpg',
    path: '',
    capturedAt: null,
  });
  insertFace(live.db, { assetId: faceOnly, bbox: { x: 0.1, y: 0.1, w: 0.3, h: 0.3 } });

  // Live row with BOTH GPS and a face — covered by both scopes.
  const gpsAndFace = seedSearchAsset(live.db, folderA, {
    filename: 'gps-and-face.jpg',
    path: '',
    capturedAt: '2024-08-01T00:00:00.000Z',
    cameraMake: 'Apple',
    cameraModel: 'iPhone',
    iso: 100,
    aperture: 2.0,
    focalLength: 26,
    gps: { lat: 40.7, lng: -74.0 },
  });
  insertFace(live.db, {
    assetId: gpsAndFace,
    bbox: { x: 0.2, y: 0.2, w: 0.4, h: 0.4 },
    confidence: 0.95,
  });
});

beforeEach(async () => {
  // The list route's `total` cache (#2128) is module-scoped for the process
  // lifetime — without this, a different test file's `total` for the same
  // query-param shape (e.g. no filters at all — several suites in
  // tests/search/ hit that exact case) would leak into this file's
  // assertions, or vice versa.
  const { _resetCacheForTests } = await import('../../src/routes/search.ts');
  _resetCacheForTests();
});

afterAll(() => {
  live.close();
});

async function search(qs: string): Promise<{
  status: number;
  body: { total: number; results: Array<{ filename: string }>; notImplemented?: boolean };
}> {
  const { searchRoutes } = await import('../../src/routes/search.ts');
  const { requireAuth } = await import('../../src/auth/middleware.ts');
  const app = new Elysia().use(requireAuth).use(searchRoutes);
  const r = await app.handle(
    new Request(`http://localhost/api/search${qs}`, { headers: fmtAuth() }),
  );
  return { status: r.status, body: (await r.json()) as never };
}

describe('/api/search?scope=', () => {
  it('returns the full live set when scope is absent', async () => {
    const { status, body } = await search('');
    expect(status).toBe(200);
    // 4 base live + 2 extras = 6
    expect(body.total).toBe(6);
    expect(body.notImplemented).toBeUndefined();
  });

  it('scope=photos is a no-op alias for the default set', async () => {
    const { status, body } = await search('?scope=photos');
    expect(status).toBe(200);
    expect(body.total).toBe(6);
    expect(body.notImplemented).toBeUndefined();
  });

  it('scope=places narrows to assets with GPS', async () => {
    const { status, body } = await search('?scope=places');
    expect(status).toBe(200);
    // Hasselblad (gps) + gps-and-face = 2
    expect(body.total).toBe(2);
    expect(body.results.map((r) => r.filename).sort()).toEqual([
      'dji-mavic3pro-100mp.dng',
      'gps-and-face.jpg',
    ]);
    expect(body.notImplemented).toBeUndefined();
  });

  it('scope=people narrows to assets with at least one face', async () => {
    const { status, body } = await search('?scope=people');
    expect(status).toBe(200);
    // face-only + gps-and-face = 2
    expect(body.total).toBe(2);
    expect(body.results.map((r) => r.filename).sort()).toEqual([
      'face-only.jpg',
      'gps-and-face.jpg',
    ]);
    expect(body.notImplemented).toBeUndefined();
  });

  it('scope=albums short-circuits with notImplemented=true', async () => {
    const { status, body } = await search('?scope=albums');
    expect(status).toBe(200);
    expect(body.total).toBe(0);
    expect(body.results).toEqual([]);
    expect(body.notImplemented).toBe(true);
  });

  it('rejects an unknown scope value with 400', async () => {
    const { status, body } = await search('?scope=notarealscope');
    expect(status).toBe(400);
    expect((body as unknown as { error: string }).error).toContain('scope');
  });

  it('scope filter composes with q (AND semantics)', async () => {
    // gps-and-face is the only Places-scope row whose filename matches "gps".
    const { status, body } = await search('?scope=places&q=gps');
    expect(status).toBe(200);
    expect(body.total).toBe(1);
    expect(body.results[0]!.filename).toBe('gps-and-face.jpg');
  });
});

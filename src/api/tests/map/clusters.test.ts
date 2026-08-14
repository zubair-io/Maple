/**
 * Tests for `GET /api/map/clusters` (#2825 — Map T1).
 *
 * Bare-Elysia `app.handle` style; mirrors `tests/search/facets.test.ts`.
 * Skip-passes if MongoDB is unreachable.
 *
 * Fixture geography, all at zoom=4 (cellSizeDeg = 360/2^4 = 22.5°):
 *   - `nyc-1` (40.0, -74.0)   + `nyc-2` (41.0, -73.0)  → SAME cell (1,-4)
 *   - `london-1` (51.5, -0.12)                          → cell (2,-1)
 *   - `paris-1` (48.85, 2.35)                            → cell (2,0)
 *   - `alaska-1` (64.0, -150.0)                          → cell (2,-7)
 *   - `tokyo-1` (35.68, 139.69)                          → cell (1,6)
 * Cell indices computed by hand (`Math.floor(coord / 22.5)`) so the
 * counts/centroids assertions below are exact, not just "some cell".
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { Elysia } from 'elysia';
import { MongoClient, ObjectId } from 'mongodb';
import { fmtAuth, seedFolders, tryConnect } from '../search/_setup.ts';

const TEST_DB = `maple_test_map_clusters_${process.pid}`;
const PRIOR_MONGO_DB = process.env.MAPLE_MONGO_DB;
process.env.MAPLE_MONGO_DB = TEST_DB;

let mongo: MongoClient | null = null;
let mongoReachable = false;
const folderA = new ObjectId();
// `seedFolders` inserts two distinct folder docs; every fixture asset below
// lives under `folderA` — `folderB` is registered but unused.
const folderB = new ObjectId();

interface ClusterCell {
  lat: number;
  lng: number;
  count: number;
  representativeAssetId: string;
  placeLabel: string | null;
  thumbKey?: string;
}
interface ClustersResponse {
  cells: ClusterCell[];
}

function fileinfo(filename: string) {
  return [{ library_id: folderA, path: '', filename, deleted_at: null }];
}

function baseFields() {
  return {
    size: 1024,
    mtime: Date.now(),
    rating: 0,
    flag: 0 as const,
    color_label: '',
    indexed_at: new Date().toISOString(),
    hidden: false,
    deleted_at: null,
  };
}

const NYC_1_ID = new ObjectId();
const NYC_2_ID = new ObjectId();
const LONDON_1_ID = new ObjectId();
const PARIS_1_ID = new ObjectId();
const ALASKA_1_ID = new ObjectId();
const TOKYO_1_ID = new ObjectId();

beforeAll(async () => {
  mongo = await tryConnect();
  mongoReachable = mongo !== null;
  if (!mongoReachable) {
    console.log('[map/clusters.test] skipping: MongoDB unreachable');
    return;
  }
  const db = mongo!.db(TEST_DB);
  await db.dropDatabase();
  await seedFolders(db, folderA, folderB);
  await db.collection('assets').insertMany([
    {
      _id: NYC_1_ID,
      ...baseFields(),
      fileinfo: fileinfo('nyc1.dng'),
      exif: {
        captured_at: null,
        camera_make: 'Canon',
        camera_model: 'EOS R5',
        gps: { lat: 40.0, lng: -74.0 },
      },
      place: { rollups: { locality: 'New York', region: 'New York', country_code: 'us' } },
    },
    {
      _id: NYC_2_ID,
      ...baseFields(),
      fileinfo: fileinfo('nyc2.dng'),
      exif: {
        captured_at: null,
        camera_make: 'Nikon',
        camera_model: 'Z9',
        gps: { lat: 41.0, lng: -73.0 },
      },
      place: { rollups: { locality: null, region: 'New York', country_code: 'us' } },
    },
    {
      _id: LONDON_1_ID,
      ...baseFields(),
      fileinfo: fileinfo('london1.dng'),
      exif: {
        captured_at: null,
        camera_make: 'Canon',
        camera_model: 'R6',
        gps: { lat: 51.5, lng: -0.12 },
      },
      place: { rollups: { locality: null, region: 'England', country_code: 'gb' } },
    },
    {
      _id: PARIS_1_ID,
      ...baseFields(),
      fileinfo: fileinfo('paris1.dng'),
      exif: {
        captured_at: null,
        camera_make: 'Sony',
        camera_model: 'A7R V',
        gps: { lat: 48.85, lng: 2.35 },
      },
      place: { rollups: { locality: 'Paris', region: 'Île-de-France', country_code: 'fr' } },
    },
    {
      _id: ALASKA_1_ID,
      ...baseFields(),
      fileinfo: fileinfo('alaska1.dng'),
      exif: {
        captured_at: null,
        camera_make: 'Sony',
        camera_model: 'A1',
        gps: { lat: 64.0, lng: -150.0 },
      },
      place: { rollups: { locality: null, region: null, country_code: 'us' } },
    },
    {
      _id: TOKYO_1_ID,
      ...baseFields(),
      fileinfo: fileinfo('tokyo1.dng'),
      exif: {
        captured_at: null,
        camera_make: 'Fujifilm',
        camera_model: 'X-T5',
        gps: { lat: 35.68, lng: 139.69 },
      },
      place: { rollups: { locality: 'Tokyo', region: 'Tokyo', country_code: 'jp' } },
    },
  ]);

  const { closeDb } = await import('../../src/db/client.ts');
  await closeDb();
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

async function get(qs: string): Promise<{ status: number; body: ClustersResponse }> {
  const { mapRoutes } = await import('../../src/routes/map/index.ts');
  const { requireAuth } = await import('../../src/auth/middleware.ts');
  const app = new Elysia().use(requireAuth).use(mapRoutes);
  const r = await app.handle(
    new Request(`http://localhost/api/map/clusters?${qs}`, { headers: fmtAuth() }),
  );
  const body = (await r.json()) as ClustersResponse;
  return { status: r.status, body };
}

function findCell(cells: ClusterCell[], approxLat: number, approxLng: number): ClusterCell {
  const found = cells.find(
    (c) => Math.abs(c.lat - approxLat) < 1 && Math.abs(c.lng - approxLng) < 1,
  );
  if (!found) {
    throw new Error(`no cell near (${approxLat}, ${approxLng}) in ${JSON.stringify(cells)}`);
  }
  return found;
}

// bbox covering NYC + London + Paris, excluding Alaska (lat 64 > north 60)
// and Tokyo (lng 139.69 > east 20).
const NYC_LONDON_PARIS_BBOX = 'bbox=-80,30,20,60';

describe('GET /api/map/clusters', () => {
  it('grid-buckets GPS points into correct cell counts + centroids', async () => {
    if (!mongoReachable) return;
    const { status, body } = await get(`${NYC_LONDON_PARIS_BBOX}&zoom=4`);
    expect(status).toBe(200);
    expect(body.cells.length).toBe(3);

    const nyc = findCell(body.cells, 40.5, -73.5);
    expect(nyc.count).toBe(2);
    expect(nyc.lat).toBeCloseTo(40.5, 5);
    expect(nyc.lng).toBeCloseTo(-73.5, 5);

    const london = findCell(body.cells, 51.5, -0.12);
    expect(london.count).toBe(1);
    expect(london.lat).toBeCloseTo(51.5, 5);
    expect(london.lng).toBeCloseTo(-0.12, 5);
    expect(london.representativeAssetId).toBe(LONDON_1_ID.toHexString());

    const paris = findCell(body.cells, 48.85, 2.35);
    expect(paris.count).toBe(1);
  });

  it('excludes out-of-viewport points via bbox', async () => {
    if (!mongoReachable) return;
    // Tight bbox around NYC only — London/Paris/Alaska/Tokyo must not appear.
    const { status, body } = await get('bbox=-80,35,-60,45&zoom=4');
    expect(status).toBe(200);
    expect(body.cells.length).toBe(1);
    expect(body.cells[0]!.count).toBe(2);
  });

  it('composes with search filters (camera)', async () => {
    if (!mongoReachable) return;
    // Canon-only: keeps nyc-1 (drops nyc-2/Nikon) and london-1; drops
    // paris-1 (Sony) entirely.
    const { status, body } = await get(`${NYC_LONDON_PARIS_BBOX}&zoom=4&camera=Canon`);
    expect(status).toBe(200);
    expect(body.cells.length).toBe(2);
    for (const cell of body.cells) {
      expect(cell.count).toBe(1);
    }
    const nyc = findCell(body.cells, 40.0, -74.0);
    expect(nyc.representativeAssetId).toBe(NYC_1_ID.toHexString());
  });

  it('carries thumbKey only on single-count cells', async () => {
    if (!mongoReachable) return;
    const { body } = await get(`${NYC_LONDON_PARIS_BBOX}&zoom=4`);

    const nyc = findCell(body.cells, 40.5, -73.5);
    expect(nyc.count).toBe(2);
    expect(nyc.thumbKey).toBeUndefined();

    const london = findCell(body.cells, 51.5, -0.12);
    expect(london.count).toBe(1);
    expect(london.thumbKey).toBe('/lib-a/london1.dng');

    const paris = findCell(body.cells, 48.85, 2.35);
    expect(paris.count).toBe(1);
    expect(paris.thumbKey).toBe('/lib-a/paris1.dng');
  });

  it('falls back placeLabel: locality -> region -> country_code', async () => {
    if (!mongoReachable) return;
    const { body } = await get(`${NYC_LONDON_PARIS_BBOX}&zoom=4`);

    // nyc-1 (representative of the multi-asset NYC cell) has a locality.
    const nyc = findCell(body.cells, 40.5, -73.5);
    expect(nyc.placeLabel).toBe('New York');

    // london-1 has no locality; falls back to region.
    const london = findCell(body.cells, 51.5, -0.12);
    expect(london.placeLabel).toBe('England');

    // paris-1 has a locality.
    const paris = findCell(body.cells, 48.85, 2.35);
    expect(paris.placeLabel).toBe('Paris');

    // alaska-1 has neither locality nor region; falls back to country_code.
    // Separate bbox around Alaska only.
    const { body: alaskaBody } = await get('bbox=-160,50,-140,70&zoom=4');
    expect(alaskaBody.cells.length).toBe(1);
    expect(alaskaBody.cells[0]!.placeLabel).toBe('us');
  });

  it('rejects a missing bbox', async () => {
    if (!mongoReachable) return;
    const { status, body } = await get('zoom=4');
    expect(status).toBe(400);
    expect((body as unknown as { error: string }).error).toContain('bbox');
  });
});

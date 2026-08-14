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
 *
 * Plus two Sydney "twins" at (-33.86, 151.21) and (-33.86, 151.211),
 * 0.001° apart, used only by the grid-cap tests at the bottom. Every
 * other test's bbox stays in the northern hemisphere, so they don't
 * perturb the counts above.
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { Elysia } from 'elysia';
import { MongoClient, ObjectId } from 'mongodb';
import { fmtAuth, seedFolders, tryConnect } from '../search/_setup.ts';

const TEST_DB = `maple_test_map_clusters_${process.pid}`;

/** Captured and installed inside `beforeAll`, restored in `afterAll` —
 * deliberately NOT at module scope. `bun test` imports every file into one
 * process and its file order varies between runs, so an import-time
 * `process.env.MAPLE_MONGO_DB = …` is live from the moment this file is
 * loaded until the moment its `afterAll` runs, which can span other
 * files' tests. The `getDb` singleton latches the env pair it first
 * observes, so a stray override outside this suite's own window is how a
 * different suite ends up reading the wrong database (the root cause
 * behind the preview-ETag flake, #2783 / PR #2814). Confining the
 * mutation to the hooks keeps the window exactly this suite's runtime. */
let priorMongoDb: string | undefined;

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
const SYDNEY_A_ID = new ObjectId();
const SYDNEY_B_ID = new ObjectId();

beforeAll(async () => {
  priorMongoDb = process.env.MAPLE_MONGO_DB;
  process.env.MAPLE_MONGO_DB = TEST_DB;
  mongo = await tryConnect();
  mongoReachable = mongo !== null;
  if (!mongoReachable) {
    console.log('[map/clusters.test] skipping: MongoDB unreachable');
    return;
  }
  const db = mongo!.db(TEST_DB);
  await db.dropDatabase();
  await seedFolders(db, folderA, folderB);
  // Mirrors the production `search_blob_text` index (see `ensureIndexes`).
  // Needed by the placeQuery case below: `buildFilter` turns placeQuery
  // into a `$text` predicate, and Mongo rejects `$text` outright without a
  // text index — so without this the test would pass for the wrong reason.
  await db.collection('assets').createIndex(
    { search_blob: 'text' },
    {
      name: 'search_blob_text',
      default_language: 'english',
      partialFilterExpression: {
        deleted_at: null,
        search_blob: { $type: 'string', $gt: '' },
      },
    },
  );
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
      search_blob: 'new york brooklyn bridge',
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
      search_blob: 'new york hudson valley',
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
      search_blob: 'london england thames',
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
      search_blob: 'paris france seine',
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
    // Two Sydney "twins" 0.001° apart — closer together than a
    // world-bbox clamped cell (5.625°) but ~3 zoom-20 cells apart
    // (0.00034° each). They are what makes the grid cap observable:
    // separate cells under a tight viewport, one merged cell under a
    // whole-world viewport at the same zoom. Far enough south that every
    // other test's bbox excludes them.
    {
      _id: SYDNEY_A_ID,
      ...baseFields(),
      fileinfo: fileinfo('sydneyA.dng'),
      exif: {
        captured_at: null,
        camera_make: 'Canon',
        camera_model: 'R5',
        gps: { lat: -33.86, lng: 151.21 },
      },
      place: { rollups: { locality: 'Sydney', region: 'New South Wales', country_code: 'au' } },
    },
    {
      _id: SYDNEY_B_ID,
      ...baseFields(),
      fileinfo: fileinfo('sydneyB.dng'),
      exif: {
        captured_at: null,
        camera_make: 'Canon',
        camera_model: 'R5',
        gps: { lat: -33.86, lng: 151.211 },
      },
      place: { rollups: { locality: 'Sydney', region: 'New South Wales', country_code: 'au' } },
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
  if (priorMongoDb === undefined) delete process.env.MAPLE_MONGO_DB;
  else process.env.MAPLE_MONGO_DB = priorMongoDb;
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
    // Asserted as "only the two NYC fixtures got through", not as a fixed cell
    // count: this 20°-wide viewport now resolves a grid fine enough to separate
    // the pair (they are ~1° apart), which is the #2856 fix working. What this
    // test is actually about is the bbox filter, so it checks the total assets
    // represented and that every cell sits inside the requested viewport.
    const total = body.cells.reduce((sum, c) => sum + c.count, 0);
    expect(total).toBe(2);
    for (const cell of body.cells) {
      expect(cell.lat).toBeGreaterThanOrEqual(35);
      expect(cell.lat).toBeLessThanOrEqual(45);
      expect(cell.lng).toBeGreaterThanOrEqual(-80);
      expect(cell.lng).toBeLessThanOrEqual(-60);
    }
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

  // `placeQuery` is the one filter that reaches Mongo as `$text`, which has
  // placement rules the other predicates don't (illegal under `$or`, and the
  // partial text index only applies when the planner can prove the query
  // implies it). It is therefore the case that proves the handler's `$and`
  // composition is legal, not just collision-safe.
  it('composes with the placeQuery text filter', async () => {
    if (!mongoReachable) return;
    const { status, body } = await get(`${NYC_LONDON_PARIS_BBOX}&zoom=4&placeQuery=thames`);
    expect(status).toBe(200);
    // Only london-1's blob mentions the Thames.
    expect(body.cells.length).toBe(1);
    expect(body.cells[0]!.count).toBe(1);
    expect(body.cells[0]!.representativeAssetId).toBe(LONDON_1_ID.toHexString());

    // And the bbox still applies on top of the text match: 'new york'
    // matches both NYC rows, which share a cell.
    const { body: nycBody } = await get(`${NYC_LONDON_PARIS_BBOX}&zoom=4&placeQuery=york`);
    expect(nycBody.cells.length).toBe(1);
    expect(nycBody.cells[0]!.count).toBe(2);
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

  // The grid cap is what keeps the `$group` (and the response) O(viewport)
  // rather than O(library): `bbox` and `zoom` are independent params, so
  // "whole world at zoom 20" would otherwise put every asset in its own
  // cell. The Sydney twins sit 0.001° apart — ~3 cells apart on a
  // zoom-20 grid (0.00034°/cell), but well inside one cell once the cap
  // coarsens a world viewport to 360/64 = 5.625°.
  it('resolves the zoom-20 grid when the viewport is tight enough to afford it', async () => {
    if (!mongoReachable) return;
    const { status, body } = await get('bbox=151.2,-33.87,151.22,-33.85&zoom=20');
    expect(status).toBe(200);
    // Tight bbox: 0.02° / 64 = 0.0003125° minimum cell, finer than the
    // zoom's own 0.00034° cell, so no coarsening happens and the twins
    // stay in separate cells.
    expect(body.cells.length).toBe(2);
    for (const cell of body.cells) {
      expect(cell.count).toBe(1);
    }
  });

  // Regression for #2856, reproducing what was seen on-device (Apple TV):
  // zooming never revealed more pins and no pin ever showed a photo preview.
  // Clients derive `zoom` from their viewport span (`MapViewport.zoomLevel` =
  // log2(360 / lonDelta)) and the grid was `360 / 2^zoom` — algebraically the
  // viewport width, so exactly ONE cell covered the whole visible map at every
  // zoom. `thumbKey` is only emitted for `count == 1` cells, and one cell
  // holding every visible photo is never 1, which is why no thumbnail pin could
  // ever render. Asserted end-to-end through the route rather than against the
  // private grid helper, so it pins the behaviour a client actually observes.
  it('returns a real grid at the whole-world view a client opens on (#2856)', async () => {
    if (!mongoReachable) return;
    // zoom=0 is what `zoomLevel` yields for the 360°-wide default camera.
    const { status, body } = await get('bbox=-180,-90,180,90&zoom=0');
    expect(status).toBe(200);
    // The eight fixtures sit on four continents; they must not collapse into
    // one or two lumps. Before the fix this returned a single cell.
    expect(body.cells.length).toBeGreaterThanOrEqual(5);
  });

  it('emits a thumbnail-pin cell for an isolated photo at the default zoom (#2856)', async () => {
    if (!mongoReachable) return;
    const { status, body } = await get('bbox=-180,-90,180,90&zoom=0');
    expect(status).toBe(200);
    // Tokyo is thousands of km from every other fixture, so at a sane grid it
    // is alone in its cell and therefore carries the thumbKey a client needs to
    // draw the photo inside the pin.
    const tokyo = findCell(body.cells, 35.68, 139.69);
    expect(tokyo.count).toBe(1);
    expect(tokyo.thumbKey).toBeDefined();
  });

  it('reveals more cells as the viewport zooms in on a dense area (#2856)', async () => {
    if (!mongoReachable) return;
    // Same NYC pair, two viewport widths. Tightening the viewport must resolve
    // a finer grid; previously both requests returned exactly one cell because
    // the cell tracked the viewport width.
    const wide = await get('bbox=-100,20,-40,60&zoom=2');
    const tight = await get('bbox=-74.6,39.6,-72.4,41.4&zoom=7');
    expect(wide.status).toBe(200);
    expect(tight.status).toBe(200);
    const wideCell = findCell(wide.body.cells, 40.5, -73.5);
    expect(wideCell.count).toBe(2);
    // At the tight viewport the two points (1° apart) fall in separate cells,
    // each becoming its own thumbnail pin.
    expect(tight.body.cells.length).toBe(2);
    for (const cell of tight.body.cells) {
      expect(cell.count).toBe(1);
      expect(cell.thumbKey).toBeDefined();
    }
  });

  it('caps grid resolution so a whole-world bbox cannot emit one cell per asset', async () => {
    if (!mongoReachable) return;
    const { status, body } = await get('bbox=-180,-90,180,90&zoom=20');
    expect(status).toBe(200);

    // Same zoom as the test above, but the cap coarsens the cell to
    // 5.625°, which merges the twins into a single 2-count cell.
    const sydney = findCell(body.cells, -33.86, 151.21);
    expect(sydney.count).toBe(2);
    expect(sydney.thumbKey).toBeUndefined();
    expect(sydney.placeLabel).toBe('Sydney');

    // Eight fixtures, but never eight cells: the twins share one.
    expect(body.cells.length).toBe(7);
    // Hard ceiling regardless of input (64 per axis).
    expect(body.cells.length).toBeLessThanOrEqual(64 * 64);
  });
});

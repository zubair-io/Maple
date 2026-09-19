/**
 * Tests for `GET /api/map/clusters` (#2825 — Map T1), against SQLite (#3787).
 *
 * Bare-Elysia `app.handle` style; mirrors `tests/search/facets.test.ts`. The
 * database is a real in-memory SQLite installed as the process-wide handle for
 * the file, so the handler reaches it through `sqliteDb()` exactly as it does in
 * production.
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
import { fmtAuth, seedLibraries } from '../search/_setup.ts';
import { newObjectIdHex } from '../../src/db/object-id.ts';
import { seedSearchAsset, type SeedAsset } from '../../src/db/sqlite/repos/search.test-helpers.ts';
import {
  createLiveTestDatabase,
  type LiveTestDatabase,
} from '../../src/db/sqlite/test-sqlite.test-helpers.ts';
import { invalidateLibraryRoots } from '../../src/indexer/libraries.cache.ts';

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

let live: LiveTestDatabase;

const NYC_1_ID = newObjectIdHex();
const NYC_2_ID = newObjectIdHex();
const LONDON_1_ID = newObjectIdHex();
const PARIS_1_ID = newObjectIdHex();
const ALASKA_1_ID = newObjectIdHex();
const TOKYO_1_ID = newObjectIdHex();
const SYDNEY_A_ID = newObjectIdHex();
const SYDNEY_B_ID = newObjectIdHex();

/** Every fixture lives directly under its library root, so `thumbKey` is
 * `<root>/<filename>` and the assertions below stay readable. */
const FIXTURES: SeedAsset[] = [
  {
    id: NYC_1_ID,
    filename: 'nyc1.dng',
    path: '',
    cameraMake: 'Canon',
    cameraModel: 'EOS R5',
    gps: { lat: 40.0, lng: -74.0 },
    locality: 'New York',
    region: 'New York',
    countryCode: 'us',
    searchBlob: 'new york brooklyn bridge',
  },
  {
    id: NYC_2_ID,
    filename: 'nyc2.dng',
    path: '',
    cameraMake: 'Nikon',
    cameraModel: 'Z9',
    gps: { lat: 41.0, lng: -73.0 },
    region: 'New York',
    countryCode: 'us',
    searchBlob: 'new york hudson valley',
  },
  {
    id: LONDON_1_ID,
    filename: 'london1.dng',
    path: '',
    cameraMake: 'Canon',
    cameraModel: 'R6',
    gps: { lat: 51.5, lng: -0.12 },
    region: 'England',
    countryCode: 'gb',
    searchBlob: 'london england thames',
  },
  {
    id: PARIS_1_ID,
    filename: 'paris1.dng',
    path: '',
    cameraMake: 'Sony',
    cameraModel: 'A7R V',
    gps: { lat: 48.85, lng: 2.35 },
    locality: 'Paris',
    region: 'Île-de-France',
    countryCode: 'fr',
    searchBlob: 'paris france seine',
  },
  {
    id: ALASKA_1_ID,
    filename: 'alaska1.dng',
    path: '',
    cameraMake: 'Sony',
    cameraModel: 'A1',
    gps: { lat: 64.0, lng: -150.0 },
    countryCode: 'us',
  },
  {
    id: TOKYO_1_ID,
    filename: 'tokyo1.dng',
    path: '',
    cameraMake: 'Fujifilm',
    cameraModel: 'X-T5',
    gps: { lat: 35.68, lng: 139.69 },
    locality: 'Tokyo',
    region: 'Tokyo',
    countryCode: 'jp',
  },
  // Two Sydney "twins" 0.001° apart — closer together than a world-bbox
  // clamped cell (5.625°) but ~3 zoom-20 cells apart (0.00034° each). They are
  // what makes the grid cap observable: separate cells under a tight viewport,
  // one merged cell under a whole-world viewport at the same zoom. Far enough
  // south that every other test's bbox excludes them.
  {
    id: SYDNEY_A_ID,
    filename: 'sydneyA.dng',
    path: '',
    cameraMake: 'Canon',
    cameraModel: 'R5',
    gps: { lat: -33.86, lng: 151.21 },
    locality: 'Sydney',
    region: 'New South Wales',
    countryCode: 'au',
  },
  {
    id: SYDNEY_B_ID,
    filename: 'sydneyB.dng',
    path: '',
    cameraMake: 'Canon',
    cameraModel: 'R5',
    gps: { lat: -33.86, lng: 151.211 },
    locality: 'Sydney',
    region: 'New South Wales',
    countryCode: 'au',
  },
];

beforeAll(async () => {
  live = await createLiveTestDatabase();
  // `seedLibraries` registers `/lib-a` and `/lib-b`; every fixture below lives
  // under `folderA` — `folderB` exists so the library ids are not unique by
  // accident.
  const libraries = seedLibraries(live.db);
  for (const fixture of FIXTURES) seedSearchAsset(live.db, libraries.folderA, fixture);
  // The library-root cache is process-wide and may already hold another file's
  // roots; `thumbKey` resolution reads it.
  invalidateLibraryRoots();
});

afterAll(() => {
  live.close();
  invalidateLibraryRoots();
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
    expect(london.representativeAssetId).toBe(LONDON_1_ID);

    const paris = findCell(body.cells, 48.85, 2.35);
    expect(paris.count).toBe(1);
  });

  it('excludes out-of-viewport points via bbox', async () => {
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
    // Canon-only: keeps nyc-1 (drops nyc-2/Nikon) and london-1; drops
    // paris-1 (Sony) entirely.
    const { status, body } = await get(`${NYC_LONDON_PARIS_BBOX}&zoom=4&camera=Canon`);
    expect(status).toBe(200);
    expect(body.cells.length).toBe(2);
    for (const cell of body.cells) {
      expect(cell.count).toBe(1);
    }
    const nyc = findCell(body.cells, 40.0, -74.0);
    expect(nyc.representativeAssetId).toBe(NYC_1_ID);
  });

  // `placeQuery` is the one filter that changes the statement's *shape* rather
  // than adding a predicate to it: the grouping leads with `assets_fts` and
  // joins `assets` through `asset_search`. It is therefore the case that proves
  // the handler composes the viewport with a full-text query correctly, rather
  // than only that the two do not collide.
  it('composes with the placeQuery text filter', async () => {
    const { status, body } = await get(`${NYC_LONDON_PARIS_BBOX}&zoom=4&placeQuery=thames`);
    expect(status).toBe(200);
    // Only london-1's blob mentions the Thames.
    expect(body.cells.length).toBe(1);
    expect(body.cells[0]!.count).toBe(1);
    expect(body.cells[0]!.representativeAssetId).toBe(LONDON_1_ID);

    // And the bbox still applies on top of the text match: 'new york'
    // matches both NYC rows, which share a cell.
    const { body: nycBody } = await get(`${NYC_LONDON_PARIS_BBOX}&zoom=4&placeQuery=york`);
    expect(nycBody.cells.length).toBe(1);
    expect(nycBody.cells[0]!.count).toBe(2);
  });

  it('carries thumbKey only on single-count cells', async () => {
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
    const { status, body } = await get('zoom=4');
    expect(status).toBe(400);
    expect((body as unknown as { error: string }).error).toContain('bbox');
  });

  // The grid cap is what keeps the grouping (and the response) O(viewport)
  // rather than O(library): `bbox` and `zoom` arrive as independent params, so
  // "whole world at zoom 20" would otherwise put every asset in its own
  // cell. The Sydney twins sit 0.001° apart — ~3 cells apart on a
  // zoom-20 grid (0.00034°/cell), but well inside one cell once the cap
  // coarsens a world viewport to 360/64 = 5.625°.
  it('resolves the zoom-20 grid when the viewport is tight enough to afford it', async () => {
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
    // zoom=0 is what `zoomLevel` yields for the 360°-wide default camera.
    const { status, body } = await get('bbox=-180,-90,180,90&zoom=0');
    expect(status).toBe(200);
    // The eight fixtures sit on four continents; they must not collapse into
    // one or two lumps. Before the fix this returned a single cell.
    expect(body.cells.length).toBeGreaterThanOrEqual(5);
  });

  it('emits a thumbnail-pin cell for an isolated photo at the default zoom (#2856)', async () => {
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

  // The clamp window collapses when the viewport's aspect ratio exceeds
  // MAX_CELLS_PER_AXIS / MIN_CELLS_PER_AXIS, and degenerately when a bbox has
  // zero span. Both paths have to stay safe and keep honouring `zoom`.
  it('survives a degenerate point bbox instead of dividing by zero (#2856)', async () => {
    // south == north and west == east pass validation (only south > north is
    // rejected), so a client mid-gesture can legitimately send this. A zero
    // cell size would reach the grid division and fail the query. The bbox is
    // pinned exactly on the Tokyo fixture: an empty point bbox would pass this
    // test for the wrong reason.
    const { status, body } = await get('bbox=139.69,35.68,139.69,35.68&zoom=10');
    expect(status).toBe(200);
    expect(body.cells.length).toBe(1);
    expect(body.cells[0]!.count).toBe(1);
  });

  it('still honours zoom on a skewed viewport (#2856)', async () => {
    // lat span 14, lng span 120 — an 8.5:1 viewport, past the point where the
    // min/max window collapses. Pinning such a view to the cost ceiling would
    // make zoom a no-op there, so a coarse zoom must still yield a coarser
    // grid than a fine one.
    const coarse = await get('bbox=-80,38,40,52&zoom=2');
    const fine = await get('bbox=-80,38,40,52&zoom=8');
    expect(coarse.status).toBe(200);
    expect(fine.status).toBe(200);
    expect(coarse.body.cells.length).toBeLessThan(fine.body.cells.length);
  });

  it('caps grid resolution so a whole-world bbox cannot emit one cell per asset', async () => {
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

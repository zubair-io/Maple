/**
 * `GET /api/map/clusters` honours the `people` filter with and without search
 * text (#5621). Its own file because the database is a process-wide singleton
 * and the shared map fixtures count whole-world cells.
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { Elysia } from 'elysia';
import { fmtAuth, seedLibraries } from '../search/_setup.ts';
import { newObjectIdHex } from '../../src/db/object-id.ts';
import { seedSearchAsset, type SeedAsset } from '../../src/db/repos/search.test-helpers.ts';
import {
  createLiveTestDatabase,
  type LiveTestDatabase,
} from '../../src/db/sqlite/test-sqlite.test-helpers.ts';
import { invalidateLibraryRoots } from '../../src/indexer/libraries.cache.ts';

interface ClusterCell {
  count: number;
  representativeAssetId: string;
}

let live: LiveTestDatabase;

const ALICE_ID = newObjectIdHex();
const BOB_ID = newObjectIdHex();
const NOBODY_ID = newObjectIdHex();

const FIXTURES: SeedAsset[] = [
  {
    id: ALICE_ID,
    filename: 'alice.dng',
    path: '',
    gps: { lat: 40.0, lng: -74.0 },
    searchBlob: 'harbour alice',
    people: ['Alice'],
  },
  {
    id: BOB_ID,
    filename: 'bob.dng',
    path: '',
    gps: { lat: 51.5, lng: -0.12 },
    searchBlob: 'harbour bob',
    people: ['Bob'],
  },
  {
    id: NOBODY_ID,
    filename: 'nobody.dng',
    path: '',
    gps: { lat: 35.68, lng: 139.69 },
    searchBlob: 'harbour nobody',
  },
];

const WORLD = 'bbox=-180,-90,180,90&zoom=4';

beforeAll(async () => {
  live = await createLiveTestDatabase();
  const libraries = seedLibraries(live.db);
  const people = new Map<string, string>();
  for (const fixture of FIXTURES) seedSearchAsset(live.db, libraries.folderA, fixture, people);
  invalidateLibraryRoots();
});

afterAll(() => {
  live.close();
  invalidateLibraryRoots();
});

async function representatives(qs: string): Promise<string[]> {
  const { mapRoutes } = await import('../../src/routes/map/index.ts');
  const { requireAuth } = await import('../../src/auth/middleware.ts');
  const app = new Elysia().use(requireAuth).use(mapRoutes);
  const r = await app.handle(
    new Request(`http://localhost/api/map/clusters?${qs}`, { headers: fmtAuth() }),
  );
  expect(r.status).toBe(200);
  const { cells } = (await r.json()) as { cells: ClusterCell[] };
  return cells.map((c) => c.representativeAssetId).sort();
}

describe('GET /api/map/clusters people filter (#5621)', () => {
  it('returns every geotagged photo without a people filter', async () => {
    expect(await representatives(WORLD)).toEqual([ALICE_ID, BOB_ID, NOBODY_ID].sort());
  });

  it('limits pins to the named person when there is no search text', async () => {
    expect(await representatives(`${WORLD}&people=Alice`)).toEqual([ALICE_ID]);
  });

  it('matches the name case-insensitively', async () => {
    expect(await representatives(`${WORLD}&people=alice`)).toEqual([ALICE_ID]);
  });

  it('accepts several names', async () => {
    expect(await representatives(`${WORLD}&people=Alice,Bob`)).toEqual([ALICE_ID, BOB_ID].sort());
  });

  it('still applies the people filter alongside search text', async () => {
    expect(await representatives(`${WORLD}&placeQuery=harbour`)).toEqual(
      [ALICE_ID, BOB_ID, NOBODY_ID].sort(),
    );
    expect(await representatives(`${WORLD}&placeQuery=harbour&people=Alice`)).toEqual([ALICE_ID]);
  });

  it('returns nothing for a name no person holds, as /api/search does', async () => {
    expect(await representatives(`${WORLD}&people=Nobody%20Here`)).toEqual([]);
  });
});

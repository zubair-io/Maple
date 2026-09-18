/**
 * #2894 — person "Exclude" end-to-end: excluding a person drops every asset
 * carrying one of their faces from the plain (no-flag) search list, removes
 * the person from the normal people listing, surfaces them on the recovery
 * list, and un-excluding restores all of it.
 *
 * Real SQLite, installed as the process-wide handle so both route trees and
 * the people repository underneath them reach the same database.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import { listRoute } from './list.ts';
import { _resetCacheForTests } from './total-cache.ts';
import { peopleRoutes } from '../people.ts';
import { insertFace, insertPerson } from '../../db/sqlite/repos/assets.test-helpers.ts';
import { seedSearchAsset } from '../../db/sqlite/repos/search.test-helpers.ts';
import {
  createLiveTestDatabase,
  insertFolder,
  type LiveTestDatabase,
} from '../../db/sqlite/test-sqlite.test-helpers.ts';

let live: LiveTestDatabase;
let personId: string;
let bystanderId: string;

beforeEach(async () => {
  live = await createLiveTestDatabase();
  const libraryId = insertFolder(live.db, { slug: 'person-exclude', path: '/lib' });
  personId = insertPerson(live.db, 'Ex Cluded');
  bystanderId = insertPerson(live.db, 'By Stander');

  // Group shot: the excluded person plus a bystander — the whole asset must
  // drop, not just the one face.
  const group = seedSearchAsset(live.db, libraryId, {
    filename: 'a.dng',
    capturedAt: '2026-05-10T00:00:00.000Z',
  });
  insertFace(live.db, { assetId: group, faceIndex: 0, personId });
  insertFace(live.db, { assetId: group, faceIndex: 1, personId: bystanderId });

  seedSearchAsset(live.db, libraryId, {
    filename: 'b.dng',
    capturedAt: '2026-05-10T00:00:00.000Z',
  });
  _resetCacheForTests();
});

afterEach(() => {
  live.close();
  _resetCacheForTests();
});

const searchApp = new Elysia().use(listRoute);
const peopleApp = new Elysia().use(peopleRoutes);

async function searchIds(): Promise<string[]> {
  const res = await searchApp.handle(new Request('http://localhost/?limit=50'));
  expect(res.status).toBe(200);
  // The list projection is address-shaped (no maple_id); the filename is the
  // stable discriminator for this fixture set.
  const body = (await res.json()) as { results: { filename: string }[] };
  return body.results.map((r) => r.filename);
}

async function post(path: string): Promise<Response> {
  return peopleApp.handle(new Request(`http://localhost/api/people${path}`, { method: 'POST' }));
}

async function peopleNames(path: string): Promise<string[]> {
  const res = await peopleApp.handle(new Request(`http://localhost/api/people${path}`));
  expect(res.status).toBe(200);
  const rows = (await res.json()) as { name: string }[];
  return rows.map((r) => r.name);
}

describe('person exclude (#2894, end to end)', () => {
  it('drops assets with the excluded person from plain search, and restores on unexclude', async () => {
    expect((await searchIds()).sort()).toEqual(['a.dng', 'b.dng']);

    const ex = await post(`/${personId}/exclude`);
    expect(ex.status).toBe(200);

    // No flag on the request — exclusion must apply unconditionally.
    expect(await searchIds()).toEqual(['b.dng']);

    const unex = await post(`/${personId}/unexclude`);
    expect(unex.status).toBe(200);
    expect((await searchIds()).sort()).toEqual(['a.dng', 'b.dng']);
  });

  it('moves the person from the normal listing to the recovery list', async () => {
    expect((await peopleNames('/')).sort()).toEqual(['By Stander', 'Ex Cluded']);
    expect(await peopleNames('/excluded')).toEqual([]);

    await post(`/${personId}/exclude`);

    expect(await peopleNames('/')).toEqual(['By Stander']);
    expect(await peopleNames('/excluded')).toEqual(['Ex Cluded']);
    // Excluded ≠ hidden — the Hidden page stays empty.
    expect(await peopleNames('/hidden')).toEqual([]);

    await post(`/${personId}/unexclude`);
    expect((await peopleNames('/')).sort()).toEqual(['By Stander', 'Ex Cluded']);
    expect(await peopleNames('/excluded')).toEqual([]);
  });

  it('rejects a malformed person id', async () => {
    const res = await post('/not-an-id/exclude');
    expect(res.status).toBe(400);
  });
});

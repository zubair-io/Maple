/**
 * #2894 — person "Exclude" end-to-end: excluding a person drops every asset
 * carrying one of their faces from the plain (no-flag) search list, removes
 * the person from the normal people listing, surfaces them on the recovery
 * list, and un-excluding restores all of it.
 *
 * Real Mongo required (localhost:27017 by default, override via
 * `MAPLE_MONGO_URI`) — soft-skips when unreachable, matching the other
 * suites in this directory.
 */

import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import { ObjectId, type Db } from 'mongodb';
import { listRoute } from './list.ts';
import { peopleRoutes } from '../people.ts';
import { closeDb, getDb, isDbConnected } from '../../db/client.ts';

// Sibling-suite convention (#2783): a per-file database, named at module
// scope. The env var alone is NOT enough — `getDb()` caches its connection
// process-wide (#2787), so whichever file connected first would otherwise
// keep winning. `closeDb()` in beforeEach drops that singleton so the next
// `getDb()` re-reads the env and pins THIS file's database, regardless of
// file order.
const TEST_DB = `maple_test_person_exclude_${process.pid}`;

let db: Db | null = null;
let mongoReachable = false;

const personId = new ObjectId();
const bystanderId = new ObjectId();

beforeEach(async () => {
  process.env.MAPLE_MONGO_DB = TEST_DB;
  await closeDb();
  try {
    db = await getDb();
    mongoReachable = isDbConnected();
  } catch {
    mongoReachable = false;
    return;
  }
  if (!mongoReachable || !db) return;
  await db.collection('assets').deleteMany({});
  await db.collection('people').deleteMany({});
  await seed(db);
});

afterAll(async () => {
  if (db) await db.dropDatabase();
  await closeDb();
});

async function seed(d: Db): Promise<void> {
  const folder = new ObjectId();
  const now = new Date('2026-05-10T00:00:00Z').toISOString();
  const baseAsset = {
    size: 1,
    mtime: 1,
    rating: 0,
    flag: 0,
    color_label: '',
    indexed_at: 'now',
    deleted_at: null,
    hidden: false,
    exif: { captured_at: now },
  };
  await d.collection('people').insertMany([
    { _id: personId, name: 'Ex Cluded', merged_into: null, created_at: now, updated_at: now },
    { _id: bystanderId, name: 'By Stander', merged_into: null, created_at: now, updated_at: now },
  ] as never);
  await d.collection('assets').insertMany([
    {
      ...baseAsset,
      maple_id: 'with-excluded-person',
      fileinfo: [{ path: '', filename: 'a.dng', library_id: folder, deleted_at: null }],
      // Group shot: the excluded person plus a bystander — the whole asset
      // must drop, not just the one face.
      faces: [{ person_id: personId.toHexString() }, { person_id: bystanderId.toHexString() }],
    },
    {
      ...baseAsset,
      maple_id: 'without-person',
      fileinfo: [{ path: '', filename: 'b.dng', library_id: folder, deleted_at: null }],
      faces: [],
    },
  ] as never);
}

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

describe('person exclude (#2894, e2e against Mongo)', () => {
  it('drops assets with the excluded person from plain search, and restores on unexclude', async () => {
    if (!mongoReachable) return;

    expect((await searchIds()).sort()).toEqual(['a.dng', 'b.dng']);

    const ex = await post(`/${personId.toHexString()}/exclude`);
    expect(ex.status).toBe(200);

    // No flag on the request — exclusion must apply unconditionally.
    expect(await searchIds()).toEqual(['b.dng']);

    const unex = await post(`/${personId.toHexString()}/unexclude`);
    expect(unex.status).toBe(200);
    expect((await searchIds()).sort()).toEqual(['a.dng', 'b.dng']);
  });

  it('moves the person from the normal listing to the recovery list', async () => {
    if (!mongoReachable) return;

    expect((await peopleNames('/')).sort()).toEqual(['By Stander', 'Ex Cluded']);
    expect(await peopleNames('/excluded')).toEqual([]);

    await post(`/${personId.toHexString()}/exclude`);

    expect(await peopleNames('/')).toEqual(['By Stander']);
    expect(await peopleNames('/excluded')).toEqual(['Ex Cluded']);
    // Excluded ≠ hidden — the Hidden page stays empty.
    expect(await peopleNames('/hidden')).toEqual([]);

    await post(`/${personId.toHexString()}/unexclude`);
    expect((await peopleNames('/')).sort()).toEqual(['By Stander', 'Ex Cluded']);
    expect(await peopleNames('/excluded')).toEqual([]);
  });

  it('rejects a malformed person id', async () => {
    if (!mongoReachable) return;
    const res = await post('/not-an-id/exclude');
    expect(res.status).toBe(400);
  });
});

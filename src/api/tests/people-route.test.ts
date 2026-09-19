/**
 * /api/people/* route tests, against SQLite (#3787).
 *
 * Mounts the route without `requireAuth` (mirrors `tests/enrichment-route.test.ts`)
 * and drives it with `app.handle`, so every handler reaches `sqliteDb()` with no
 * override — hence `createLiveTestDatabase`, which installs the database as the
 * process-wide handle for the file.
 *
 * ## Why this file holds one database rather than one per test
 *
 * `POST /api/people/cluster` is the exception that decides it. The clustering
 * pass hands the database's *path* to its worker (`people.cluster-pool.ts`), so
 * it reaches the pool rather than the installed test handle and cannot run
 * against an in-memory database at all. So the file opens one file-backed
 * database, opens the real pool on the same file, and clears the fixture tables
 * between tests.
 *
 * The denormalised `PersonDoc.face_count` the Mongo version had to reconcile by
 * hand after every seed is gone: the count is derived from the `faces` rows, so
 * inserting a face *is* the update (`people.face-count.ts`).
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { Elysia } from 'elysia';
import { closeSqlitePool, openSqlitePool } from '../src/db/sqlite/index.ts';
import { newObjectIdHex } from '../src/db/object-id.ts';
import { shutdownClusterPool } from '../src/db/repos/people.cluster-pool.ts';
import { nearAxis } from '../src/db/repos/people.test-helpers.ts';
import {
  createLiveTestDatabase,
  insertFolder,
  type LiveTestDatabase,
} from '../src/db/sqlite/test-sqlite.test-helpers.ts';
import { createPerson } from '../src/people/people.repo.ts';
import { peopleRoutes } from '../src/routes/people.ts';
import {
  clearPeopleFixtures,
  coverAssetId,
  faceState,
  insertAssetWithFaces,
  type FaceSeed,
} from './helpers/people-fixtures.ts';

let live: LiveTestDatabase;
let libraryId: string;
const app = new Elysia().use(peopleRoutes);

beforeAll(async () => {
  live = await createLiveTestDatabase('file');
  // The clustering worker opens this same file read-only and sends its writes
  // back to the pool's single writer; see the module comment.
  await openSqlitePool({ path: live.path, readers: 1 });
  libraryId = insertFolder(live.db, { path: '/lib', slug: 'lib' });
});

beforeEach(() => {
  clearPeopleFixtures(live.db);
});

afterAll(() => {
  shutdownClusterPool();
  closeSqlitePool();
  live.close();
});

function seedFaces(faces: readonly FaceSeed[]): string {
  return insertAssetWithFaces(live.db, libraryId, faces);
}

async function get(path: string): Promise<{ status: number; body: unknown }> {
  const res = await app.handle(new Request(`http://localhost${path}`));
  return { status: res.status, body: res.status === 204 ? null : await res.json() };
}

async function post(
  path: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; body: unknown }> {
  const res = await app.handle(
    new Request(`http://localhost${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }),
  );
  return { status: res.status, body: res.status === 204 ? null : await res.json() };
}

async function put(
  path: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: unknown }> {
  const res = await app.handle(
    new Request(`http://localhost${path}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, body: res.status === 204 ? null : await res.json() };
}

/** `POST /api/people`, returning the new person's id. */
async function createPersonVia(name: string): Promise<string> {
  const created = await post('/api/people', { name });
  expect(created.status).toBe(200);
  return (created.body as { id: string }).id;
}

describe('POST /api/people', () => {
  it('creates a person', async () => {
    const r = await post('/api/people', { name: 'Alpha' });
    expect(r.status).toBe(200);
    expect((r.body as { name: string }).name).toBe('Alpha');
  });

  it('dedupes by name (case-insensitive)', async () => {
    const a = await post('/api/people', { name: 'Beta' });
    const b = await post('/api/people', { name: 'beta' });
    expect((a.body as { id: string }).id).toBe((b.body as { id: string }).id);
  });

  it('rejects empty name', async () => {
    const r = await post('/api/people', { name: '   ' });
    expect(r.status).toBe(400);
  });

  // #2877: the search `people` filter param is comma-separated, so a comma
  // in a name would split into names that resolve to nobody.
  it('rejects a name containing a comma', async () => {
    const r = await post('/api/people', { name: 'Doe, Jane' });
    expect(r.status).toBe(400);
    expect((r.body as { error: string }).error).toMatch(/comma/);
  });

  it('rejects a rename to a name containing a comma', async () => {
    const id = await createPersonVia('Comma Free');
    const r = await put(`/api/people/${id}`, { name: 'Free, Comma' });
    expect(r.status).toBe(400);
    expect((r.body as { error: string }).error).toMatch(/comma/);
  });
});

describe('PUT /api/people/:id', () => {
  it('renames', async () => {
    const id = await createPersonVia('Gamma');
    const r = await put(`/api/people/${id}`, { name: 'Gam' });
    expect(r.status).toBe(200);
    expect((r.body as { name: string }).name).toBe('Gam');
    expect((r.body as { merged_from: string | null }).merged_from).toBeNull();
  });

  it('merges on collision and reports merged_from', async () => {
    const aId = await createPersonVia('Delta');
    const bId = await createPersonVia('DeltaBis');
    // Rename b to "Delta" — collides with a.
    const r = await put(`/api/people/${bId}`, { name: 'Delta' });
    expect(r.status).toBe(200);
    const body = r.body as { id: string; merged_from: string | null };
    expect(body.merged_from).not.toBeNull();
    // Survivor must be the older id (lexicographic).
    const survivor = aId < bId ? aId : bId;
    const orphan = aId < bId ? bId : aId;
    expect(body.id).toBe(survivor);
    expect(body.merged_from).toBe(orphan);
  });

  it('404 for unknown id', async () => {
    const r = await put(`/api/people/${newObjectIdHex()}`, { name: 'Epsilon' });
    expect(r.status).toBe(404);
  });

  it('400 for malformed id', async () => {
    const r = await put(`/api/people/not-an-id`, { name: 'Zeta' });
    expect(r.status).toBe(400);
  });
});

describe('GET /api/people', () => {
  it('returns face counts and excludes merged people', async () => {
    const aId = await createPersonVia('Helen');
    const bId = await createPersonVia('Ivy');
    seedFaces([
      { bbox: { x: 0, y: 0, w: 1, h: 1 }, personId: aId },
      { bbox: { x: 1, y: 0, w: 1, h: 1 }, personId: aId },
      { bbox: { x: 2, y: 0, w: 1, h: 1 }, personId: bId },
    ]);
    const r = await get('/api/people');
    expect(r.status).toBe(200);
    const list = r.body as Array<{ name: string; face_count: number }>;
    expect(list).toHaveLength(2);
    expect(list.find((p) => p.name === 'Helen')?.face_count).toBe(2);
    expect(list.find((p) => p.name === 'Ivy')?.face_count).toBe(1);
  });

  it('self-heals missing cover_asset_id from assigned faces', async () => {
    // Legacy shape: a person with faces assigned but no cover_asset_id —
    // mirrors what we see on installs clustered before commit 1f32022.
    // POST /api/people creates the row without a cover; the faces are assigned
    // out of band, exactly the gap the opportunistic backfill closes.
    const personId = await createPersonVia('Nora');
    const lowConf = seedFaces([{ personId, confidence: 0.5 }]);
    const highConf = seedFaces([{ personId, confidence: 0.95 }]);
    // Sanity: cover is null before the GET.
    expect(coverAssetId(live.db, personId)).toBeNull();
    const r = await get('/api/people');
    expect(r.status).toBe(200);
    const list = r.body as Array<{ id: string; cover_asset_id: string | null }>;
    const nora = list.find((p) => p.id === personId);
    expect(nora?.cover_asset_id).toBe(highConf);
    // The lower-confidence face must not be picked.
    expect(nora?.cover_asset_id).not.toBe(lowConf);
  });
});

describe('GET /api/people/:id', () => {
  it('returns the person + recent faces', async () => {
    const id = await createPersonVia('Jack');
    seedFaces([{ bbox: { x: 0, y: 0, w: 10, h: 10 }, personId: id, confidence: 0.95 }]);
    const r = await get(`/api/people/${id}`);
    expect(r.status).toBe(200);
    const body = r.body as {
      faces: Array<{ asset_id: string; face_index: number; bbox: { w: number } }>;
    };
    expect(body.faces).toHaveLength(1);
    expect(body.faces[0]!.face_index).toBe(0);
    expect(body.faces[0]!.bbox.w).toBe(10);
  });
});

describe('POST /api/people/cluster', () => {
  it('assigns close faces to one cluster and creates new for far face', async () => {
    seedFaces([
      { bbox: { x: 0, y: 0, w: 1, h: 1 }, embedding: nearAxis(0, 0.05) },
      { bbox: { x: 1, y: 0, w: 1, h: 1 }, embedding: nearAxis(0, 0.1) },
      { bbox: { x: 2, y: 0, w: 1, h: 1 }, embedding: nearAxis(50, 0.05) },
    ]);
    const r = await post('/api/people/cluster', {});
    expect(r.status).toBe(200);
    const body = r.body as { assigned: number; new_people: number; scanned: number };
    expect(body.assigned).toBe(3);
    expect(body.new_people).toBe(2);
    expect(body.scanned).toBe(3);
  });
});

describe('POST /api/people/assign', () => {
  it('assigns then unassigns a face', async () => {
    const id = await createPersonVia('Kate');
    const asset = seedFaces([{ bbox: { x: 0, y: 0, w: 1, h: 1 } }]);
    let r = await post('/api/people/assign', {
      asset_id: asset,
      face_index: 0,
      person_id: id,
    });
    expect(r.status).toBe(200);
    expect(faceState(live.db, asset, 0)?.personId).toBe(id);
    r = await post('/api/people/assign', {
      asset_id: asset,
      face_index: 0,
      person_id: null,
    });
    expect(r.status).toBe(200);
    expect(faceState(live.db, asset, 0)?.personId).toBeNull();
  });
});

describe('POST /api/people/:id/hide + /unhide', () => {
  it('hide keeps faces assigned, drops the person from the list, surfaces it on /hidden', async () => {
    const id = await createPersonVia('Lex');
    const asset = seedFaces([{ bbox: { x: 0, y: 0, w: 1, h: 1 }, personId: id }]);

    const hide = await post(`/api/people/${id}/hide`);
    expect(hide.status).toBe(200);
    expect((hide.body as { ok: true }).ok).toBe(true);

    // Faces stay assigned — soft-hide is not a delete.
    expect(faceState(live.db, asset, 0)?.personId).toBe(id);

    // Gone from the normal list…
    const list = await get('/api/people');
    expect((list.body as Array<{ id: string }>).some((p) => p.id === id)).toBe(false);

    // …present on the Hidden list, with the same wire shape (face_count etc).
    const hidden = await get('/api/people/hidden');
    expect(hidden.status).toBe(200);
    const hiddenRows = hidden.body as Array<{ id: string; name: string; face_count: number }>;
    const lex = hiddenRows.find((p) => p.id === id);
    expect(lex?.name).toBe('Lex');
    expect(lex?.face_count).toBe(1);

    // Unhide restores it.
    const unhide = await post(`/api/people/${id}/unhide`);
    expect(unhide.status).toBe(200);
    expect((unhide.body as { ok: true }).ok).toBe(true);
    const back = await get('/api/people');
    expect((back.body as Array<{ id: string }>).some((p) => p.id === id)).toBe(true);
    const hidden2 = await get('/api/people/hidden');
    expect((hidden2.body as Array<{ id: string }>).some((p) => p.id === id)).toBe(false);
  });

  it('400 on invalid person id', async () => {
    const r = await post('/api/people/not-a-hex/hide');
    expect(r.status).toBe(400);
  });
});

describe('POST /api/people/hide', () => {
  it('removes the face from the person panel and prevents re-clustering', async () => {
    const id = await createPersonVia('Mira');
    const asset = seedFaces([
      {
        bbox: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
        personId: id,
        confidence: 0.95,
        embedding: nearAxis(60, 0.05),
      },
    ]);
    // Visible before hide.
    let detail = await get(`/api/people/${id}`);
    expect((detail.body as { faces: unknown[] }).faces).toHaveLength(1);
    // Hide it.
    const hide = await post('/api/people/hide', { asset_id: asset, face_index: 0 });
    expect(hide.status).toBe(200);
    expect((hide.body as { ok: true }).ok).toBe(true);
    // Disappears from the detail panel.
    detail = await get(`/api/people/${id}`);
    expect((detail.body as { faces: unknown[] }).faces).toHaveLength(0);
    // Re-running clustering does not pull the hidden face back.
    const cluster = await post('/api/people/cluster', {});
    expect((cluster.body as { assigned: number }).assigned).toBe(0);
    expect(faceState(live.db, asset, 0)).toEqual({ personId: null, hidden: true });
  });

  it("400 on invalid asset_id, 404 when asset doesn't exist", async () => {
    let r = await post('/api/people/hide', { asset_id: 'not-a-hex', face_index: 0 });
    expect(r.status).toBe(400);
    r = await post('/api/people/hide', {
      asset_id: 'deadbeefdeadbeefdeadbeef',
      face_index: 0,
    });
    expect(r.status).toBe(404);
  });
});

describe('POST /api/people/merge', () => {
  it('folds sources into the target and returns counts', async () => {
    const target = await createPerson('Alice');
    const src = await createPerson('Person 1');
    seedFaces([
      { bbox: { x: 0, y: 0, w: 10, h: 10 }, personId: src._id.toHexString(), confidence: 0.9 },
    ]);

    const r = await post('/api/people/merge', {
      target_id: target._id.toHexString(),
      source_ids: [src._id.toHexString()],
    });
    expect(r.status).toBe(200);
    const body = r.body as { id: string; name: string; merged_count: number };
    expect(body.id).toBe(target._id.toHexString());
    expect(body.name).toBe('Alice');
    expect(body.merged_count).toBe(1);

    // Source is now unreachable (tombstoned → getPerson returns 404).
    const gone = await get(`/api/people/${src._id.toHexString()}`);
    expect(gone.status).toBe(404);
  });

  it('400s on an invalid target id', async () => {
    const r = await post('/api/people/merge', {
      target_id: 'not-an-id',
      source_ids: ['0123456789abcdef01234567'],
    });
    expect(r.status).toBe(400);
  });

  it('404s on an unknown target', async () => {
    const r = await post('/api/people/merge', {
      target_id: newObjectIdHex(),
      source_ids: [newObjectIdHex()],
    });
    expect(r.status).toBe(404);
  });

  it('400s when source_ids dedup to empty (only the target)', async () => {
    const target = await createPerson('Alice');
    const r = await post('/api/people/merge', {
      target_id: target._id.toHexString(),
      source_ids: [target._id.toHexString()],
    });
    expect(r.status).toBe(400);
  });
});

describe('cover_bbox surface', () => {
  it('list response includes cover_bbox once clustering has run', async () => {
    const bbox = { x: 0.3, y: 0.2, w: 0.4, h: 0.5 };
    seedFaces([{ bbox, embedding: nearAxis(70, 0.05) }]);
    await post('/api/people/cluster', {});
    const list = await get('/api/people');
    const rows = list.body as Array<{
      name: string;
      cover_bbox: { x: number; y: number; w: number; h: number } | null;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.cover_bbox).toEqual(bbox);
  });
});

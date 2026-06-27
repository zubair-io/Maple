/**
 * /api/people/* route tests. Mounts the route without `requireAuth`
 * (mirrors `tests/enrichment-route.test.ts`); skip-passes when Mongo is
 * unreachable.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { Elysia } from 'elysia';
import { MongoClient, ObjectId, type Db } from 'mongodb';
import type { AssetDoc, AssetFaceDoc } from '../src/db/schema.ts';

const TEST_DB = `maple_test_people_route_${process.pid}`;
process.env.MAPLE_MONGO_DB = TEST_DB;
const MONGO_URI = process.env.MAPLE_MONGO_URI ?? 'mongodb://localhost:27017';

let mongo: MongoClient | null = null;
let mongoReachable = false;
let db: Db | null = null;
let app: Elysia | null = null;

const DIM = 512;

async function tryConnect(): Promise<MongoClient | null> {
  const c = new MongoClient(MONGO_URI, {
    serverSelectionTimeoutMS: 1500,
    connectTimeoutMS: 1500,
  });
  try {
    await c.connect();
    await c.db('admin').command({ ping: 1 });
    return c;
  } catch {
    try {
      await c.close();
    } catch {}
    return null;
  }
}

// Shared library so `getPerson`'s abs_path resolution finds a real
// root — see comment on `insertAssetWithFaces`.
const LIBRARY_ID = new ObjectId();

beforeAll(async () => {
  mongo = await tryConnect();
  mongoReachable = mongo !== null;
  if (!mongoReachable) {
    console.log('[people-route.test] skipping: MongoDB unreachable');
    return;
  }
  db = mongo!.db(TEST_DB);
  await db.dropDatabase();
  for (const name of ['users', 'credentials', 'invites', 'refresh_tokens', 'challenges']) {
    await db.createCollection(name).catch(() => undefined);
  }
  await db.collection('folders').insertOne({
    _id: LIBRARY_ID,
    path: '/lib',
    label: 'lib',
    last_scan: null,
    file_count: 0,
    created_at: new Date().toISOString(),
  } as never);
  const { closeDb, ensureIndexes } = await import('../src/db/client.ts');
  await closeDb();
  await ensureIndexes();
  // Invalidate the process-wide libraries cache so this suite sees the
  // folder seeded above rather than reusing a sibling-suite entry.
  const { invalidateLibraryRoots } = await import('../src/indexer/libraries.cache.ts');
  invalidateLibraryRoots();
  const { peopleRoutes } = await import('../src/routes/people.ts');
  app = new Elysia().use(peopleRoutes);
});

beforeEach(async () => {
  if (!mongoReachable) return;
  await db!.collection('people').deleteMany({});
  await db!.collection('assets').deleteMany({});
});

afterAll(async () => {
  if (mongo) {
    await mongo.db(TEST_DB).dropDatabase();
    await mongo.close();
  }
  const { closeDb } = await import('../src/db/client.ts');
  await closeDb();
});

function nearAxis(axis: number, jitter: number): number[] {
  const v = new Array<number>(DIM).fill(0);
  v[axis] = 1 - jitter;
  v[(axis + 1) % DIM] = jitter / 2;
  v[(axis + 2) % DIM] = jitter / 2;
  return v;
}

async function insertAssetWithFaces(faces: AssetFaceDoc[]): Promise<ObjectId> {
  // Use the shared LIBRARY_ID so `getPerson`'s `assetAbsPath` lookup
  // resolves through the seeded folder — otherwise random per-row
  // library_ids would not be in the libraries cache and `getPerson`
  // would skip every face row (post drop-abs-path-2026-05-21).
  const doc: AssetDoc = {
    fileinfo: [
      {
        path: '',
        filename: `${Math.random().toString(36).slice(2, 8)}.jpg`,
        library_id: LIBRARY_ID,
        deleted_at: null,
      },
    ],
    size: 1024,
    mtime: Date.now(),
    rating: 0,
    flag: 0,
    color_label: '',
    indexed_at: new Date().toISOString(),
    faces,
  };
  const res = await db!.collection('assets').insertOne(doc as AssetDoc);
  return res.insertedId;
}

async function get(path: string): Promise<{ status: number; body: unknown }> {
  const res = await app!.handle(new Request(`http://localhost${path}`));
  return { status: res.status, body: res.status === 204 ? null : await res.json() };
}

async function post(
  path: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; body: unknown }> {
  const res = await app!.handle(
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
  const res = await app!.handle(
    new Request(`http://localhost${path}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, body: res.status === 204 ? null : await res.json() };
}

describe('POST /api/people', () => {
  it('creates a person', async () => {
    if (!mongoReachable) return;
    const r = await post('/api/people', { name: 'Alpha' });
    expect(r.status).toBe(200);
    expect((r.body as { name: string }).name).toBe('Alpha');
  });

  it('dedupes by name (case-insensitive)', async () => {
    if (!mongoReachable) return;
    const a = await post('/api/people', { name: 'Beta' });
    const b = await post('/api/people', { name: 'beta' });
    expect((a.body as { id: string }).id).toBe((b.body as { id: string }).id);
  });

  it('rejects empty name', async () => {
    if (!mongoReachable) return;
    const r = await post('/api/people', { name: '   ' });
    expect(r.status).toBe(400);
  });
});

describe('PUT /api/people/:id', () => {
  it('renames', async () => {
    if (!mongoReachable) return;
    const created = await post('/api/people', { name: 'Gamma' });
    const id = (created.body as { id: string }).id;
    const r = await put(`/api/people/${id}`, { name: 'Gam' });
    expect(r.status).toBe(200);
    expect((r.body as { name: string }).name).toBe('Gam');
    expect((r.body as { merged_from: string | null }).merged_from).toBeNull();
  });

  it('merges on collision and reports merged_from', async () => {
    if (!mongoReachable) return;
    const a = await post('/api/people', { name: 'Delta' });
    const b = await post('/api/people', { name: 'DeltaBis' });
    const aId = (a.body as { id: string }).id;
    const bId = (b.body as { id: string }).id;
    // Rename b to "Delta" — collides with a.
    const r = await put(`/api/people/${bId}`, { name: 'Delta' });
    expect(r.status).toBe(200);
    const body = r.body as { id: string; merged_from: string | null };
    expect(body.merged_from).not.toBeNull();
    // Survivor must be the older _id (lexicographic).
    const survivor = aId < bId ? aId : bId;
    const orphan = aId < bId ? bId : aId;
    expect(body.id).toBe(survivor);
    expect(body.merged_from).toBe(orphan);
  });

  it('404 for unknown id', async () => {
    if (!mongoReachable) return;
    const r = await put(`/api/people/${new ObjectId().toHexString()}`, {
      name: 'Epsilon',
    });
    expect(r.status).toBe(404);
  });

  it('400 for malformed id', async () => {
    if (!mongoReachable) return;
    const r = await put(`/api/people/not-an-id`, { name: 'Zeta' });
    expect(r.status).toBe(400);
  });
});

describe('GET /api/people', () => {
  it('returns face counts and excludes merged people', async () => {
    if (!mongoReachable) return;
    const a = await post('/api/people', { name: 'Helen' });
    const b = await post('/api/people', { name: 'Ivy' });
    const aId = (a.body as { id: string }).id;
    const bId = (b.body as { id: string }).id;
    const asset = await insertAssetWithFaces([
      { bbox: { x: 0, y: 0, w: 1, h: 1 }, person_id: aId, confidence: 0.9 },
      { bbox: { x: 1, y: 0, w: 1, h: 1 }, person_id: aId, confidence: 0.9 },
      { bbox: { x: 2, y: 0, w: 1, h: 1 }, person_id: bId, confidence: 0.9 },
    ]);
    expect(asset).toBeInstanceOf(ObjectId);
    const r = await get('/api/people');
    expect(r.status).toBe(200);
    const list = r.body as Array<{ name: string; face_count: number }>;
    expect(list).toHaveLength(2);
    const helen = list.find((p) => p.name === 'Helen');
    const ivy = list.find((p) => p.name === 'Ivy');
    expect(helen?.face_count).toBe(2);
    expect(ivy?.face_count).toBe(1);
  });

  it('self-heals missing cover_asset_id from assigned faces', async () => {
    if (!mongoReachable) return;
    // Legacy shape: a person doc with faces assigned but no cover_asset_id —
    // mirrors what we see on installs clustered before commit 1f32022.
    // POST /api/people creates the doc without seeding cover_asset_id; the
    // face is assigned out-of-band via insertAssetWithFaces, exactly the
    // gap that the opportunistic backfill is supposed to close.
    const created = await post('/api/people', { name: 'Nora' });
    const personId = (created.body as { id: string }).id;
    const lowConf = await insertAssetWithFaces([
      { bbox: { x: 0, y: 0, w: 1, h: 1 }, person_id: personId, confidence: 0.5 },
    ]);
    const highConf = await insertAssetWithFaces([
      { bbox: { x: 0, y: 0, w: 1, h: 1 }, person_id: personId, confidence: 0.95 },
    ]);
    // Sanity: cover is null before the GET.
    const before = await db!.collection('people').findOne({ _id: new ObjectId(personId) });
    expect(before?.cover_asset_id ?? null).toBeNull();
    const r = await get('/api/people');
    expect(r.status).toBe(200);
    const list = r.body as Array<{ id: string; cover_asset_id: string | null }>;
    const nora = list.find((p) => p.id === personId);
    expect(nora?.cover_asset_id).toBe(highConf.toHexString());
    // The lower-confidence face must not be picked.
    expect(nora?.cover_asset_id).not.toBe(lowConf.toHexString());
  });
});

describe('GET /api/people/:id', () => {
  it('returns the person + recent faces', async () => {
    if (!mongoReachable) return;
    const created = await post('/api/people', { name: 'Jack' });
    const id = (created.body as { id: string }).id;
    await insertAssetWithFaces([
      { bbox: { x: 0, y: 0, w: 10, h: 10 }, person_id: id, confidence: 0.95 },
    ]);
    const r = await get(`/api/people/${id}`);
    expect(r.status).toBe(200);
    const body = r.body as {
      faces: Array<{ asset_id: string; face_index: number; bbox: { w: number } }>;
    };
    expect(body.faces).toHaveLength(1);
    expect(body.faces[0].face_index).toBe(0);
    expect(body.faces[0].bbox.w).toBe(10);
  });
});

describe('POST /api/people/cluster', () => {
  it('assigns close faces to one cluster and creates new for far face', async () => {
    if (!mongoReachable) return;
    await insertAssetWithFaces([
      {
        bbox: { x: 0, y: 0, w: 1, h: 1 },
        person_id: null,
        confidence: 0.9,
        embedding: nearAxis(0, 0.05),
      },
      {
        bbox: { x: 1, y: 0, w: 1, h: 1 },
        person_id: null,
        confidence: 0.9,
        embedding: nearAxis(0, 0.1),
      },
      {
        bbox: { x: 2, y: 0, w: 1, h: 1 },
        person_id: null,
        confidence: 0.9,
        embedding: nearAxis(50, 0.05),
      },
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
    if (!mongoReachable) return;
    const created = await post('/api/people', { name: 'Kate' });
    const id = (created.body as { id: string }).id;
    const asset = await insertAssetWithFaces([
      { bbox: { x: 0, y: 0, w: 1, h: 1 }, person_id: null, confidence: 0.9 },
    ]);
    let r = await post('/api/people/assign', {
      asset_id: asset.toHexString(),
      face_index: 0,
      person_id: id,
    });
    expect(r.status).toBe(200);
    let row = await db!.collection<AssetDoc>('assets').findOne({ _id: asset });
    expect(row?.faces?.[0]?.person_id).toBe(id);
    r = await post('/api/people/assign', {
      asset_id: asset.toHexString(),
      face_index: 0,
      person_id: null,
    });
    expect(r.status).toBe(200);
    row = await db!.collection<AssetDoc>('assets').findOne({ _id: asset });
    expect(row?.faces?.[0]?.person_id).toBeNull();
  });
});

describe('POST /api/people/:id/hide + /unhide', () => {
  it('hide keeps faces assigned, drops the person from the list, surfaces it on /hidden', async () => {
    if (!mongoReachable) return;
    const created = await post('/api/people', { name: 'Lex' });
    const id = (created.body as { id: string }).id;
    const asset = await insertAssetWithFaces([
      { bbox: { x: 0, y: 0, w: 1, h: 1 }, person_id: id, confidence: 0.9 },
    ]);

    const hide = await post(`/api/people/${id}/hide`);
    expect(hide.status).toBe(200);
    expect((hide.body as { ok: true }).ok).toBe(true);

    // Faces stay assigned — soft-hide is not a delete.
    const row = await db!.collection<AssetDoc>('assets').findOne({ _id: asset });
    expect(row?.faces?.[0]?.person_id).toBe(id);

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
    if (!mongoReachable) return;
    const r = await post('/api/people/not-a-hex/hide');
    expect(r.status).toBe(400);
  });
});

describe('POST /api/people/hide', () => {
  it('removes the face from the person panel and prevents re-clustering', async () => {
    if (!mongoReachable) return;
    const created = await post('/api/people', { name: 'Mira' });
    const id = (created.body as { id: string }).id;
    const asset = await insertAssetWithFaces([
      {
        bbox: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
        person_id: id,
        confidence: 0.95,
        embedding: nearAxis(60, 0.05),
      },
    ]);
    // Visible before hide.
    let detail = await get(`/api/people/${id}`);
    expect((detail.body as { faces: unknown[] }).faces).toHaveLength(1);
    // Hide it.
    const hide = await post('/api/people/hide', {
      asset_id: asset.toHexString(),
      face_index: 0,
    });
    expect(hide.status).toBe(200);
    expect((hide.body as { ok: true }).ok).toBe(true);
    // Disappears from the detail panel.
    detail = await get(`/api/people/${id}`);
    expect((detail.body as { faces: unknown[] }).faces).toHaveLength(0);
    // Re-running clustering does not pull the hidden face back.
    const cluster = await post('/api/people/cluster', {});
    expect((cluster.body as { assigned: number }).assigned).toBe(0);
    const row = await db!.collection<AssetDoc>('assets').findOne({ _id: asset });
    expect(row?.faces?.[0]?.hidden).toBe(true);
    expect(row?.faces?.[0]?.person_id).toBeNull();
  });

  it("400 on invalid asset_id, 404 when asset doesn't exist", async () => {
    if (!mongoReachable) return;
    let r = await post('/api/people/hide', {
      asset_id: 'not-a-hex',
      face_index: 0,
    });
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
    if (!mongoReachable) return;
    const { createPerson } = await import('../src/people/people.repo.ts');
    const target = await createPerson('Alice');
    const src = await createPerson('Person 1');
    await insertAssetWithFaces([
      { bbox: { x: 0, y: 0, w: 10, h: 10 }, person_id: src._id.toHexString(), confidence: 0.9 },
    ]);

    const r = await post('/api/people/merge', {
      target_id: target._id.toHexString(),
      source_ids: [src._id.toHexString()],
    });
    expect(r.status).toBe(200);
    const body = r.body as {
      id: string;
      name: string;
      merged_count: number;
    };
    expect(body.id).toBe(target._id.toHexString());
    expect(body.name).toBe('Alice');
    expect(body.merged_count).toBe(1);

    // Source is now unreachable (tombstoned → getPerson returns 404).
    const gone = await get(`/api/people/${src._id.toHexString()}`);
    expect(gone.status).toBe(404);
  });

  it('400s on an invalid target id', async () => {
    if (!mongoReachable) return;
    const r = await post('/api/people/merge', {
      target_id: 'not-an-id',
      source_ids: ['0123456789abcdef01234567'],
    });
    expect(r.status).toBe(400);
  });

  it('404s on an unknown target', async () => {
    if (!mongoReachable) return;
    const r = await post('/api/people/merge', {
      target_id: new ObjectId().toHexString(),
      source_ids: [new ObjectId().toHexString()],
    });
    expect(r.status).toBe(404);
  });

  it('400s when source_ids dedup to empty (only the target)', async () => {
    if (!mongoReachable) return;
    const { createPerson } = await import('../src/people/people.repo.ts');
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
    if (!mongoReachable) return;
    const bbox = { x: 0.3, y: 0.2, w: 0.4, h: 0.5 };
    await insertAssetWithFaces([
      {
        bbox,
        person_id: null,
        confidence: 0.9,
        embedding: nearAxis(70, 0.05),
      },
    ]);
    await post('/api/people/cluster', {});
    const list = await get('/api/people');
    const rows = list.body as Array<{
      name: string;
      cover_bbox: { x: number; y: number; w: number; h: number } | null;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].cover_bbox).toEqual(bbox);
  });
});

describe('POST /api/people/:id/cover', () => {
  it('sets cover_asset_id and cover_bbox from the face doc server-side', async () => {
    if (!mongoReachable) return;
    const created = await post('/api/people', { name: 'Cover' });
    const personId = (created.body as { id: string }).id;
    const bbox = { x: 0.1, y: 0.2, w: 0.3, h: 0.4 };
    const asset = await insertAssetWithFaces([{ bbox, person_id: personId, confidence: 0.88 }]);
    const r = await post(`/api/people/${personId}/cover`, {
      asset_id: asset.toHexString(),
      face_index: 0,
    });
    expect(r.status).toBe(200);
    expect((r.body as { ok: boolean }).ok).toBe(true);
    // Verify via GET /api/people/:id that cover fields updated.
    const detail = await get(`/api/people/${personId}`);
    expect((detail.body as { cover_asset_id: string }).cover_asset_id).toBe(asset.toHexString());
    expect((detail.body as { cover_bbox: object }).cover_bbox).toEqual(bbox);
  });

  it('400 when face does not belong to this person', async () => {
    if (!mongoReachable) return;
    const p1 = await post('/api/people', { name: 'CoverP1' });
    const p2 = await post('/api/people', { name: 'CoverP2' });
    const p1Id = (p1.body as { id: string }).id;
    const p2Id = (p2.body as { id: string }).id;
    const asset = await insertAssetWithFaces([
      { bbox: { x: 0, y: 0, w: 1, h: 1 }, person_id: p2Id, confidence: 0.9 },
    ]);
    const r = await post(`/api/people/${p1Id}/cover`, {
      asset_id: asset.toHexString(),
      face_index: 0,
    });
    expect(r.status).toBe(400);
  });

  it('400 when face is hidden', async () => {
    if (!mongoReachable) return;
    const created = await post('/api/people', { name: 'CoverHidden' });
    const personId = (created.body as { id: string }).id;
    const asset = await insertAssetWithFaces([
      {
        bbox: { x: 0, y: 0, w: 1, h: 1 },
        person_id: personId,
        confidence: 0.9,
        hidden: true,
      } as AssetFaceDoc & { hidden: boolean },
    ]);
    const r = await post(`/api/people/${personId}/cover`, {
      asset_id: asset.toHexString(),
      face_index: 0,
    });
    expect(r.status).toBe(400);
  });

  it('404 for unknown asset_id', async () => {
    if (!mongoReachable) return;
    const created = await post('/api/people', { name: 'CoverMissing' });
    const personId = (created.body as { id: string }).id;
    const r = await post(`/api/people/${personId}/cover`, {
      asset_id: new ObjectId().toHexString(),
      face_index: 0,
    });
    expect(r.status).toBe(404);
  });

  it('does not clobber a manually-set cover on backfill', async () => {
    if (!mongoReachable) return;
    // Set up a person with two faces; manually pin the cover to face 0 (lower
    // confidence). backfillCoverAssets should NOT overwrite a manually-set cover.
    const created = await post('/api/people', { name: 'CoverStable' });
    const personId = (created.body as { id: string }).id;
    const bboxManual = { x: 0.5, y: 0.5, w: 0.1, h: 0.1 };
    const assetLow = await insertAssetWithFaces([
      { bbox: bboxManual, person_id: personId, confidence: 0.6 },
    ]);
    // Face with higher confidence on a second asset.
    await insertAssetWithFaces([
      { bbox: { x: 0, y: 0, w: 1, h: 1 }, person_id: personId, confidence: 0.98 },
    ]);
    // Manually set the low-confidence face as cover.
    const setCover = await post(`/api/people/${personId}/cover`, {
      asset_id: assetLow.toHexString(),
      face_index: 0,
    });
    expect(setCover.status).toBe(200);
    // Run backfill — it should only fill MISSING covers.
    const { backfillCoverAssets } = await import('../src/people/clustering-job.ts');
    await backfillCoverAssets();
    // The cover should still point at the manually-pinned (lower-conf) asset.
    const detail = await get(`/api/people/${personId}`);
    expect((detail.body as { cover_asset_id: string }).cover_asset_id).toBe(assetLow.toHexString());
    expect((detail.body as { cover_bbox: object }).cover_bbox).toEqual(bboxManual);
  });
});

describe('GET /api/people/:id pagination', () => {
  it('respects offset and limit query params', async () => {
    if (!mongoReachable) return;
    const created = await post('/api/people', { name: 'PaginatedPerson' });
    const personId = (created.body as { id: string }).id;
    // Insert 5 faces across 5 separate assets.
    for (let i = 0; i < 5; i++) {
      await insertAssetWithFaces([
        { bbox: { x: i * 0.1, y: 0, w: 0.1, h: 0.1 }, person_id: personId, confidence: 0.9 },
      ]);
    }
    // First page of 3.
    const page1 = await get(`/api/people/${personId}?offset=0&limit=3`);
    expect(page1.status).toBe(200);
    const p1body = page1.body as { faces: unknown[]; offset: number; limit: number };
    expect(p1body.faces).toHaveLength(3);
    expect(p1body.offset).toBe(0);
    expect(p1body.limit).toBe(3);
    // Second page — fewer than limit signals end-of-list.
    const page2 = await get(`/api/people/${personId}?offset=3&limit=3`);
    expect(page2.status).toBe(200);
    const p2body = page2.body as { faces: unknown[] };
    expect(p2body.faces).toHaveLength(2);
  });
});

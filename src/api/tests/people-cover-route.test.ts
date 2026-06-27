/**
 * /api/people/:id/cover + GET /api/people/:id pagination route tests. Split
 * out of `people-route.test.ts` to keep each file within the 600-LOC budget.
 * Mounts the route without `requireAuth` (mirrors `tests/enrichment-route.test.ts`);
 * skip-passes when Mongo is unreachable.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { Elysia } from 'elysia';
import { MongoClient, ObjectId, type Db } from 'mongodb';
import type { AssetDoc, AssetFaceDoc } from '../src/db/schema.ts';

// Distinct DB suffix from people-route.test.ts so the two suites never collide
// when bun runs them in the same process.
const TEST_DB = `maple_test_people_cover_route_${process.pid}`;
process.env.MAPLE_MONGO_DB = TEST_DB;
const MONGO_URI = process.env.MAPLE_MONGO_URI ?? 'mongodb://localhost:27017';

let mongo: MongoClient | null = null;
let mongoReachable = false;
let db: Db | null = null;
let app: Elysia | null = null;

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
    console.log('[people-cover-route.test] skipping: MongoDB unreachable');
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

  it('404 when the person row was deleted after the face was assigned', async () => {
    if (!mongoReachable) return;
    // The face still points at this person id, but the person row is gone
    // (deleted/merged out-of-band between the face read and the cover write).
    // The update must match zero rows and report not-found, not a phantom 200.
    const created = await post('/api/people', { name: 'CoverDeleted' });
    const personId = (created.body as { id: string }).id;
    const asset = await insertAssetWithFaces([
      { bbox: { x: 0, y: 0, w: 1, h: 1 }, person_id: personId, confidence: 0.9 },
    ]);
    // Drop the person row, leaving the dangling face pointer behind.
    await db!.collection('people').deleteOne({ _id: new ObjectId(personId) });
    const r = await post(`/api/people/${personId}/cover`, {
      asset_id: asset.toHexString(),
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

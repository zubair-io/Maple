/**
 * Route-integration tests for the manual override routes:
 *
 *   PUT /api/assets/:id/place
 *   PUT /api/assets/:id/description
 *
 * Pins the HTTP contract (400 on a malformed id, 404 on an unknown asset,
 * 204 + persisted field on success, `null` clears) so the shared
 * asset-resolution prelude in `_shared.ts` can be applied to this file
 * without a silent status/message drift (#1988). Requires a running
 * MongoDB (skip-passes when unreachable), same harness shape as
 * `trash.intent.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import { MongoClient, ObjectId, type Db } from 'mongodb';
import { closeDb } from '../../db/client.ts';
import { overrideRoutes } from './overrides.ts';
import { fakeAuth } from '../../../tests/helpers/test-auth.ts';

const MONGO_URI = process.env.MAPLE_MONGO_URI ?? 'mongodb://localhost:27017';
const TEST_DB = `maple_overrides_route_test_${process.pid}`;

async function tryConnect(): Promise<MongoClient | null> {
  const c = new MongoClient(MONGO_URI, {
    serverSelectionTimeoutMS: 1_500,
    connectTimeoutMS: 1_500,
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

const app = new Elysia({ prefix: '/api/assets' }).use(fakeAuth()).use(overrideRoutes);

function put(id: string, field: 'place' | 'description', body: unknown): Promise<Response> {
  return app.handle(
    new Request(`http://localhost/api/assets/${id}/${field}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

describe('PUT /api/assets/:id/{place,description}', () => {
  let mongo: MongoClient | null = null;
  let db: Db | null = null;
  let assetId: ObjectId | null = null;

  beforeEach(async () => {
    mongo = await tryConnect();
    if (!mongo) return;
    process.env.MAPLE_MONGO_URI = MONGO_URI;
    process.env.MAPLE_MONGO_DB = TEST_DB;
    await closeDb();
    db = mongo.db(TEST_DB);
    await db.dropDatabase();
    const libraryId = new ObjectId();
    assetId = new ObjectId();
    await db.collection('folders').insertOne({
      _id: libraryId,
      path: '/nonexistent/overrides-route-test',
      label: 'overrides-route-test',
      last_scan: null,
      file_count: 0,
      created_at: 'now',
    } as never);
    await db.collection('assets').insertOne({
      _id: assetId,
      fileinfo: [{ path: '', filename: 'a.dng', library_id: libraryId, deleted_at: null }],
      maple_id: 'ovr' + assetId.toHexString(),
      size: 1,
      mtime: Date.now(),
      rating: 0,
      flag: 0,
      color_label: '',
      indexed_at: 'now',
      place: null,
      description: 'from the worker',
      search_blob: '',
    } as never);
  });

  afterEach(async () => {
    if (db) await db.dropDatabase().catch(() => {});
    if (mongo) await mongo.close().catch(() => {});
    await closeDb();
    db = null;
    mongo = null;
    assetId = null;
  });

  it('400s on a malformed asset id with the shared error body', async () => {
    if (!mongo) {
      console.log('[overrides.test] MongoDB unreachable — skipping');
      return;
    }
    for (const field of ['place', 'description'] as const) {
      const res = await put('not-an-objectid', field, {
        [field === 'place' ? 'place' : 'text']: null,
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'Invalid asset id' });
    }
  });

  it('404s on an unknown asset id with the shared error body', async () => {
    if (!mongo) return;
    const unknown = new ObjectId().toHexString();
    const place = await put(unknown, 'place', { place: null });
    expect(place.status).toBe(404);
    expect(await place.json()).toEqual({ error: 'Asset not found' });
    const description = await put(unknown, 'description', { text: null });
    expect(description.status).toBe(404);
    expect(await description.json()).toEqual({ error: 'Asset not found' });
  });

  it('pins a place override (204) and null clears it', async () => {
    if (!mongo) return;
    const id = assetId!.toHexString();
    const place = { search_blob: 'Reykjavík Iceland', city: 'Reykjavík' };
    const res = await put(id, 'place', { place });
    expect(res.status).toBe(204);
    const pinned = await db!.collection('assets').findOne({ _id: assetId! });
    expect(pinned?.place).toEqual(place);
    // `search_blob` is a lowercased, sorted token bag recomputed atomically.
    expect(pinned?.search_blob).toContain('reykjavík');

    const cleared = await put(id, 'place', { place: null });
    expect(cleared.status).toBe(204);
    const after = await db!.collection('assets').findOne({ _id: assetId! });
    expect(after?.place).toBeNull();
  });

  it('pins a description override (204) and null clears it', async () => {
    if (!mongo) return;
    const id = assetId!.toHexString();
    const res = await put(id, 'description', { text: 'two gulls on a pier' });
    expect(res.status).toBe(204);
    const pinned = await db!.collection('assets').findOne({ _id: assetId! });
    expect(pinned?.description).toBe('two gulls on a pier');
    expect(pinned?.search_blob).toContain('gulls');

    const cleared = await put(id, 'description', { text: null });
    expect(cleared.status).toBe(204);
    const after = await db!.collection('assets').findOne({ _id: assetId! });
    expect(after?.description).toBeNull();
  });

  it('rejects a body that fails the schema (4xx) without touching the asset', async () => {
    if (!mongo) return;
    const res = await put(assetId!.toHexString(), 'description', { text: 42 });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    const doc = await db!.collection('assets').findOne({ _id: assetId! });
    expect(doc?.description).toBe('from the worker');
  });
});

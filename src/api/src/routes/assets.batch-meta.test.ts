/**
 * Integration tests for POST /api/assets/batch-meta (#2995).
 *
 * The File Provider's change-feed resolution used to make one
 * GET /api/assets/:id round trip per change row; this endpoint resolves a
 * whole page of ids in one request. Contract under test:
 *   - found ids come back with the same DTO shape as GET /:id
 *   - unknown (but valid) ids are silently absent from `assets`
 *   - malformed body / invalid id / over-500 ids → 400
 *
 * Skip-passes when Mongo isn't reachable, same shape as the histogram tests
 * in this folder.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import { MongoClient, ObjectId, type Db } from 'mongodb';
import { closeDb } from '../db/client.ts';
import { assetsRoutes } from './assets.ts';
import { fakeAuth } from '../../tests/helpers/test-auth.ts';

const TEST_DB = `maple_batch_meta_test_${process.pid}`;
// Captured per-test (not at module scope): bun imports every test file's
// module body before running tests, so a module-scope snapshot could
// restore values another suite had already changed by the time this one
// runs (jules review, PR #3009 — same fix as browse.registered-roots).
let mongoUri = '';
let originalMongoDb: string | undefined;
let originalMongoUri: string | undefined;

async function tryConnect(): Promise<MongoClient | null> {
  const c = new MongoClient(mongoUri, {
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

let client: MongoClient | null = null;
let db: Db | null = null;

beforeEach(async () => {
  originalMongoDb = process.env.MAPLE_MONGO_DB;
  originalMongoUri = process.env.MAPLE_MONGO_URI;
  mongoUri = process.env.MAPLE_MONGO_URI ?? 'mongodb://localhost:27017';
  client = await tryConnect();
  if (!client) return;
  await closeDb();
  process.env.MAPLE_MONGO_URI = mongoUri;
  process.env.MAPLE_MONGO_DB = TEST_DB;
  db = client.db(TEST_DB);
  await db.dropDatabase();
});

afterEach(async () => {
  if (originalMongoDb === undefined) delete process.env.MAPLE_MONGO_DB;
  else process.env.MAPLE_MONGO_DB = originalMongoDb;
  if (originalMongoUri === undefined) delete process.env.MAPLE_MONGO_URI;
  else process.env.MAPLE_MONGO_URI = originalMongoUri;
  await closeDb();
  if (client) {
    await client.db(TEST_DB).dropDatabase();
    await client.close();
    client = null;
  }
  db = null;
});

async function insertAsset(d: Db, filename: string): Promise<ObjectId> {
  const id = new ObjectId();
  await d.collection('assets').insertOne({
    _id: id,
    fileinfo: [{ library_id: new ObjectId(), path: '2026', filename, deleted_at: null }],
    size: 1024,
    mtime: 1_700_000_000_000,
    rating: 0,
    flag: 0,
    color_label: '',
    indexed_at: '2026-01-01T00:00:00Z',
    has_xmp: false,
    deleted_at: null,
  } as never);
  return id;
}

function post(app: Elysia, body: unknown): Promise<Response> {
  return app.handle(
    new Request('http://localhost/api/assets/batch-meta', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

describe('POST /api/assets/batch-meta', () => {
  it('resolves found ids and omits unknown ids', async () => {
    if (!db) return; // Mongo unreachable — skip-pass
    const a = await insertAsset(db, 'IMG_1.dng');
    const b = await insertAsset(db, 'IMG_2.dng');
    const missing = new ObjectId();
    const app = new Elysia().use(fakeAuth()).use(assetsRoutes);

    const res = await post(app, {
      ids: [a.toHexString(), b.toHexString(), missing.toHexString()],
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { assets: { id: string; filename: string }[] };
    const byId = new Map(body.assets.map((x) => [x.id, x]));
    expect(byId.size).toBe(2);
    expect(byId.get(a.toHexString())?.filename).toBe('IMG_1.dng');
    expect(byId.get(b.toHexString())?.filename).toBe('IMG_2.dng');
    expect(byId.has(missing.toHexString())).toBe(false);
  });

  it('returns an empty list for an empty ids array', async () => {
    if (!db) return;
    const app = new Elysia().use(fakeAuth()).use(assetsRoutes);
    const res = await post(app, { ids: [] });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { assets: unknown[] }).assets).toEqual([]);
  });

  it('400s on a malformed body, an invalid id, and over 500 ids', async () => {
    if (!db) return;
    const app = new Elysia().use(fakeAuth()).use(assetsRoutes);

    expect((await post(app, { nope: true })).status).toBe(400);
    expect((await post(app, { ids: ['not-hex'] })).status).toBe(400);
    const tooMany = Array.from({ length: 501 }, () => new ObjectId().toHexString());
    expect((await post(app, { ids: tooMany })).status).toBe(400);
  });
});

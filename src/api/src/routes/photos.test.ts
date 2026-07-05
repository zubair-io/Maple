import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import { MongoClient, type Db, ObjectId } from 'mongodb';
import { closeDb } from '../db/client.ts';
import { photosRoutes } from './photos.ts';
import { setLibraryRootsForTests } from '../indexer/libraries.cache.ts';

const MONGO_URI = process.env.MAPLE_MONGO_URI ?? 'mongodb://localhost:27017';
const TEST_DB = `maple_photos_test_${process.pid}`;

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

describe('/api/photos/hidden & /api/assets/:id/hidden-ack', () => {
  let mongo: MongoClient | null = null;
  let db: Db | null = null;

  beforeEach(async () => {
    mongo = await tryConnect();
    if (!mongo) return;
    process.env.MAPLE_MONGO_URI = MONGO_URI;
    process.env.MAPLE_MONGO_DB = TEST_DB;
    await closeDb();
    db = mongo.db(TEST_DB);
    await db.dropDatabase();
    setLibraryRootsForTests(new Map([['111111111111111111111111', '/tmp/lib-1']]));
  });

  afterEach(async () => {
    if (db) await db.dropDatabase().catch(() => {});
    if (mongo) await mongo.close().catch(() => {});
    await closeDb();
    setLibraryRootsForTests(null);
    db = null;
    mongo = null;
  });

  function app() {
    return new Elysia().use(photosRoutes);
  }

  it('GET /api/photos/hidden returns list of hidden assets', async () => {
    if (!db) return;
    const assets = db.collection('assets');
    const assetId = new ObjectId();
    await assets.insertOne({
      _id: assetId,
      size: 100,
      mtime: Date.now(),
      rating: 0,
      flag: 0,
      color_label: '',
      indexed_at: new Date().toISOString(),
      fileinfo: [
        {
          library_id: new ObjectId('111111111111111111111111'),
          path: 'sub',
          filename: 'img.dng',
          deleted_at: null,
        },
      ],
      hidden: true,
      hidden_reason: 'manual',
    });

    const res = await app().handle(new Request('http://localhost/api/photos/hidden'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as any[];
    expect(body).toHaveLength(1);
    expect(body[0].id).toBe(assetId.toHexString());
    expect(body[0].hidden).toBe(true);
    expect(body[0].hidden_reason).toBe('manual');
  });

  it('GET /api/photos/hidden?onlyNew=true filters correctly', async () => {
    if (!db) return;
    const assets = db.collection('assets');

    // manual hide: not returned by onlyNew=true
    await assets.insertOne({
      _id: new ObjectId(),
      size: 100,
      mtime: Date.now(),
      rating: 0,
      flag: 0,
      color_label: '',
      indexed_at: new Date().toISOString(),
      fileinfo: [
        {
          library_id: new ObjectId('111111111111111111111111'),
          path: 'sub',
          filename: 'img1.dng',
          deleted_at: null,
        },
      ],
      hidden: true,
      hidden_reason: 'manual',
      hidden_ack: false,
    });

    // nudity hide, ack=true: not returned
    await assets.insertOne({
      _id: new ObjectId(),
      size: 100,
      mtime: Date.now(),
      rating: 0,
      flag: 0,
      color_label: '',
      indexed_at: new Date().toISOString(),
      fileinfo: [
        {
          library_id: new ObjectId('111111111111111111111111'),
          path: 'sub',
          filename: 'img2.dng',
          deleted_at: null,
        },
      ],
      hidden: true,
      hidden_reason: 'nudity',
      hidden_ack: true,
    });

    // nudity hide, ack=false: returned!
    const targetId = new ObjectId();
    await assets.insertOne({
      _id: targetId,
      size: 100,
      mtime: Date.now(),
      rating: 0,
      flag: 0,
      color_label: '',
      indexed_at: new Date().toISOString(),
      fileinfo: [
        {
          library_id: new ObjectId('111111111111111111111111'),
          path: 'sub',
          filename: 'img3.dng',
          deleted_at: null,
        },
      ],
      hidden: true,
      hidden_reason: 'nudity',
      hidden_ack: false,
    });

    const res = await app().handle(new Request('http://localhost/api/photos/hidden?onlyNew=true'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as any[];
    expect(body).toHaveLength(1);
    expect(body[0].id).toBe(targetId.toHexString());
  });

  it('POST /api/assets/:id/hidden-ack acknowledges the alert', async () => {
    if (!db) return;
    const assets = db.collection('assets');
    const targetId = new ObjectId();
    await assets.insertOne({
      _id: targetId,
      size: 100,
      mtime: Date.now(),
      rating: 0,
      flag: 0,
      color_label: '',
      indexed_at: new Date().toISOString(),
      fileinfo: [
        {
          library_id: new ObjectId('111111111111111111111111'),
          path: 'sub',
          filename: 'img3.dng',
          deleted_at: null,
        },
      ],
      hidden: true,
      hidden_reason: 'nudity',
      hidden_ack: false,
    });

    const res = await app().handle(
      new Request(`http://localhost/api/assets/${targetId.toHexString()}/hidden-ack`, {
        method: 'POST',
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.ok).toBe(true);

    const doc = await assets.findOne({ _id: targetId });
    expect(doc?.hidden_ack).toBe(true);
  });

  it('POST /api/assets/:id/hidden-ack does not touch a manually-hidden asset', async () => {
    if (!db) return;
    const assets = db.collection('assets');
    const targetId = new ObjectId();
    await assets.insertOne({
      _id: targetId,
      size: 100,
      mtime: Date.now(),
      rating: 0,
      flag: 0,
      color_label: '',
      indexed_at: new Date().toISOString(),
      fileinfo: [
        {
          library_id: new ObjectId('111111111111111111111111'),
          path: 'sub',
          filename: 'img4.dng',
          deleted_at: null,
        },
      ],
      hidden: true,
      hidden_reason: 'manual',
    });

    const res = await app().handle(
      new Request(`http://localhost/api/assets/${targetId.toHexString()}/hidden-ack`, {
        method: 'POST',
      }),
    );
    // hidden_ack is meaningless for a manual hide — the route scopes its
    // update to AI-driven hides only, so a manual hide's id resolves as
    // "not an AI-driven hide" rather than being silently stamped anyway.
    expect(res.status).toBe(404);

    const doc = await assets.findOne({ _id: targetId });
    expect(doc?.hidden_ack).toBeUndefined();
  });
});

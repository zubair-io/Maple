import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import { MongoClient, type Db } from 'mongodb';
import { closeDb } from '../db/client.ts';
import { displayRoutes } from './display.ts';

const MONGO_URI = process.env.MAPLE_MONGO_URI ?? 'mongodb://localhost:27017';
const TEST_DB = `maple_display_test_${process.pid}`;

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

describe('/api/display/config', () => {
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
  });

  afterEach(async () => {
    if (db) await db.dropDatabase().catch(() => {});
    if (mongo) await mongo.close().catch(() => {});
    await closeDb();
    db = null;
    mongo = null;
  });

  function app() {
    return new Elysia().use(displayRoutes);
  }

  it('GET /api/display/config returns defaults', async () => {
    if (!db) return;
    const res = await app().handle(new Request('http://localhost/api/display/config'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.show_hidden_images).toBe(false);
  });

  it('PUT /api/display/config updates config', async () => {
    if (!db) return;
    const res1 = await app().handle(
      new Request('http://localhost/api/display/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ show_hidden_images: true }),
      }),
    );
    expect(res1.status).toBe(200);

    const res2 = await app().handle(new Request('http://localhost/api/display/config'));
    expect(res2.status).toBe(200);
    const body = (await res2.json()) as any;
    expect(body.show_hidden_images).toBe(true);
  });
});

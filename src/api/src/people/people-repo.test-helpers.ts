/**
 * Shared Mongo harness for `people.repo.test.ts` and
 * `people-merge.repo.test.ts`. Exports the lifecycle setup function and
 * test utilities so each test file can stay under the 600-LOC budget gate
 * without duplicating boilerplate.
 */

import { beforeAll, beforeEach, afterAll } from 'bun:test';
import { ObjectId, type Db, type MongoClient } from 'mongodb';
import { tryConnectTestMongo, withTestDb } from '../db/test-db.test-helpers.ts';
import type { AssetDoc, AssetFaceDoc } from '../db/schema.ts';

export function makeEmbedding(dim: number, seed: number): number[] {
  const out: number[] = new Array(dim);
  for (let i = 0; i < dim; i += 1) {
    out[i] = Math.sin((i + 1) * seed) * 0.5 + Math.cos((i * 3 + seed) * 0.7) * 0.5;
  }
  return out;
}

/**
 * Register bun:test lifecycle hooks for a Mongo-backed test suite and return
 * a handle that resolves to `{ db, mongoReachable, insertAssetWithFaces }`.
 *
 * Usage:
 *   const h = setupMongoHarness('my_test_db_suffix');
 *   it('...', async () => { if (!h.mongoReachable) return; ... });
 */
export function setupMongoHarness(testDb: string): {
  get mongoReachable(): boolean;
  get db(): Db;
  insertAssetWithFaces(faces: AssetFaceDoc[]): Promise<ObjectId>;
} {
  let mongo: MongoClient | null = null;
  let mongoReachable = false;
  let db: Db | null = null;

  // First, so `getDb()` inside the setup below already sees `testDb`.
  withTestDb(testDb);

  beforeAll(async () => {
    mongo = await tryConnectTestMongo();
    mongoReachable = mongo !== null;
    if (!mongoReachable) {
      console.log(`[${testDb}] skipping: MongoDB unreachable`);
      return;
    }
    db = mongo!.db(testDb);
    await db.dropDatabase();
    for (const name of ['users', 'credentials', 'invites', 'refresh_tokens', 'challenges']) {
      await db.createCollection(name).catch(() => undefined);
    }
    const { closeDb, ensureIndexes } = await import('../db/client.ts');
    await closeDb();
    await ensureIndexes();
  });

  beforeEach(async () => {
    if (!mongoReachable) return;
    await db!.collection('people').deleteMany({});
    await db!.collection('assets').deleteMany({});
  });

  afterAll(async () => {
    if (mongo) {
      await mongo.db(testDb).dropDatabase();
      await mongo.close();
    }
    const { closeDb } = await import('../db/client.ts');
    await closeDb();
  });

  async function insertAssetWithFaces(faces: AssetFaceDoc[]): Promise<ObjectId> {
    const libraryId = new ObjectId();
    const libraryRoot = `/tmp/maple-test/${libraryId.toHexString()}`;
    const filename = `${Math.random().toString(36).slice(2, 8)}.jpg`;
    await db!.collection('folders').insertOne({
      _id: libraryId,
      path: libraryRoot,
      label: 'people-test',
      last_scan: null,
      file_count: 0,
      created_at: new Date().toISOString(),
    } as never);
    const { invalidateLibraryRoots } = await import('../indexer/libraries.cache.ts');
    invalidateLibraryRoots();
    const doc: AssetDoc = {
      fileinfo: [{ path: '', filename, library_id: libraryId, deleted_at: null }],
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

  return {
    get mongoReachable() {
      return mongoReachable;
    },
    get db() {
      if (!db) throw new Error('db not yet initialised');
      return db;
    },
    insertAssetWithFaces,
  };
}

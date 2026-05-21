/**
 * Tests the process-wide library-roots cache used by every code path that
 * resolves `fileinfo[]` entries to an absolute on-disk location.
 *
 * Follows the per-process isolated-DB + skip-if-Mongo-unreachable pattern
 * from `client.test.ts` so:
 *   - running locally against `mongodb://localhost:27017` does NOT wipe real
 *     folder rows in the developer's `maple` database;
 *   - CI environments without Mongo skip the suite instead of failing.
 */
import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { MongoClient, ObjectId, type Db } from 'mongodb';

const TEST_DB = `maple_test_libraries_cache_${process.pid}`;
process.env.MAPLE_MONGO_DB = TEST_DB;
const MONGO_URI = process.env.MAPLE_MONGO_URI ?? 'mongodb://localhost:27017';

let mongo: MongoClient | null = null;
let mongoReachable = false;
let db: Db | null = null;

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
    } catch {
      /* ignore */
    }
    return null;
  }
}

beforeAll(async () => {
  mongo = await tryConnect();
  mongoReachable = mongo !== null;
  if (!mongoReachable) {
    console.log('[libraries.cache.test] skipping: MongoDB unreachable');
    return;
  }
  db = mongo!.db(TEST_DB);
  await db.dropDatabase();
  // Reset any singleton state inside the production client module that may
  // hold a connection to the default DB from a prior test.
  const { closeDb } = await import('../db/client.ts');
  await closeDb();
});

beforeEach(async () => {
  if (!mongoReachable) return;
  await db!.collection('folders').deleteMany({});
  // Reset the process-local cache so each test sees fresh state.
  const { invalidateLibraryRoots } = await import('./libraries.cache.ts');
  invalidateLibraryRoots();
});

afterAll(async () => {
  if (mongo) {
    try {
      await mongo.db(TEST_DB).dropDatabase();
    } catch {
      /* ignore */
    }
    try {
      await mongo.close();
    } catch {
      /* ignore */
    }
  }
  const { closeDb } = await import('../db/client.ts');
  await closeDb();
});

describe('loadLibraryRoots', () => {
  test('returns a map keyed by hex _id', async () => {
    if (!mongoReachable) return;
    const { loadLibraryRoots } = await import('./libraries.cache.ts');
    const { foldersCollection } = await import('../db/client.ts');
    const f = await foldersCollection();
    const id = new ObjectId();
    await f.insertOne({
      _id: id,
      path: '/srv/lib-a',
      label: 'A',
      last_scan: null,
      file_count: 0,
      created_at: '2026-05-20T00:00:00Z',
    });
    const roots = await loadLibraryRoots();
    expect(roots.get(id.toHexString())).toBe('/srv/lib-a');
  });

  test('returns the same map on a second call without refetching', async () => {
    if (!mongoReachable) return;
    const { loadLibraryRoots } = await import('./libraries.cache.ts');
    const { foldersCollection } = await import('../db/client.ts');
    const f = await foldersCollection();
    const id = new ObjectId();
    await f.insertOne({
      _id: id,
      path: '/x',
      label: 'X',
      last_scan: null,
      file_count: 0,
      created_at: 'now',
    });
    const first = await loadLibraryRoots();
    // Wipe behind the cache; the cached map should still be returned.
    await f.deleteMany({});
    const second = await loadLibraryRoots();
    expect(second).toBe(first);
    expect(second.size).toBe(1);
  });

  test('invalidate forces a re-read', async () => {
    if (!mongoReachable) return;
    const { loadLibraryRoots, invalidateLibraryRoots } = await import(
      './libraries.cache.ts'
    );
    const { foldersCollection } = await import('../db/client.ts');
    const f = await foldersCollection();
    await f.insertOne({
      _id: new ObjectId(),
      path: '/x',
      label: 'X',
      last_scan: null,
      file_count: 0,
      created_at: 'now',
    });
    const first = await loadLibraryRoots();
    expect(first.size).toBe(1);
    invalidateLibraryRoots();
    await f.deleteMany({});
    const second = await loadLibraryRoots();
    expect(second.size).toBe(0);
  });
});

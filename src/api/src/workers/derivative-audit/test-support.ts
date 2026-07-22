/**
 * Shared Mongo harness for the derivative-audit tests (config repo + scan +
 * route). Mirrors `cloudflare-config.repo.test.ts` / `people-repo.test-helpers.ts`:
 * connect to `MAPLE_MONGO_URI` (default localhost), point the code-under-test's
 * `getDb()` at a per-suite database via env override, and skip-pass gracefully
 * when Mongo is unreachable. Not a `*.test.ts` file, so bun never runs it as a
 * suite; it only registers lifecycle hooks when `setupAuditMongo` is called.
 */

import { beforeAll, beforeEach, afterAll } from 'bun:test';
import { ObjectId, type Db, type MongoClient } from 'mongodb';
// Reuse the shared workers-domain reach-test + connect ritual rather than
// re-rolling it (keeps the clone detector + unused-export gate happy).
import { MONGO_URI, tryConnect } from '../discover/_test-helpers.ts';

export interface AuditMongo {
  readonly mongoReachable: boolean;
  readonly db: Db;
  /** Insert a library folder doc (so `loadLibraryRoots`/`loadLibraryIdToSlug`
   * resolve it) and reset the library-roots cache. Returns the library id. */
  addLibrary(root: string, slug?: string): Promise<ObjectId>;
}

export function setupAuditMongo(testDb: string): AuditMongo {
  let mongo: MongoClient | null = null;
  let reachable = false;
  let db: Db | null = null;
  const ORIGINAL_DB = process.env.MAPLE_MONGO_DB;
  const ORIGINAL_URI = process.env.MAPLE_MONGO_URI;

  const pointEnv = () => {
    process.env.MAPLE_MONGO_URI = MONGO_URI;
    process.env.MAPLE_MONGO_DB = testDb;
  };

  beforeAll(async () => {
    mongo = await tryConnect();
    reachable = mongo !== null;
    if (!reachable) {
      console.log(`[${testDb}] skipping: MongoDB unreachable`);
      return;
    }
    pointEnv();
    db = mongo!.db(testDb);
    await db.dropDatabase();
    const { closeDb } = await import('../../db/client.ts');
    await closeDb();
  });

  beforeEach(async () => {
    if (!reachable || !db) return;
    // Re-assert env in case a neighbouring suite mutated it, then reset state.
    pointEnv();
    const { closeDb } = await import('../../db/client.ts');
    await closeDb();
    await db.collection('assets').deleteMany({});
    await db.collection('app_settings').deleteMany({});
    await db.collection('folders').deleteMany({});
    const { invalidateLibraryRoots } = await import('../../indexer/libraries.cache.ts');
    invalidateLibraryRoots();
  });

  afterAll(async () => {
    if (mongo && db) {
      await db.dropDatabase();
      await mongo.close();
    }
    if (ORIGINAL_DB === undefined) delete process.env.MAPLE_MONGO_DB;
    else process.env.MAPLE_MONGO_DB = ORIGINAL_DB;
    if (ORIGINAL_URI === undefined) delete process.env.MAPLE_MONGO_URI;
    else process.env.MAPLE_MONGO_URI = ORIGINAL_URI;
    const { closeDb } = await import('../../db/client.ts');
    await closeDb();
  });

  async function addLibrary(root: string, slug?: string): Promise<ObjectId> {
    if (!db) throw new Error('db not ready');
    const id = new ObjectId();
    await db.collection('folders').insertOne({
      _id: id,
      path: root,
      slug: slug ?? root.split('/').pop() ?? 'lib',
      label: 'audit-test',
      last_scan: null,
      file_count: 0,
      created_at: new Date().toISOString(),
    } as never);
    const { invalidateLibraryRoots } = await import('../../indexer/libraries.cache.ts');
    invalidateLibraryRoots();
    return id;
  }

  return {
    get mongoReachable() {
      return reachable;
    },
    get db() {
      if (!db) throw new Error('db not ready');
      return db;
    },
    addLibrary,
  };
}

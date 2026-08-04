/**
 * cache-gc delete propagation to the mirror (#926).
 *
 * Once the `.maple/` cache replicates, reclaiming an orphan on the primary must
 * reclaim it on the mirror too — otherwise the backup accumulates dead files
 * forever. cache-gc gets that for free by unlinking through `fs/mirrored.ts`;
 * this asserts it end-to-end against a real sweep, and asserts the converse:
 * a LIVE cache entry is left alone on both sides.
 *
 * Integration test against a real Mongo; skip-passes when unreachable, matching
 * `cache-gc.test.ts`.
 */

import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { mkdtemp, mkdir, writeFile, rm, stat, utimes } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { MongoClient, ObjectId, type Db } from 'mongodb';

const TEST_DB = `maple_test_cache_gc_mirror_${process.pid}`;
process.env.MAPLE_MONGO_DB = TEST_DB;
const MONGO_URI = process.env.MAPLE_MONGO_URI ?? 'mongodb://localhost:27017';

let mongo: MongoClient | null = null;
let mongoReachable = false;
let db: Db | null = null;

async function tryConnect(): Promise<MongoClient | null> {
  const c = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 1500, connectTimeoutMS: 1500 });
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
    console.log('[cache-gc.mirror.test] skipping: MongoDB unreachable');
    return;
  }
  db = mongo!.db(TEST_DB);
  await db.dropDatabase();
  process.env.MAPLE_MONGO_DB = TEST_DB;
  const { closeDb } = await import('../db/client.ts');
  await closeDb();
});

beforeEach(async () => {
  if (!mongoReachable || !db) return;
  await db.collection('assets').deleteMany({});
  await db.collection('folders').deleteMany({});
  const { clearMirrorRoots } = await import('../fs/mirror-registry.ts');
  clearMirrorRoots();
});

afterAll(async () => {
  const { clearMirrorRoots } = await import('../fs/mirror-registry.ts');
  clearMirrorRoots();
  if (mongo) {
    try {
      await mongo.db(TEST_DB).dropDatabase();
    } catch {
      /* ignore */
    }
    await mongo.close();
  }
  const { closeDb } = await import('../db/client.ts');
  await closeDb();
});

/** Register `root` as a library so the sweep can resolve a library id (without
 * one it scans but never deletes). */
async function registerLibrary(root: string): Promise<ObjectId> {
  const libraryId = new ObjectId();
  await db!.collection('folders').insertOne({
    _id: libraryId,
    path: root,
    label: 'cache-gc-mirror-test',
    last_scan: null,
    file_count: 0,
    created_at: new Date().toISOString(),
  } as never);
  const { invalidateLibraryRoots } = await import('../indexer/libraries.cache.ts');
  invalidateLibraryRoots();
  return libraryId;
}

async function insertLiveAsset(libraryId: ObjectId, filename: string): Promise<void> {
  await db!.collection('assets').insertOne({
    _id: new ObjectId(),
    fileinfo: [
      { library_id: libraryId, path: '', filename, deleted_at: null, missing_since: null },
    ],
  } as never);
}

/** Age past the sweep's 60s recency-skip window. */
async function writeAged(p: string, bytes: string): Promise<void> {
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(p, bytes);
  const past = new Date(Date.now() - 5 * 60 * 1000);
  await utimes(p, past, past);
}

describe('cache-gc → mirror', () => {
  test('an orphan reclaimed on the primary is reclaimed on the mirror', async () => {
    if (!mongoReachable) return;
    const dir = await mkdtemp(path.join(os.tmpdir(), 'cache-gc-mirror-'));
    const primary = path.join(dir, 'primary');
    const mirror = path.join(dir, 'mirror');
    await mkdir(primary, { recursive: true });
    await mkdir(mirror, { recursive: true });

    try {
      const libraryId = await registerLibrary(primary);
      await insertLiveAsset(libraryId, 'live.dng');

      const { sha256Prefix16 } = await import('../fs/xmp.ts');
      const liveRel = path.join('.maple', 'thumbs', `${sha256Prefix16('live.dng')}.avif`);
      const orphanRel = path.join('.maple', 'thumbs', `${'0'.repeat(16)}.avif`);

      for (const rel of [liveRel, orphanRel]) {
        await writeAged(path.join(primary, rel), 'avif-bytes');
        await writeAged(path.join(mirror, rel), 'avif-bytes');
      }

      const { setMirrorRoots } = await import('../fs/mirror-registry.ts');
      setMirrorRoots({ [primary]: [mirror] });

      const { sweepOrphanedCaches } = await import('./cache-gc.ts');
      const result = await sweepOrphanedCaches(primary);
      const { flushPendingMirrorOps } = await import('../fs/mirrored.ts');
      await flushPendingMirrorOps();

      expect(result.deleted).toBe(1);
      // Orphan gone on BOTH sides — the mirror doesn't accumulate dead files.
      await expect(stat(path.join(primary, orphanRel))).rejects.toThrow();
      await expect(stat(path.join(mirror, orphanRel))).rejects.toThrow();
      // The live entry survives on both sides — a delete-propagation bug that
      // over-reached would show up right here.
      expect((await stat(path.join(primary, liveRel))).size).toBeGreaterThan(0);
      expect((await stat(path.join(mirror, liveRel))).size).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

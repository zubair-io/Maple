/**
 * Tests for `sweepOrphanedCaches`. Per-process isolated DB + skip-if-Mongo-
 * unreachable, mirroring `libraries.cache.test.ts`.
 */
import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { mkdtemp, mkdir, writeFile, rm, stat } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { MongoClient, ObjectId, type Db } from 'mongodb';

const TEST_DB = `maple_test_cache_gc_${process.pid}`;
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
    console.log('[cache-gc.test] skipping: MongoDB unreachable');
    return;
  }
  db = mongo!.db(TEST_DB);
  await db.dropDatabase();
  const { closeDb } = await import('../db/client.ts');
  await closeDb();
});

beforeEach(async () => {
  if (!mongoReachable) return;
  await db!.collection('assets').deleteMany({});
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

const KNOWN_ID = 'a'.repeat(32);
const OTHER_ID = 'b'.repeat(32);
const LEGACY_KEY = '0123456789abcdef'; // sha256_prefix16 — 16 hex

async function mkTree(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cache-gc-'));
  return root;
}

async function writeJpg(p: string): Promise<void> {
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(p, Buffer.from([0xff, 0xd8, 0xff, 0xd9])); // tiny JPEG-ish bytes
}

describe('sweepOrphanedCaches', () => {
  test('unlinks legacy sha256_prefix16-keyed thumb and keeps known maple_id-keyed thumb', async () => {
    if (!mongoReachable) return;
    const { sweepOrphanedCaches } = await import('./cache-gc.ts');
    const root = await mkTree();
    try {
      const knownThumb = path.join(root, '.maple', 'thumbs', `${KNOWN_ID}.jpg`);
      const legacyThumb = path.join(root, '.maple', 'thumbs', `${LEGACY_KEY}.jpg`);
      await writeJpg(knownThumb);
      await writeJpg(legacyThumb);

      await db!
        .collection('assets')
        .insertOne({ _id: new ObjectId(), maple_id: KNOWN_ID } as never);

      const result = await sweepOrphanedCaches(root);
      expect(result).toEqual({ scanned: 2, deleted: 1 });

      // Known file remains.
      const s = await stat(knownThumb);
      expect(s.size).toBeGreaterThan(0);
      // Legacy file gone.
      await expect(stat(legacyThumb)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('unlinks preview for an unknown maple_id (size suffix variant)', async () => {
    if (!mongoReachable) return;
    const { sweepOrphanedCaches } = await import('./cache-gc.ts');
    const root = await mkTree();
    try {
      const orphan = path.join(root, '.maple', 'previews', `${OTHER_ID}_1280.jpg`);
      await writeJpg(orphan);

      // No assets in the collection — every cache file is orphaned.
      const result = await sweepOrphanedCaches(root);
      expect(result).toEqual({ scanned: 1, deleted: 1 });

      await expect(stat(orphan)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('keeps a preview whose maple_id matches a live asset (with size suffix)', async () => {
    if (!mongoReachable) return;
    const { sweepOrphanedCaches } = await import('./cache-gc.ts');
    const root = await mkTree();
    try {
      const keep = path.join(root, '.maple', 'previews', `${KNOWN_ID}_full.jpg`);
      await writeJpg(keep);

      await db!
        .collection('assets')
        .insertOne({ _id: new ObjectId(), maple_id: KNOWN_ID } as never);

      const result = await sweepOrphanedCaches(root);
      expect(result).toEqual({ scanned: 1, deleted: 0 });

      const s = await stat(keep);
      expect(s.size).toBeGreaterThan(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('library with no .maple/ directories → { scanned: 0, deleted: 0 }', async () => {
    if (!mongoReachable) return;
    const { sweepOrphanedCaches } = await import('./cache-gc.ts');
    const root = await mkTree();
    try {
      // Put a normal photo at the root and a sub-folder, but no .maple.
      await writeJpg(path.join(root, 'photo.jpg'));
      await writeJpg(path.join(root, 'sub', 'photo2.jpg'));

      const result = await sweepOrphanedCaches(root);
      expect(result).toEqual({ scanned: 0, deleted: 0 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('descends into sub-folders to find nested .maple/ caches', async () => {
    if (!mongoReachable) return;
    const { sweepOrphanedCaches } = await import('./cache-gc.ts');
    const root = await mkTree();
    try {
      const nested = path.join(root, 'vacation', '2024', '.maple', 'thumbs', `${LEGACY_KEY}.jpg`);
      await writeJpg(nested);

      const result = await sweepOrphanedCaches(root);
      expect(result.scanned).toBe(1);
      expect(result.deleted).toBe(1);
      await expect(stat(nested)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

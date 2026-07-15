/**
 * Regression tests for `sweepOrphanedCaches`' recognition of the pano
 * stitcher's pre-seed derivative scheme. Split out of `cache-gc.test.ts` to
 * stay under the file-size budget; has its own throwaway Mongo DB so it can
 * run standalone or alongside the main suite without name collisions.
 *
 * The pano stitcher pre-seeds a thumb + preview keyed by
 * `sha256_prefix16(basename)` immediately after stitching, before the pano
 * is indexed and gets a maple_id (maple-pano/src/stitch/io.rs
 * write_display_sidecars, #1365) — Apple's synchronous MapleSidecarPaths
 * resolver mirrors this exact scheme on the read side. This is NOT the same
 * as the always-orphaned pre-migration legacy thumb key: it's legitimate iff
 * a live filename in this exact directory hashes to it.
 */
import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { mkdtemp, mkdir, writeFile, rm, stat, utimes } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { MongoClient, ObjectId, type Db } from 'mongodb';
import { sha256Prefix16 } from '../fs/xmp.ts';

const TEST_DB = `maple_test_cache_gc_preseed_${process.pid}`;
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
    console.log('[cache-gc.pano-preseed.test] skipping: MongoDB unreachable');
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

async function mkTree(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cache-gc-preseed-'));
  return root;
}

/** Register `root` as a library and bust the app's own in-memory
 * `loadLibraryRoots()` cache so it picks up the fresh insert. */
async function registerLibrary(root: string): Promise<ObjectId> {
  const libraryId = new ObjectId();
  await db!.collection('folders').insertOne({
    _id: libraryId,
    path: root,
    label: 'cache-gc-preseed-test',
    last_scan: null,
    file_count: 0,
    created_at: new Date().toISOString(),
  } as never);
  const { invalidateLibraryRoots } = await import('../indexer/libraries.cache.ts');
  invalidateLibraryRoots();
  return libraryId;
}

/** Insert a live (non-tombstoned) asset row for one `fileinfo` location. */
async function insertLiveAsset(libraryId: ObjectId, relPath: string, filename: string) {
  await db!.collection('assets').insertOne({
    _id: new ObjectId(),
    fileinfo: [
      {
        library_id: libraryId,
        path: relPath,
        filename,
        deleted_at: null,
        missing_since: null,
      },
    ],
  } as never);
}

async function writeJpg(p: string): Promise<void> {
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(p, Buffer.from([0xff, 0xd8, 0xff, 0xd9])); // tiny JPEG-ish bytes
}

async function writeAvif(p: string): Promise<void> {
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(p, Buffer.from([0x00, 0x00, 0x00, 0x1c])); // tiny AVIF-ish bytes
}

/**
 * Age `p` past the recency-skip window so the sweep will consider it for
 * deletion. The sweep skips files whose mtime is within 60s of `Date.now()`
 * (TOCTOU defense). Tests that want a file to be eligible for unlink must
 * call this. 5 minutes back is generous and stable across slow CI clocks.
 */
async function agePast(p: string): Promise<void> {
  const past = new Date(Date.now() - 5 * 60 * 1000);
  await utimes(p, past, past);
}

describe('sweepOrphanedCaches — pano pre-seed derivatives', () => {
  test('keeps a pano pre-seed thumb (sha256_prefix16-keyed) matching a live filename', async () => {
    if (!mongoReachable) return;
    const { sweepOrphanedCaches } = await import('./cache-gc.ts');
    const root = await mkTree();
    try {
      const libraryId = await registerLibrary(root);
      await insertLiveAsset(libraryId, '', 'panorama-test.png');
      const preSeedKey = sha256Prefix16('panorama-test.png');
      const preSeedThumb = path.join(root, '.maple', 'thumbs', `${preSeedKey}.avif`);
      await writeAvif(preSeedThumb);
      await agePast(preSeedThumb);

      const result = await sweepOrphanedCaches(root);
      expect(result.deleted).toBe(0);

      const s = await stat(preSeedThumb);
      expect(s.size).toBeGreaterThan(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('does not delete a pano pre-seed thumb when the library cannot be resolved (safe degradation)', async () => {
    if (!mongoReachable) return;
    const { sweepOrphanedCaches } = await import('./cache-gc.ts');
    const root = await mkTree();
    try {
      // Deliberately NOT registered — `resolveLibraryId` returns null, so
      // no known-live set can be built. Mirrors the previews-side
      // "safe degradation" test — a transient/failed library lookup must
      // never mass-delete a pano's pre-seed thumb either (jules review,
      // PR #2008 round 2).
      const preSeedKey = sha256Prefix16('panorama-test.png');
      const preSeedThumb = path.join(root, '.maple', 'thumbs', `${preSeedKey}.avif`);
      await writeAvif(preSeedThumb);
      await agePast(preSeedThumb);

      const result = await sweepOrphanedCaches(root);
      expect(result.deleted).toBe(0);

      const s = await stat(preSeedThumb);
      expect(s.size).toBeGreaterThan(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('unlinks a pano pre-seed thumb (sha256_prefix16-keyed) matching NO live filename', async () => {
    if (!mongoReachable) return;
    const { sweepOrphanedCaches } = await import('./cache-gc.ts');
    const root = await mkTree();
    try {
      await registerLibrary(root);
      const preSeedKey = sha256Prefix16('never-indexed.png');
      const preSeedThumb = path.join(root, '.maple', 'thumbs', `${preSeedKey}.avif`);
      await writeAvif(preSeedThumb);
      await agePast(preSeedThumb);

      const result = await sweepOrphanedCaches(root);
      expect(result.deleted).toBe(1);

      await expect(stat(preSeedThumb)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // Same pattern for the preview tier — `<sha256_prefix16(basename)>_1600.jpg`.
  test('keeps a pano pre-seed preview (sha256_prefix16-keyed) matching a live filename', async () => {
    if (!mongoReachable) return;
    const { sweepOrphanedCaches } = await import('./cache-gc.ts');
    const root = await mkTree();
    try {
      const libraryId = await registerLibrary(root);
      await insertLiveAsset(libraryId, '', 'panorama-test.png');
      const preSeedKey = sha256Prefix16('panorama-test.png');
      const preSeedPreview = path.join(root, '.maple', 'previews', `${preSeedKey}_1600.jpg`);
      await writeJpg(preSeedPreview);
      await agePast(preSeedPreview);

      const result = await sweepOrphanedCaches(root);
      expect(result.deleted).toBe(0);

      const s = await stat(preSeedPreview);
      expect(s.size).toBeGreaterThan(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('unlinks a pano pre-seed preview (sha256_prefix16-keyed) matching NO live filename', async () => {
    if (!mongoReachable) return;
    const { sweepOrphanedCaches } = await import('./cache-gc.ts');
    const root = await mkTree();
    try {
      await registerLibrary(root);
      const preSeedKey = sha256Prefix16('never-indexed.png');
      const preSeedPreview = path.join(root, '.maple', 'previews', `${preSeedKey}_1600.jpg`);
      await writeJpg(preSeedPreview);
      await agePast(preSeedPreview);

      const result = await sweepOrphanedCaches(root);
      expect(result.deleted).toBe(1);

      await expect(stat(preSeedPreview)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

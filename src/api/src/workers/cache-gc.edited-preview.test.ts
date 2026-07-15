/**
 * Regression tests for `sweepOrphanedCaches`' recognition of Apple's
 * local-only edited/developed-render preview scheme (#2009). Split out of
 * `cache-gc.test.ts` to stay under the file-size budget; has its own
 * throwaway Mongo DB so it can run standalone or alongside the main suite
 * without name collisions — mirrors the pano pre-seed split
 * (`cache-gc.pano-preseed.test.ts`, folded back into `cache-gc.test.ts` by
 * #2008's follow-ups; recreated here as its own file since the combined
 * file is what tipped over budget).
 *
 * `ThumbnailLoader.updateDisplayPreviewFromRender` (Apple) writes
 * `<sha256_prefix16(basename)>_1600.edited.jpg` next to the canonical,
 * shared `<sha256_prefix16(basename)>_1600.jpg` camera-original preview —
 * deliberately NOT the same file (an earlier design draft that shared the
 * file was a confirmed correctness-and-privacy bug: edited pixels reaching
 * the server's describe/OCR VLM pipeline). This is legitimate iff a live
 * filename in this exact directory hashes to the captured key, the same
 * "verify against a live asset" carve-out as the pano pre-seed scheme.
 */
import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { mkdtemp, mkdir, writeFile, rm, stat, utimes } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { MongoClient, ObjectId, type Db } from 'mongodb';
import { sha256Prefix16 } from '../fs/xmp.ts';

const TEST_DB = `maple_test_cache_gc_edited_preview_${process.pid}`;
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
    console.log('[cache-gc.edited-preview.test] skipping: MongoDB unreachable');
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
  const root = await mkdtemp(path.join(os.tmpdir(), 'cache-gc-edited-preview-'));
  return root;
}

/** Register `root` as a library and bust the app's own in-memory
 * `loadLibraryRoots()` cache so it picks up the fresh insert. */
async function registerLibrary(root: string): Promise<ObjectId> {
  const libraryId = new ObjectId();
  await db!.collection('folders').insertOne({
    _id: libraryId,
    path: root,
    label: 'cache-gc-edited-preview-test',
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

async function writeMarker(p: string): Promise<void> {
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(p, '1721000000.000000'); // plain-text epoch, like the real markers
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

describe('sweepOrphanedCaches — edited/developed-preview derivatives (#2009)', () => {
  test('keeps an edited-preview (_1600.edited.jpg) whose hash matches a live fileinfo entry', async () => {
    if (!mongoReachable) return;
    const { sweepOrphanedCaches } = await import('./cache-gc.ts');
    const root = await mkTree();
    try {
      const libraryId = await registerLibrary(root);
      await insertLiveAsset(libraryId, '', 'a.dng');
      const keep = path.join(
        root,
        '.maple',
        'previews',
        `${sha256Prefix16('a.dng')}_1600.edited.jpg`,
      );
      await writeJpg(keep);
      await agePast(keep);

      const result = await sweepOrphanedCaches(root);
      expect(result).toEqual({ scanned: 1, deleted: 0, skipped_recent: 0 });

      const s = await stat(keep);
      expect(s.size).toBeGreaterThan(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('unlinks an orphaned edited-preview (_1600.edited.jpg) whose hash matches no live filename', async () => {
    if (!mongoReachable) return;
    const { sweepOrphanedCaches } = await import('./cache-gc.ts');
    const root = await mkTree();
    try {
      await registerLibrary(root);
      const orphan = path.join(
        root,
        '.maple',
        'previews',
        `${sha256Prefix16('gone.dng')}_1600.edited.jpg`,
      );
      await writeJpg(orphan);
      await agePast(orphan);

      // No live asset hashes to `sha256Prefix16('gone.dng')` — orphaned.
      const result = await sweepOrphanedCaches(root);
      expect(result).toEqual({ scanned: 1, deleted: 1, skipped_recent: 0 });

      await expect(stat(orphan)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('does not delete an edited-preview when the library cannot be resolved (safe degradation)', async () => {
    if (!mongoReachable) return;
    const { sweepOrphanedCaches } = await import('./cache-gc.ts');
    const root = await mkTree();
    try {
      // Deliberately NOT registered — `resolveLibraryId` returns null, so no
      // known-live set can be built. A transient/failed library lookup must
      // never mass-delete a legitimate edited-preview file either (mirrors
      // the pano pre-seed scheme's same safe-degradation guarantee).
      const wouldBeOrphan = path.join(
        root,
        '.maple',
        'previews',
        `${sha256Prefix16('a.dng')}_1600.edited.jpg`,
      );
      await writeJpg(wouldBeOrphan);
      await agePast(wouldBeOrphan);

      const result = await sweepOrphanedCaches(root);
      expect(result).toEqual({ scanned: 1, deleted: 0, skipped_recent: 0 });

      const s = await stat(wouldBeOrphan);
      expect(s.size).toBeGreaterThan(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // Jules review (PR #2013): `.v` was missing from `PREVIEW_EXTS`, so BOTH
  // marker siblings (`_1600.v` and `_1600.edited.v`) were silently invisible
  // to the sweep — never recognized as live, and never cleaned up as orphans
  // either. These four tests cover the fix.

  test('keeps a live edited-preview marker (_1600.edited.v) whose hash matches a live fileinfo entry', async () => {
    if (!mongoReachable) return;
    const { sweepOrphanedCaches } = await import('./cache-gc.ts');
    const root = await mkTree();
    try {
      const libraryId = await registerLibrary(root);
      await insertLiveAsset(libraryId, '', 'a.dng');
      const keep = path.join(
        root,
        '.maple',
        'previews',
        `${sha256Prefix16('a.dng')}_1600.edited.v`,
      );
      await writeMarker(keep);
      await agePast(keep);

      const result = await sweepOrphanedCaches(root);
      expect(result).toEqual({ scanned: 1, deleted: 0, skipped_recent: 0 });

      const s = await stat(keep);
      expect(s.size).toBeGreaterThan(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('unlinks an orphaned edited-preview marker (_1600.edited.v) whose hash matches no live filename', async () => {
    if (!mongoReachable) return;
    const { sweepOrphanedCaches } = await import('./cache-gc.ts');
    const root = await mkTree();
    try {
      await registerLibrary(root);
      const orphan = path.join(
        root,
        '.maple',
        'previews',
        `${sha256Prefix16('gone.dng')}_1600.edited.v`,
      );
      await writeMarker(orphan);
      await agePast(orphan);

      const result = await sweepOrphanedCaches(root);
      expect(result).toEqual({ scanned: 1, deleted: 1, skipped_recent: 0 });

      await expect(stat(orphan)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('keeps a live canonical-tier marker (_1600.v) whose hash matches a live fileinfo entry', async () => {
    if (!mongoReachable) return;
    const { sweepOrphanedCaches } = await import('./cache-gc.ts');
    const root = await mkTree();
    try {
      const libraryId = await registerLibrary(root);
      await insertLiveAsset(libraryId, '', 'a.dng');
      const keep = path.join(root, '.maple', 'previews', `${sha256Prefix16('a.dng')}_1600.v`);
      await writeMarker(keep);
      await agePast(keep);

      const result = await sweepOrphanedCaches(root);
      expect(result).toEqual({ scanned: 1, deleted: 0, skipped_recent: 0 });

      const s = await stat(keep);
      expect(s.size).toBeGreaterThan(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('unlinks an orphaned canonical-tier marker (_1600.v) whose hash matches no live filename', async () => {
    if (!mongoReachable) return;
    const { sweepOrphanedCaches } = await import('./cache-gc.ts');
    const root = await mkTree();
    try {
      await registerLibrary(root);
      const orphan = path.join(root, '.maple', 'previews', `${sha256Prefix16('gone.dng')}_1600.v`);
      await writeMarker(orphan);
      await agePast(orphan);

      const result = await sweepOrphanedCaches(root);
      expect(result).toEqual({ scanned: 1, deleted: 1, skipped_recent: 0 });

      await expect(stat(orphan)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

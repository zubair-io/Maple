/**
 * Regression tests for `sweepOrphanedCaches`' handling of the LEGACY thumb
 * freshness sidecar (`<key>.avif.meta`). The `.meta` protocol that wrote
 * these (`thumbs/thumb-meta.ts`) was removed in #2258 — nothing writes them
 * any more — but #2252 shipped and ran in production first, so every
 * install that has been running since has one `.meta` file per thumbnail
 * already on disk. This suite covers draining that pre-existing state, not
 * any current write path. Split out of `cache-gc.test.ts` to stay under the
 * file-size budget, mirroring `cache-gc.pano-preseed.test.ts`; has its own
 * throwaway Mongo DB so it can run standalone or alongside the main suite
 * without name collisions.
 *
 * Sidecars are deliberately NOT swept as entries in their own right: the suffix
 * is appended to the whole artefact filename, so `path.extname('<key>.avif.meta')`
 * is `.meta` and the stem is `<key>.avif`, which matches no live-key shape —
 * putting `.meta` in `THUMB_EXTS` would condemn the sidecars of perfectly live
 * thumbs. They are instead reaped alongside their artefact, plus a dedicated
 * stranded-sidecar pass for ones orphaned out of band. Neither path counts toward
 * `scanned`/`deleted`, so the counters still reconcile against artefacts.
 */
import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { mkdtemp, mkdir, writeFile, rm, stat, utimes } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { MongoClient, ObjectId, type Db } from 'mongodb';
import { sha256Prefix16 } from '../fs/xmp.ts';

const TEST_DB = `maple_test_cache_gc_sidecars_${process.pid}`;
process.env.MAPLE_MONGO_DB = TEST_DB;
const MONGO_URI = process.env.MAPLE_MONGO_URI ?? 'mongodb://localhost:27017';

/** A 16-hex stem that hashes no live filename — a genuine orphan. */
const DEAD_KEY = '0123456789abcdef'; // gitleaks:allow sha256_prefix16 — 16 hex

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
    console.log('[cache-gc.sidecars.test] skipping: MongoDB unreachable');
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
  return mkdtemp(path.join(os.tmpdir(), 'cache-gc-sidecars-'));
}

/** Register `root` as a library and bust the app's own in-memory
 * `loadLibraryRoots()` cache so it picks up the fresh insert. Required for any
 * delete decision — with no resolvable library id the sweep scans but never
 * deletes. */
async function registerLibrary(root: string): Promise<ObjectId> {
  const libraryId = new ObjectId();
  await db!.collection('folders').insertOne({
    _id: libraryId,
    path: root,
    label: 'cache-gc-sidecars-test',
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

async function writeAvif(p: string): Promise<void> {
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(p, Buffer.from([0x00, 0x00, 0x00, 0x1c])); // tiny AVIF-ish bytes
}

/** Write a LEGACY `.meta` sidecar — the shape the pre-#2258 `.meta`
 * protocol used to write. Nothing in the current codebase writes this any
 * more; the test writes it by hand to simulate state left behind by an
 * older deployed version. */
async function writeLegacySidecar(thumbPath: string): Promise<void> {
  await mkdir(path.dirname(thumbPath), { recursive: true });
  await writeFile(`${thumbPath}.meta`, JSON.stringify({ mtimeMs: 1, size: 1 }));
}

/** Age `p` past the 60s recency-skip window so the sweep will consider it. */
async function agePast(p: string): Promise<void> {
  const past = new Date(Date.now() - 5 * 60 * 1000);
  await utimes(p, past, past);
}

function thumbsDir(root: string): string {
  return path.join(root, '.maple', 'thumbs');
}

describe('sweepOrphanedCaches — legacy thumb .meta sidecars', () => {
  test('reaps the legacy sidecar alongside its thumb, and keeps a live thumb’s', async () => {
    if (!mongoReachable) return;
    const { sweepOrphanedCaches } = await import('./cache-gc.ts');
    const root = await mkTree();
    try {
      const libraryId = await registerLibrary(root);
      await insertLiveAsset(libraryId, '', 'live.dng');

      const orphan = path.join(thumbsDir(root), `${DEAD_KEY}.avif`);
      const live = path.join(thumbsDir(root), `${sha256Prefix16('live.dng')}.avif`);
      for (const f of [orphan, live]) {
        await writeAvif(f);
        await writeLegacySidecar(f);
        await agePast(f);
        await agePast(`${f}.meta`);
      }

      // Only the two .avif files are scanned; sidecars ride along uncounted.
      expect(await sweepOrphanedCaches(root)).toEqual({
        scanned: 2,
        deleted: 1,
        skipped_recent: 0,
      });

      await expect(stat(orphan)).rejects.toThrow();
      await expect(stat(`${orphan}.meta`)).rejects.toThrow();
      expect((await stat(live)).size).toBeGreaterThan(0);
      expect((await stat(`${live}.meta`)).size).toBeGreaterThan(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('reaps a stranded legacy sidecar whose thumb is gone', async () => {
    if (!mongoReachable) return;
    const { sweepOrphanedCaches } = await import('./cache-gc.ts');
    const root = await mkTree();
    try {
      const libraryId = await registerLibrary(root);
      await insertLiveAsset(libraryId, '', 'live.dng');

      const live = path.join(thumbsDir(root), `${sha256Prefix16('live.dng')}.avif`);
      await writeAvif(live);
      await writeLegacySidecar(live);
      await agePast(live);
      await agePast(`${live}.meta`);

      // A sidecar with no artefact beside it — never scanned as an entry, so
      // without the dedicated pass it would leak forever.
      const stranded = path.join(thumbsDir(root), `${DEAD_KEY}.avif.meta`);
      await mkdir(path.dirname(stranded), { recursive: true });
      await writeFile(stranded, JSON.stringify({ mtimeMs: 1, size: 1 }));
      await agePast(stranded);

      // Only the live .avif is scanned, and nothing is counted deleted.
      expect(await sweepOrphanedCaches(root)).toEqual({
        scanned: 1,
        deleted: 0,
        skipped_recent: 0,
      });

      await expect(stat(stranded)).rejects.toThrow();
      expect((await stat(live)).size).toBeGreaterThan(0);
      expect((await stat(`${live}.meta`)).size).toBeGreaterThan(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('leaves a just-written stranded legacy sidecar for the next pass', async () => {
    if (!mongoReachable) return;
    const { sweepOrphanedCaches } = await import('./cache-gc.ts');
    const root = await mkTree();
    try {
      await registerLibrary(root);
      // Not aged: within the recency window a sidecar belongs to a thumb some
      // stage is mid-publish on, so it must survive this pass.
      const fresh = path.join(thumbsDir(root), `${DEAD_KEY}.avif.meta`);
      await mkdir(path.dirname(fresh), { recursive: true });
      await writeFile(fresh, JSON.stringify({ mtimeMs: 1, size: 1 }));

      expect(await sweepOrphanedCaches(root)).toEqual({
        scanned: 0,
        deleted: 0,
        skipped_recent: 0,
      });
      expect((await stat(fresh)).size).toBeGreaterThan(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

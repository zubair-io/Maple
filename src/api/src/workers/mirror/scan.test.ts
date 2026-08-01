/**
 * mirror-scan detector tests. Integration tests against a real Mongo (skip-pass
 * when unreachable). Covers: enqueue of a missing original AND its canonical
 * sidecar, offline-mirror-root skip (no flood), and up-to-date no-op.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { MongoClient, type Db } from 'mongodb';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';

const TEST_DB = `maple_test_mirrorscan_${process.pid}`;
process.env.MAPLE_MONGO_DB = TEST_DB;
const MONGO_URI = process.env.MAPLE_MONGO_URI ?? 'mongodb://localhost:27017';

let mongo: MongoClient | null = null;
let mongoReachable = false;
let db: Db | null = null;
let primaryRoot: string;
let mirrorRoot: string;

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
    console.log('[mirror scan.test] skipping: MongoDB unreachable');
    return;
  }
  db = mongo!.db(TEST_DB);
  await db.dropDatabase();
  // Pin the app's getDb() singleton to OUR test DB. Multiple Mongo test files
  // share one bun process, so the module-top env assignment can be overwritten
  // by another file's; re-set it here, right before closeDb() forces a
  // reconnect, so the worker reads the same DB the fixtures are written to.
  // We only need the mirror_queue unique index — not the full app
  // ensureIndexes() suite, which runs migrations unrelated to this worker.
  process.env.MAPLE_MONGO_DB = TEST_DB;
  const { closeDb, mirrorQueueCollection } = await import('../../db/client.ts');
  await closeDb();
  await (
    await mirrorQueueCollection()
  ).createIndex({ mirror_path: 1 }, { unique: true, name: 'mirror_queue_path' });
});

/** Insert a folder + a live asset for `<primaryRoot>/<filename>`. Returns nothing. */
async function seedAsset(filename: string): Promise<void> {
  const folder = await db!
    .collection('folders')
    .insertOne({ path: primaryRoot, label: 'lib', last_scan: null, file_count: 0, created_at: '' });
  await db!.collection('assets').insertOne({
    fileinfo: [
      { library_id: folder.insertedId, path: '', filename, deleted_at: null, missing_since: null },
    ],
  } as Record<string, unknown>);
}

beforeEach(async () => {
  if (!mongoReachable || !db) return;
  await db.collection('assets').deleteMany({});
  await db.collection('folders').deleteMany({});
  await db.collection('mirror_queue').deleteMany({});
  primaryRoot = mkdtempSync(join(tmpdir(), 'mirror-scan-primary-'));
  mirrorRoot = mkdtempSync(join(tmpdir(), 'mirror-scan-mirror-'));
  const { invalidateLibraryRoots } = await import('../../indexer/libraries.cache.ts');
  invalidateLibraryRoots();
  const { clearMirrorRoots } = await import('../../fs/mirror-registry.ts');
  clearMirrorRoots();
});

afterAll(async () => {
  if (mongo) await mongo.close();
});

describe('mirror-scan detector', () => {
  it('enqueues a missing original and its canonical sidecar', async () => {
    if (!mongoReachable) return;
    writeFileSync(join(primaryRoot, 'IMG.dng'), 'raw');
    writeFileSync(join(primaryRoot, 'IMG.xmp'), '<xmp/>');
    await seedAsset('IMG.dng');
    const { setMirrorRoots } = await import('../../fs/mirror-registry.ts');
    setMirrorRoots({ [primaryRoot]: [mirrorRoot] });

    const { runMirrorScanOnce } = await import('./scan.ts');
    const progressPaths: string[] = [];
    const summary = await runMirrorScanOnce({
      onProgress: (p) => progressPaths.push(p.currentPath),
    });
    expect(summary.enqueued).toBe(2);
    // The progress hook fired for the walked original (proves the walk is live).
    expect(progressPaths).toContain(join(primaryRoot, 'IMG.dng'));

    const queued = await db!
      .collection('mirror_queue')
      .find({})
      .map((d) => d.mirror_path as string)
      .toArray();
    expect(queued.sort()).toEqual(
      [join(mirrorRoot, 'IMG.dng'), join(mirrorRoot, 'IMG.xmp')].sort(),
    );
  });

  it("enqueues the asset's .maple thumb and preview so the cache backlog reaches the mirror", async () => {
    if (!mongoReachable) return;
    writeFileSync(join(primaryRoot, 'IMG.dng'), 'raw');
    // Cache rendered before the mirror was configured — the inline
    // `replicatePath` hook never ran for it, so the detector is what carries it.
    const { resolveThumbPath, cachePathFor } = await import('../../fs/xmp.ts');
    const { PREVIEW_CACHE_SUFFIX } = await import('../../indexer/previewer.ts');
    const thumbPath = resolveThumbPath(join(primaryRoot, 'IMG.dng'));
    const previewPath = cachePathFor(join(primaryRoot, 'IMG.dng'), 'previews', PREVIEW_CACHE_SUFFIX);
    mkdirSync(dirname(thumbPath), { recursive: true });
    mkdirSync(dirname(previewPath), { recursive: true });
    writeFileSync(thumbPath, 'avif-thumb');
    writeFileSync(previewPath, 'avif-preview');
    await seedAsset('IMG.dng');
    const { setMirrorRoots } = await import('../../fs/mirror-registry.ts');
    setMirrorRoots({ [primaryRoot]: [mirrorRoot] });

    const { runMirrorScanOnce } = await import('./scan.ts');
    const summary = await runMirrorScanOnce();
    expect(summary.enqueued).toBe(3); // original + thumb + preview (no sidecar)

    const queued = await db!
      .collection('mirror_queue')
      .find({})
      .map((d) => d.mirror_path as string)
      .toArray();
    const rel = (p: string) => join(mirrorRoot, relative(primaryRoot, p));
    expect(queued).toContain(rel(thumbPath));
    expect(queued).toContain(rel(previewPath));
  });

  it('skips an offline mirror root instead of flooding the queue', async () => {
    if (!mongoReachable) return;
    writeFileSync(join(primaryRoot, 'IMG.dng'), 'raw');
    await seedAsset('IMG.dng');
    const offline = join(tmpdir(), `mirror-scan-offline-${process.pid}-does-not-exist`);
    const { setMirrorRoots } = await import('../../fs/mirror-registry.ts');
    setMirrorRoots({ [primaryRoot]: [offline] });

    const { runMirrorScanOnce } = await import('./scan.ts');
    const summary = await runMirrorScanOnce();
    expect(summary.enqueued).toBe(0);
    expect(summary.skippedOffline).toBeGreaterThan(0);
    expect(await db!.collection('mirror_queue').countDocuments({})).toBe(0);
  });

  it('does not enqueue when the mirror is already up to date', async () => {
    if (!mongoReachable) return;
    writeFileSync(join(primaryRoot, 'IMG.dng'), 'raw');
    await seedAsset('IMG.dng');
    const { setMirrorRoots } = await import('../../fs/mirror-registry.ts');
    setMirrorRoots({ [primaryRoot]: [mirrorRoot] });
    // Pre-replicate the original (mtime-preserving) so it's current.
    const { copyFileToMirror } = await import('./replicate.ts');
    await copyFileToMirror(join(primaryRoot, 'IMG.dng'), join(mirrorRoot, 'IMG.dng'));

    const { runMirrorScanOnce } = await import('./scan.ts');
    const summary = await runMirrorScanOnce();
    expect(summary.enqueued).toBe(0);
    expect(summary.upToDate).toBeGreaterThan(0);
  });
});

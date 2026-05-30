/**
 * missing-reaper tests.
 *
 * Integration tests run against a real Mongo (skip-pass when unreachable,
 * mirroring trash-gc.test.ts). They cover the reaper's core invariants:
 *   - hard-deletes a row whose every live location is gone and whose tag
 *     predates the boot start gate;
 *   - honours the boot-time start gate (tag newer than startedAt is left);
 *   - clears the tag (recovered) when the file is still on disk;
 *   - the mount guard skips a row whose library root is offline / missing;
 *   - a multi-location asset survives while ANY live location still exists.
 *
 * Plus a no-DB unit assertion that the worker always boots paused.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { MongoClient, type Db, type ObjectId } from 'mongodb';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TEST_DB = `maple_test_missingreaper_${process.pid}`;
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
    console.log('[missing-reaper.test] skipping: MongoDB unreachable');
    return;
  }
  db = mongo!.db(TEST_DB);
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
  await db!.collection('assets').deleteMany({});
  await db!.collection('folders').deleteMany({});
  const { invalidateLibraryRoots } = await import('../indexer/libraries.cache.ts');
  invalidateLibraryRoots();
});

afterAll(async () => {
  if (mongo) {
    await mongo.db(TEST_DB).dropDatabase();
    await mongo.close();
  }
  const { closeDb } = await import('../db/client.ts');
  await closeDb();
});

const ASSET_BASE = {
  size: 1,
  mtime: 0,
  rating: 0,
  flag: 0,
  color_label: '',
  indexed_at: '2026-05-11T00:00:00Z',
};

/** Register a library root folder + invalidate the roots cache. */
async function seedLibrary(rootDir: string): Promise<ObjectId> {
  const { foldersCollection } = await import('../db/client.ts');
  const { invalidateLibraryRoots } = await import('../indexer/libraries.cache.ts');
  const foldersColl = await foldersCollection();
  const libraryId = await foldersColl
    .insertOne({
      path: rootDir,
      label: 'reaper-test',
      last_scan: null,
      file_count: 0,
      created_at: '2026-05-11T00:00:00Z',
    } as never)
    .then((r) => r.insertedId);
  invalidateLibraryRoots();
  return libraryId as ObjectId;
}

describe('runMissingReaperOnce', () => {
  it('hard-deletes a row whose file is gone and whose tag predates startedAt', async () => {
    if (!mongoReachable) return;
    const dir = mkdtempSync(join(tmpdir(), 'maple-reaper-'));
    const libraryId = await seedLibrary(dir);
    // No file on disk at gone.jpg — it is genuinely absent.
    await db!.collection('assets').insertOne({
      ...ASSET_BASE,
      maple_id: 'gone-1',
      fileinfo: [{ path: '', filename: 'gone.jpg', library_id: libraryId, deleted_at: null }],
      missing_since: '2026-05-01T00:00:00.000Z', // older than startedAt below
    } as never);

    const { runMissingReaperOnce } = await import('./missing-reaper.ts');
    const summary = await runMissingReaperOnce({ startedAtIso: '2026-05-10T00:00:00.000Z' });

    expect(summary.scanned).toBe(1);
    expect(summary.reaped).toBe(1);
    expect(await db!.collection('assets').countDocuments({})).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });

  it('leaves a row whose tag is NEWER than the boot start gate', async () => {
    if (!mongoReachable) return;
    const dir = mkdtempSync(join(tmpdir(), 'maple-reaper-'));
    const libraryId = await seedLibrary(dir);
    await db!.collection('assets').insertOne({
      ...ASSET_BASE,
      maple_id: 'fresh-1',
      fileinfo: [{ path: '', filename: 'gone.jpg', library_id: libraryId, deleted_at: null }],
      missing_since: '2026-05-20T00:00:00.000Z', // newer than startedAt
    } as never);

    const { runMissingReaperOnce } = await import('./missing-reaper.ts');
    const summary = await runMissingReaperOnce({ startedAtIso: '2026-05-10T00:00:00.000Z' });

    expect(summary.scanned).toBe(0);
    expect(summary.reaped).toBe(0);
    expect(await db!.collection('assets').countDocuments({})).toBe(1);
    rmSync(dir, { recursive: true, force: true });
  });

  it('clears the tag (recovered) when the file is still on disk', async () => {
    if (!mongoReachable) return;
    const dir = mkdtempSync(join(tmpdir(), 'maple-reaper-'));
    writeFileSync(join(dir, 'here.jpg'), 'x');
    const libraryId = await seedLibrary(dir);
    await db!.collection('assets').insertOne({
      ...ASSET_BASE,
      maple_id: 'recover-1',
      fileinfo: [{ path: '', filename: 'here.jpg', library_id: libraryId, deleted_at: null }],
      missing_since: '2026-05-01T00:00:00.000Z',
    } as never);

    const { runMissingReaperOnce } = await import('./missing-reaper.ts');
    const summary = await runMissingReaperOnce({ startedAtIso: '2026-05-10T00:00:00.000Z' });

    expect(summary.reaped).toBe(0);
    expect(summary.recovered).toBe(1);
    const doc = await db!.collection('assets').findOne({ maple_id: 'recover-1' });
    expect(doc).not.toBeNull();
    expect(doc!.missing_since).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });

  it('mount guard: skips (does not delete) when the library root is offline', async () => {
    if (!mongoReachable) return;
    // Point the library at a directory that does NOT exist — simulates an
    // unmounted share. The reaper must not mistake that for a deleted file.
    const offlineRoot = join(tmpdir(), `maple-reaper-offline-${process.pid}-${Date.now()}`);
    const libraryId = await seedLibrary(offlineRoot);
    await db!.collection('assets').insertOne({
      ...ASSET_BASE,
      maple_id: 'offline-1',
      fileinfo: [{ path: '', filename: 'gone.jpg', library_id: libraryId, deleted_at: null }],
      missing_since: '2026-05-01T00:00:00.000Z',
    } as never);

    const { runMissingReaperOnce } = await import('./missing-reaper.ts');
    const summary = await runMissingReaperOnce({ startedAtIso: '2026-05-10T00:00:00.000Z' });

    expect(summary.reaped).toBe(0);
    expect(summary.skippedMountOffline).toBe(1);
    const doc = await db!.collection('assets').findOne({ maple_id: 'offline-1' });
    expect(doc).not.toBeNull();
    expect(doc!.missing_since).toBe('2026-05-01T00:00:00.000Z'); // tag untouched
  });

  it('multi-location asset survives while ANY live location still exists', async () => {
    if (!mongoReachable) return;
    const dir = mkdtempSync(join(tmpdir(), 'maple-reaper-'));
    writeFileSync(join(dir, 'copy-b.jpg'), 'x'); // second copy still present
    const libraryId = await seedLibrary(dir);
    await db!.collection('assets').insertOne({
      ...ASSET_BASE,
      maple_id: 'multi-1',
      fileinfo: [
        { path: '', filename: 'copy-a.jpg', library_id: libraryId, deleted_at: null }, // gone
        { path: '', filename: 'copy-b.jpg', library_id: libraryId, deleted_at: null }, // present
      ],
      missing_since: '2026-05-01T00:00:00.000Z',
    } as never);

    const { runMissingReaperOnce } = await import('./missing-reaper.ts');
    const summary = await runMissingReaperOnce({ startedAtIso: '2026-05-10T00:00:00.000Z' });

    expect(summary.reaped).toBe(0);
    expect(summary.recovered).toBe(1);
    expect(await db!.collection('assets').countDocuments({ maple_id: 'multi-1' })).toBe(1);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('startMissingReaper', () => {
  it('always boots paused and registers a controllable worker', async () => {
    const { stageRegistry } = await import('./registry.ts');
    const { startMissingReaper, MISSING_REAPER_NAME } = await import('./missing-reaper.ts');
    // Long interval so no tick fires during the test.
    const handle = startMissingReaper({ intervalMs: 3_600_000 });
    try {
      const status = stageRegistry.statuses()[MISSING_REAPER_NAME];
      expect(status).toBeDefined();
      expect(status!.status).toBe('paused');

      // Resume / pause flips the live state via the same registry surface the
      // routes use.
      await stageRegistry.resume(MISSING_REAPER_NAME);
      expect(stageRegistry.statuses()[MISSING_REAPER_NAME]!.status).toBe('running');
      await stageRegistry.pause(MISSING_REAPER_NAME);
      expect(stageRegistry.statuses()[MISSING_REAPER_NAME]!.status).toBe('paused');
    } finally {
      handle.stop();
    }
    expect(stageRegistry.statuses()[MISSING_REAPER_NAME]).toBeUndefined();
  });
});

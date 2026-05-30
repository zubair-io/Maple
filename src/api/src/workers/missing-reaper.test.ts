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
    const summary = await runMissingReaperOnce({ deleteBeforeIso: '2026-05-10T00:00:00.000Z' });

    expect(summary.scanned).toBe(1);
    expect(summary.reaped).toBe(1);
    expect(await db!.collection('assets').countDocuments({})).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });

  it('cooldown: leaves an all-gone row that has not been missing long enough', async () => {
    if (!mongoReachable) return;
    const dir = mkdtempSync(join(tmpdir(), 'maple-reaper-'));
    const libraryId = await seedLibrary(dir);
    await db!.collection('assets').insertOne({
      ...ASSET_BASE,
      maple_id: 'fresh-1',
      fileinfo: [{ path: '', filename: 'gone.jpg', library_id: libraryId, deleted_at: null }],
      missing_since: '2026-05-20T00:00:00.000Z', // newer than the delete cutoff
    } as never);

    const { runMissingReaperOnce } = await import('./missing-reaper.ts');
    const summary = await runMissingReaperOnce({ deleteBeforeIso: '2026-05-10T00:00:00.000Z' });

    // Scanned (no boot gate) but not deleted — still inside the prune window.
    expect(summary.scanned).toBe(1);
    expect(summary.skippedCooldown).toBe(1);
    expect(summary.reaped).toBe(0);
    expect(await db!.collection('assets').countDocuments({})).toBe(1);
    rmSync(dir, { recursive: true, force: true });
  });

  it('paused (allowDelete:false): skips the delete but STILL recovers a re-found file', async () => {
    if (!mongoReachable) return;
    const dir = mkdtempSync(join(tmpdir(), 'maple-reaper-'));
    writeFileSync(join(dir, 'back.jpg'), 'x'); // this one is present again
    const libraryId = await seedLibrary(dir);
    await db!.collection('assets').insertMany([
      {
        ...ASSET_BASE,
        maple_id: 'paused-gone',
        fileinfo: [{ path: '', filename: 'gone.jpg', library_id: libraryId, deleted_at: null }],
        missing_since: '2026-05-01T00:00:00.000Z', // aged out, but deletes paused
      },
      {
        ...ASSET_BASE,
        maple_id: 'paused-back',
        fileinfo: [{ path: '', filename: 'back.jpg', library_id: libraryId, deleted_at: null }],
        missing_since: '2026-05-01T00:00:00.000Z',
      },
    ] as never);

    const { runMissingReaperOnce } = await import('./missing-reaper.ts');
    const summary = await runMissingReaperOnce({
      deleteBeforeIso: '2026-05-10T00:00:00.000Z',
      allowDelete: false,
    });

    // Aged-out all-gone row is NOT deleted while paused...
    expect(summary.reaped).toBe(0);
    expect(summary.skippedPaused).toBe(1);
    expect(await db!.collection('assets').countDocuments({ maple_id: 'paused-gone' })).toBe(1);
    // ...but the re-found file still recovers (tag cleared) — recovery ignores pause.
    expect(summary.recovered).toBe(1);
    const back = await db!.collection('assets').findOne({ maple_id: 'paused-back' });
    expect(back!.missing_since).toBeNull();
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
    const summary = await runMissingReaperOnce({ deleteBeforeIso: '2026-05-10T00:00:00.000Z' });

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
    const summary = await runMissingReaperOnce({ deleteBeforeIso: '2026-05-10T00:00:00.000Z' });

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
    const summary = await runMissingReaperOnce({ deleteBeforeIso: '2026-05-10T00:00:00.000Z' });

    expect(summary.reaped).toBe(0);
    expect(summary.recovered).toBe(1);
    expect(await db!.collection('assets').countDocuments({ maple_id: 'multi-1' })).toBe(1);
    // The gone entry is pruned ($pull) and the tag cleared, leaving only the
    // present copy.
    const doc = await db!.collection('assets').findOne({ maple_id: 'multi-1' });
    expect(doc!.fileinfo.map((f: { filename: string }) => f.filename)).toEqual(['copy-b.jpg']);
    expect(doc!.missing_since).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });

  it('prunes a phantom primary, keeps the asset, and re-arms dead original stages', async () => {
    if (!mongoReachable) return;
    // Reproduces the IMG_2093 case: a phantom `.1.JPG` entry sits at the
    // primary slot (so exif/thumb/preview ENOENT and dead-letter), while the
    // real file lives in a sibling fileinfo entry.
    const dir = mkdtempSync(join(tmpdir(), 'maple-reaper-'));
    writeFileSync(join(dir, 'IMG_2093.JPG'), 'x'); // the real file
    const libraryId = await seedLibrary(dir);
    await db!.collection('assets').insertOne({
      ...ASSET_BASE,
      maple_id: 'phantom-1',
      fileinfo: [
        { path: '', filename: 'IMG_2093.1.JPG', library_id: libraryId }, // phantom (gone)
        { path: '', filename: 'IMG_2093.JPG', library_id: libraryId, deleted_at: null }, // real
      ],
      missing_since: '2026-05-01T00:00:00.000Z',
      stages: {
        exif: { version: 0, attempts: 5, last_error: 'ENOENT', processed_at: null, dead: true },
        thumb: { version: 0, attempts: 5, last_error: 'ENOENT', processed_at: null, dead: true },
      },
    } as never);

    const { runMissingReaperOnce } = await import('./missing-reaper.ts');
    const summary = await runMissingReaperOnce({ deleteBeforeIso: '2026-05-10T00:00:00.000Z' });

    expect(summary.reaped).toBe(0);
    expect(summary.recovered).toBe(1);
    expect(summary.prunedEntries).toBe(1);
    const doc = await db!.collection('assets').findOne({ maple_id: 'phantom-1' });
    expect(doc).not.toBeNull();
    expect(doc!.fileinfo.map((f: { filename: string }) => f.filename)).toEqual(['IMG_2093.JPG']);
    expect(doc!.missing_since).toBeNull();
    // Original-file stages re-queued (version 0, not dead) because the pruned
    // entry was the primary.
    expect(doc!.stages.exif.dead).toBe(false);
    expect(doc!.stages.exif.version).toBe(0);
    expect(doc!.stages.thumb.dead).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it('does NOT re-arm a stage that is not dead (already processed) on recovery', async () => {
    if (!mongoReachable) return;
    const dir = mkdtempSync(join(tmpdir(), 'maple-reaper-'));
    writeFileSync(join(dir, 'real.jpg'), 'x'); // primary present
    const libraryId = await seedLibrary(dir);
    await db!.collection('assets').insertOne({
      ...ASSET_BASE,
      maple_id: 'nonprimary-1',
      fileinfo: [
        { path: '', filename: 'real.jpg', library_id: libraryId, deleted_at: null }, // present
        { path: '', filename: 'stale.jpg', library_id: libraryId, deleted_at: null }, // gone
      ],
      missing_since: '2026-05-01T00:00:00.000Z',
      stages: {
        exif: { version: 2, attempts: 0, last_error: null, processed_at: null, dead: false },
      },
    } as never);

    const { runMissingReaperOnce } = await import('./missing-reaper.ts');
    await runMissingReaperOnce({ deleteBeforeIso: '2026-05-10T00:00:00.000Z' });

    const doc = await db!.collection('assets').findOne({ maple_id: 'nonprimary-1' });
    expect(doc!.fileinfo.map((f: { filename: string }) => f.filename)).toEqual(['real.jpg']);
    // exif already succeeded (not dead) — left untouched, no needless reprocess.
    expect(doc!.stages.exif.version).toBe(2);
    rmSync(dir, { recursive: true, force: true });
  });

  it('re-arms a dead original stage on pure recovery (file came back, nothing pruned)', async () => {
    if (!mongoReachable) return;
    const dir = mkdtempSync(join(tmpdir(), 'maple-reaper-'));
    writeFileSync(join(dir, 'back.jpg'), 'x'); // file is present again
    const libraryId = await seedLibrary(dir);
    await db!.collection('assets').insertOne({
      ...ASSET_BASE,
      maple_id: 'recover-rearm-1',
      fileinfo: [{ path: '', filename: 'back.jpg', library_id: libraryId, deleted_at: null }],
      missing_since: '2026-05-01T00:00:00.000Z',
      stages: {
        exif: { version: 0, attempts: 5, last_error: 'ENOENT', processed_at: null, dead: true },
      },
    } as never);

    const { runMissingReaperOnce } = await import('./missing-reaper.ts');
    const summary = await runMissingReaperOnce({ deleteBeforeIso: '2026-05-10T00:00:00.000Z' });

    expect(summary.recovered).toBe(1);
    expect(summary.prunedEntries).toBe(0); // nothing absent to prune
    const doc = await db!.collection('assets').findOne({ maple_id: 'recover-rearm-1' });
    expect(doc!.missing_since).toBeNull();
    // The previously-dead exif is re-queued so it reprocesses the recovered file.
    expect(doc!.stages.exif.dead).toBe(false);
    expect(doc!.stages.exif.version).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });

  it('name-mismatch guard: never hard-deletes when a case-variant exists on disk', async () => {
    if (!mongoReachable) return;
    const dir = mkdtempSync(join(tmpdir(), 'maple-reaper-'));
    writeFileSync(join(dir, 'photo.jpg'), 'x'); // on disk as lowercase
    const libraryId = await seedLibrary(dir);
    await db!.collection('assets').insertOne({
      ...ASSET_BASE,
      maple_id: 'mismatch-1',
      // Stored uppercase. On a case-sensitive FS (Linux/prod) stat() ENOENTs and
      // the name-mismatch veto fires; on a case-insensitive FS (dev macOS) stat
      // succeeds and it takes the recover path. The invariant under test is the
      // same on both: the row is NEVER hard-deleted.
      fileinfo: [{ path: '', filename: 'PHOTO.JPG', library_id: libraryId, deleted_at: null }],
      missing_since: '2026-05-01T00:00:00.000Z',
    } as never);

    const { runMissingReaperOnce } = await import('./missing-reaper.ts');
    const summary = await runMissingReaperOnce({ deleteBeforeIso: '2026-05-10T00:00:00.000Z' });

    expect(summary.reaped).toBe(0);
    // Either the mismatch veto fired (case-sensitive) or it recovered
    // (case-insensitive) — both mean "not wrongly deleted".
    expect(summary.skippedNameMismatch + summary.recovered).toBe(1);
    expect(await db!.collection('assets').countDocuments({ maple_id: 'mismatch-1' })).toBe(1);
    rmSync(dir, { recursive: true, force: true });
  });

  it('circuit breaker: aborts a pass that would mass-delete, deleting nothing', async () => {
    if (!mongoReachable) return;
    const dir = mkdtempSync(join(tmpdir(), 'maple-reaper-')); // empty — every file gone
    const libraryId = await seedLibrary(dir);
    const docs = Array.from({ length: 40 }, (_, i) => ({
      ...ASSET_BASE,
      maple_id: `breaker-${i}`,
      fileinfo: [{ path: '', filename: `gone-${i}.jpg`, library_id: libraryId, deleted_at: null }],
      missing_since: '2026-05-01T00:00:00.000Z',
    }));
    await db!.collection('assets').insertMany(docs as never);

    const { runMissingReaperOnce } = await import('./missing-reaper.ts');
    const summary = await runMissingReaperOnce({ deleteBeforeIso: '2026-05-10T00:00:00.000Z' });

    expect(summary.aborted).toBe(true);
    expect(summary.reaped).toBe(0);
    // Nothing deleted — the trip protects against a systemic mis-detection.
    expect(await db!.collection('assets').countDocuments({})).toBe(40);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('claim-query parking', () => {
  it('a tagged (missing_since) asset is skipped by a stage claim query, and re-enters once cleared', async () => {
    if (!mongoReachable) return;
    const { buildClaimQuery } = await import('./run-stage.ts');
    const assets = db!.collection('assets');
    await assets.insertMany([
      { ...ASSET_BASE, maple_id: 'untagged', missing_since: null } as never,
      { ...ASSET_BASE, maple_id: 'tagged', missing_since: '2026-05-01T00:00:00.000Z' } as never,
    ]);
    const q = buildClaimQuery('exif', 1, [], new Set()) as Record<string, unknown>;

    const claimed = await assets.find(q).toArray();
    expect(claimed.map((d) => d.maple_id).sort()).toEqual(['untagged']);

    // Clearing the tag (what the reaper does on resolution) re-admits it.
    await assets.updateOne({ maple_id: 'tagged' }, { $set: { missing_since: null } });
    const after = await assets.find(q).toArray();
    expect(after.map((d) => d.maple_id).sort()).toEqual(['tagged', 'untagged']);
  });
});

describe('startMissingReaper', () => {
  it('registers a controllable worker whose pause/resume flip live state', async () => {
    const { stageRegistry } = await import('./registry.ts');
    const { startMissingReaper, MISSING_REAPER_NAME } = await import('./missing-reaper.ts');
    // Long interval so no tick fires during the test.
    const handle = startMissingReaper({ intervalMs: 3_600_000 });
    await handle.ready.catch(() => undefined);
    try {
      expect(stageRegistry.statuses()[MISSING_REAPER_NAME]).toBeDefined();
      // pause/resume flip live state via the same registry surface the routes
      // use (in-memory flip is synchronous; persistence is best-effort).
      await stageRegistry.pause(MISSING_REAPER_NAME);
      expect(stageRegistry.statuses()[MISSING_REAPER_NAME]!.status).toBe('paused');
      await stageRegistry.resume(MISSING_REAPER_NAME);
      expect(stageRegistry.statuses()[MISSING_REAPER_NAME]!.status).toBe('running');
    } finally {
      handle.stop();
    }
    expect(stageRegistry.statuses()[MISSING_REAPER_NAME]).toBeUndefined();
  });

  it('persists pause across restarts (worker_config), running by default', async () => {
    if (!mongoReachable) return;
    const { stageRegistry } = await import('./registry.ts');
    const { startMissingReaper, MISSING_REAPER_NAME } = await import('./missing-reaper.ts');
    await db!.collection('worker_config').deleteMany({ name: MISSING_REAPER_NAME });

    // First lifetime: no stored config → boots running by default. Pause it.
    const h1 = startMissingReaper({ intervalMs: 3_600_000 });
    await h1.ready;
    expect(stageRegistry.statuses()[MISSING_REAPER_NAME]!.status).toBe('running');
    await stageRegistry.pause(MISSING_REAPER_NAME);
    await new Promise((r) => setTimeout(r, 100)); // let the best-effort persist flush
    h1.stop();

    // Second lifetime: adopts the stored paused state.
    const h2 = startMissingReaper({ intervalMs: 3_600_000 });
    await h2.ready;
    expect(stageRegistry.statuses()[MISSING_REAPER_NAME]!.status).toBe('paused');
    await stageRegistry.resume(MISSING_REAPER_NAME);
    await new Promise((r) => setTimeout(r, 100));
    h2.stop();

    // Third lifetime: resume persisted → boots running again.
    const h3 = startMissingReaper({ intervalMs: 3_600_000 });
    await h3.ready;
    expect(stageRegistry.statuses()[MISSING_REAPER_NAME]!.status).toBe('running');
    h3.stop();
  });
});

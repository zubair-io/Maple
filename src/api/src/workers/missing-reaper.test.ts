/**
 * missing-reaper tests. Integration tests run against a real Mongo (skip-pass
 * when unreachable, mirroring trash-gc.test.ts): delete-when-all-gone, age-window
 * cooldown, recover/prune + re-arm, mount guard, name-mismatch veto, circuit
 * breaker, pause-skips-delete-but-still-recovers, claim-query parking, and
 * persisted pause/resume control.
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

/** Compact fileinfo entry for fixtures (root-relative path ''). */
function fi(filename: string, libraryId: ObjectId, deletedAt: string | null = null) {
  return { path: '', filename, library_id: libraryId, deleted_at: deletedAt };
}
/** A dead original-file stage state (failed against the vanished path). */
const deadStage = { version: 0, attempts: 5, last_error: 'ENOENT', processed_at: null, dead: true };

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

const DELETE_BEFORE = '2026-05-10T00:00:00.000Z';
const AGED = '2026-05-01T00:00:00.000Z'; // older than DELETE_BEFORE → delete-eligible

describe('runMissingReaperOnce', () => {
  it('hard-deletes a row whose file is gone and has been missing past the window', async () => {
    if (!mongoReachable) return;
    const dir = mkdtempSync(join(tmpdir(), 'maple-reaper-'));
    const libraryId = await seedLibrary(dir); // no file on disk → genuinely absent
    await db!.collection('assets').insertOne({
      ...ASSET_BASE,
      maple_id: 'gone-1',
      fileinfo: [fi('gone.jpg', libraryId)],
      missing_since: AGED,
    } as never);

    const { runMissingReaperOnce } = await import('./missing-reaper.ts');
    const summary = await runMissingReaperOnce({ deleteBeforeIso: DELETE_BEFORE });

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
      fileinfo: [fi('gone.jpg', libraryId)],
      missing_since: '2026-05-20T00:00:00.000Z', // newer than the delete cutoff
    } as never);

    const { runMissingReaperOnce } = await import('./missing-reaper.ts');
    const summary = await runMissingReaperOnce({ deleteBeforeIso: DELETE_BEFORE });

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
        fileinfo: [fi('gone.jpg', libraryId)],
        missing_since: AGED,
      },
      {
        ...ASSET_BASE,
        maple_id: 'paused-back',
        fileinfo: [fi('back.jpg', libraryId)],
        missing_since: AGED,
      },
    ] as never);

    const { runMissingReaperOnce } = await import('./missing-reaper.ts');
    const summary = await runMissingReaperOnce({
      deleteBeforeIso: DELETE_BEFORE,
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
      fileinfo: [fi('here.jpg', libraryId)],
      missing_since: AGED,
    } as never);

    const { runMissingReaperOnce } = await import('./missing-reaper.ts');
    const summary = await runMissingReaperOnce({ deleteBeforeIso: DELETE_BEFORE });

    expect(summary.reaped).toBe(0);
    expect(summary.recovered).toBe(1);
    const doc = await db!.collection('assets').findOne({ maple_id: 'recover-1' });
    expect(doc).not.toBeNull();
    expect(doc!.missing_since).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });

  it('mount guard: skips (does not delete) when the library root is offline', async () => {
    if (!mongoReachable) return;
    // Library points at a directory that does NOT exist — an unmounted share.
    const offlineRoot = join(tmpdir(), `maple-reaper-offline-${process.pid}-${Date.now()}`);
    const libraryId = await seedLibrary(offlineRoot);
    await db!.collection('assets').insertOne({
      ...ASSET_BASE,
      maple_id: 'offline-1',
      fileinfo: [fi('gone.jpg', libraryId)],
      missing_since: AGED,
    } as never);

    const { runMissingReaperOnce } = await import('./missing-reaper.ts');
    const summary = await runMissingReaperOnce({ deleteBeforeIso: DELETE_BEFORE });

    expect(summary.reaped).toBe(0);
    expect(summary.skippedMountOffline).toBe(1);
    const doc = await db!.collection('assets').findOne({ maple_id: 'offline-1' });
    expect(doc!.missing_since).toBe(AGED); // tag untouched
  });

  it('multi-location asset survives while ANY live location still exists', async () => {
    if (!mongoReachable) return;
    const dir = mkdtempSync(join(tmpdir(), 'maple-reaper-'));
    writeFileSync(join(dir, 'copy-b.jpg'), 'x'); // second copy still present
    const libraryId = await seedLibrary(dir);
    await db!.collection('assets').insertOne({
      ...ASSET_BASE,
      maple_id: 'multi-1',
      fileinfo: [fi('copy-a.jpg', libraryId), fi('copy-b.jpg', libraryId)], // a gone, b present
      missing_since: AGED,
    } as never);

    const { runMissingReaperOnce } = await import('./missing-reaper.ts');
    const summary = await runMissingReaperOnce({ deleteBeforeIso: DELETE_BEFORE });

    expect(summary.reaped).toBe(0);
    expect(summary.recovered).toBe(1);
    expect(await db!.collection('assets').countDocuments({ maple_id: 'multi-1' })).toBe(1);
    // The gone entry is pruned ($pull) and the tag cleared, leaving only copy-b.
    const doc = await db!.collection('assets').findOne({ maple_id: 'multi-1' });
    expect(doc!.fileinfo.map((f: { filename: string }) => f.filename)).toEqual(['copy-b.jpg']);
    expect(doc!.missing_since).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });

  it('prunes a phantom primary, keeps the asset, and re-arms dead original stages', async () => {
    if (!mongoReachable) return;
    // The IMG_2093 case: a phantom `.1.JPG` at the primary slot (so
    // exif/thumb ENOENT and dead-letter) while the real file is a sibling.
    const dir = mkdtempSync(join(tmpdir(), 'maple-reaper-'));
    writeFileSync(join(dir, 'IMG_2093.JPG'), 'x'); // the real file
    const libraryId = await seedLibrary(dir);
    await db!.collection('assets').insertOne({
      ...ASSET_BASE,
      maple_id: 'phantom-1',
      fileinfo: [fi('IMG_2093.1.JPG', libraryId), fi('IMG_2093.JPG', libraryId)], // phantom, real
      missing_since: AGED,
      stages: { exif: { ...deadStage }, thumb: { ...deadStage } },
    } as never);

    const { runMissingReaperOnce } = await import('./missing-reaper.ts');
    const summary = await runMissingReaperOnce({ deleteBeforeIso: DELETE_BEFORE });

    expect(summary.reaped).toBe(0);
    expect(summary.recovered).toBe(1);
    expect(summary.prunedEntries).toBe(1);
    const doc = await db!.collection('assets').findOne({ maple_id: 'phantom-1' });
    expect(doc!.fileinfo.map((f: { filename: string }) => f.filename)).toEqual(['IMG_2093.JPG']);
    expect(doc!.missing_since).toBeNull();
    // Original-file stages re-queued (version 0, not dead) — the pruned entry was primary.
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
      fileinfo: [fi('real.jpg', libraryId), fi('stale.jpg', libraryId)], // present, gone
      missing_since: AGED,
      stages: {
        exif: { version: 2, attempts: 0, last_error: null, processed_at: null, dead: false },
      },
    } as never);

    const { runMissingReaperOnce } = await import('./missing-reaper.ts');
    await runMissingReaperOnce({ deleteBeforeIso: DELETE_BEFORE });

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
      fileinfo: [fi('back.jpg', libraryId)],
      missing_since: AGED,
      stages: { exif: { ...deadStage } },
    } as never);

    const { runMissingReaperOnce } = await import('./missing-reaper.ts');
    const summary = await runMissingReaperOnce({ deleteBeforeIso: DELETE_BEFORE });

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
    // Stored uppercase. Case-sensitive FS (Linux/prod): stat ENOENTs → veto fires.
    // Case-insensitive FS (dev macOS): stat succeeds → recover path. Both invariant:
    // the row is NEVER hard-deleted.
    await db!.collection('assets').insertOne({
      ...ASSET_BASE,
      maple_id: 'mismatch-1',
      fileinfo: [fi('PHOTO.JPG', libraryId)],
      missing_since: AGED,
    } as never);

    const { runMissingReaperOnce } = await import('./missing-reaper.ts');
    const summary = await runMissingReaperOnce({ deleteBeforeIso: DELETE_BEFORE });

    expect(summary.reaped).toBe(0);
    // Veto fired (case-sensitive) OR recovered (case-insensitive) — both = not deleted.
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
      fileinfo: [fi(`gone-${i}.jpg`, libraryId)],
      missing_since: AGED,
    }));
    await db!.collection('assets').insertMany(docs as never);

    const { runMissingReaperOnce } = await import('./missing-reaper.ts');
    const summary = await runMissingReaperOnce({ deleteBeforeIso: DELETE_BEFORE });

    expect(summary.aborted).toBe(true);
    expect(summary.reaped).toBe(0);
    expect(await db!.collection('assets').countDocuments({})).toBe(40); // nothing deleted
    rmSync(dir, { recursive: true, force: true });
  });
});

// End-to-end of #805: an original-file stage that hits no-resolvable-location
// on an all-soft-deleted asset tags it for the reaper (instead of silently
// marking the stage done), and the reaper then reaps it past the prune window.
// A relinked (re-discovered) live entry before the window recovers instead.
describe('no-live-location stage→reaper handoff (#805)', () => {
  const stageCfg = {
    concurrency: 1,
    maxAttempts: 3,
    paused: false,
    last_seen_target_version: 2,
  };

  it('exif stage tags an all-soft-deleted asset, then the reaper reaps it', async () => {
    if (!mongoReachable) return;
    const dir = mkdtempSync(join(tmpdir(), 'maple-reaper-')); // empty dir, lib registered
    const libraryId = await seedLibrary(dir);
    const ins = await db!.collection('assets').insertOne({
      ...ASSET_BASE,
      maple_id: 'orphan-805',
      // The only location is soft-deleted (its content was replaced at the
      // path → entry tombstoned). assetAbsPath() returns null → the stage
      // skips no-resolvable-location, and the runner must tag it.
      fileinfo: [fi('gone.jpg', libraryId, AGED)],
    } as never);

    const exifStage = (await import('./stages/exif.ts')).default;
    const { _test } = await import('./run-stage.ts');
    const { getDb } = await import('../db/client.ts');
    const images = (await getDb()).collection('assets');
    const configColl = (await getDb()).collection('worker_config');
    await _test.runOnce(exifStage as never, stageCfg, images as never, configColl as never);

    // Tagged for the reaper — and the stage was NOT marked done at the
    // vanished location (no `stages.exif` writeback).
    const tagged = await db!.collection('assets').findOne({ _id: ins.insertedId });
    expect(typeof tagged!.missing_since).toBe('string');
    expect(tagged!.stages?.exif).toBeUndefined();

    // Backdate the tag past the prune window so the reaper is delete-eligible.
    await db!
      .collection('assets')
      .updateOne({ _id: ins.insertedId }, { $set: { missing_since: AGED } });

    const { runMissingReaperOnce } = await import('./missing-reaper.ts');
    const summary = await runMissingReaperOnce({ deleteBeforeIso: DELETE_BEFORE });
    expect(summary.reaped).toBe(1);
    expect(await db!.collection('assets').countDocuments({ _id: ins.insertedId })).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });

  it('a relinked live entry before the window recovers (tag cleared), NOT reaped', async () => {
    if (!mongoReachable) return;
    const dir = mkdtempSync(join(tmpdir(), 'maple-reaper-'));
    writeFileSync(join(dir, 'relinked.jpg'), 'x'); // re-discovered file on disk
    const libraryId = await seedLibrary(dir);
    // Was tagged after all locations went away; then a re-discover added a
    // live entry (deleted_at null) pointing at a file that exists on disk.
    const ins = await db!.collection('assets').insertOne({
      ...ASSET_BASE,
      maple_id: 'relink-805',
      fileinfo: [fi('gone.jpg', libraryId, AGED), fi('relinked.jpg', libraryId)],
      missing_since: AGED, // aged past the window — proving recovery isn't age-gated
    } as never);

    const { runMissingReaperOnce } = await import('./missing-reaper.ts');
    const summary = await runMissingReaperOnce({ deleteBeforeIso: DELETE_BEFORE });

    // The live, on-disk entry survives → recovered, not reaped: tag cleared and
    // the gone sibling pruned.
    expect(summary.reaped).toBe(0);
    expect(summary.recovered).toBe(1);
    const row = await db!.collection('assets').findOne({ _id: ins.insertedId });
    expect(row).not.toBeNull();
    expect(row!.missing_since).toBeNull();
    // The live, on-disk entry is preserved. (The already-soft-deleted sibling
    // is left in place — recovery only $pulls entries it classified as
    // live-but-ENOENT, never the pre-tombstoned ones.)
    const live = (row!.fileinfo as Array<{ filename: string; deleted_at?: string | null }>).filter(
      (f) => !f.deleted_at,
    );
    expect(live.map((f) => f.filename)).toEqual(['relinked.jpg']);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('claim-query parking', () => {
  it('a tagged asset is skipped by a stage claim query, and re-enters once cleared', async () => {
    if (!mongoReachable) return;
    const { buildClaimQuery } = await import('./run-stage.ts');
    const assets = db!.collection('assets');
    await assets.insertMany([
      { ...ASSET_BASE, maple_id: 'untagged', missing_since: null } as never,
      { ...ASSET_BASE, maple_id: 'tagged', missing_since: AGED } as never,
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
    const handle = startMissingReaper({ intervalMs: 3_600_000 }); // long interval — no tick fires
    await handle.ready.catch(() => undefined);
    try {
      expect(stageRegistry.statuses()[MISSING_REAPER_NAME]).toBeDefined();
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

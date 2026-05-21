/**
 * Integration test for the discover producer.
 *
 * Tests the upsert logic (`handleEvent`) directly — bypasses chokidar's
 * polling interval (60 s / 300 s in production) so the test is fast.
 * Also exercises `startDiscover` to verify the module boots without error.
 *
 * Requires: MAPLE_MONGO_URI (or a local MongoDB on localhost:27017).
 * Skips gracefully when Mongo is unreachable.
 */
import { describe, expect, it, beforeAll, afterAll } from 'bun:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { MongoClient, ObjectId, type Db } from 'mongodb';
import * as os from 'node:os';
import * as path from 'node:path';
import { ALL_STAGE_NAMES } from '../stages/manifest.ts';

const TEST_DB = `maple_test_discover_${process.pid}`;
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
    } catch {}
    return null;
  }
}

beforeAll(async () => {
  mongo = await tryConnect();
  mongoReachable = mongo !== null;
  if (!mongoReachable) {
    console.log('[discover.test] skipping: MongoDB unreachable');
    return;
  }
  db = mongo!.db(TEST_DB);
  await db.dropDatabase();
  const { closeDb } = await import('../../db/client.ts');
  await closeDb();
});

afterAll(async () => {
  if (mongo) {
    try {
      await mongo.db(TEST_DB).dropDatabase();
    } catch {}
    try {
      await mongo.close();
    } catch {}
  }
  const { closeDb } = await import('../../db/client.ts');
  await closeDb();
});

describe('discover producer', () => {
  let dir: string;
  let discoverHandle: { stop: () => Promise<void> } | null = null;

  afterAll(async () => {
    if (discoverHandle) await discoverHandle.stop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('inserts a doc with the full stages skeleton when a file is created', async () => {
    if (!mongoReachable) return;

    dir = await mkdtemp(path.join(os.tmpdir(), 'discover-test-'));

    // Import the discover module.
    const { startDiscover, handleEvent } = await import('./index.ts');

    // Create a temporary folder row in the DB so discover can reference it.
    const { foldersCollection, assetsCollection } = await import('../../db/client.ts');
    const foldersColl = await foldersCollection();
    const folderResult = await foldersColl.insertOne({
      abs_path: dir,
      name: path.basename(dir),
      created_at: new Date().toISOString(),
    } as never);
    const folderId = folderResult.insertedId;

    // Start discover so we verify the module boots without errors.
    // folderId is now resolved per-event from the registered folders collection.
    discoverHandle = await startDiscover({ roots: [dir] });

    // Write a file so stat() inside handleEvent succeeds.
    const file = path.join(dir, 'test.jpg');
    await writeFile(file, Buffer.alloc(100, 0xcc));

    // Directly invoke handleEvent to bypass chokidar's polling interval
    // (60 s / 300 s in production — unusable in a unit test).
    await handleEvent({ kind: 'created', absPath: file }, folderId, dir);

    // The doc should now be in the assets collection.
    const coll = await assetsCollection();
    const filename = path.basename(file);
    const raw = await coll.findOne({
      fileinfo: { $elemMatch: { library_id: folderId, filename } },
    });
    const doc = raw as unknown as { stages?: Record<string, unknown> } | null;

    expect(doc).not.toBeNull();
    expect(doc!.stages).toBeDefined();

    // Every stage name from the manifest must be present in the skeleton.
    // The legacy `hash` stage was retired in the drop-abs-path-2026-05-21
    // migration once discover began writing maple_id + sha1_head inline at
    // insert; the manifest now starts with exif.
    for (const name of ALL_STAGE_NAMES) {
      const entry = (doc!.stages as Record<string, unknown>)[name] as Record<string, unknown>;
      expect(entry).toBeDefined();
      expect(entry.version).toBe(0);
      expect(entry.dead).toBe(false);
      expect(entry.last_error).toBeNull();
    }

    // Clean up: remove the test folder and asset rows.
    await foldersColl.deleteOne({ _id: folderId });
    await coll.deleteOne({ fileinfo: { $elemMatch: { library_id: folderId, filename } } } as never);
  });

  it('soft-deletes a doc when a removed event is received', async () => {
    if (!mongoReachable) return;

    const { handleEvent } = await import('./index.ts');
    const { assetsCollection, foldersCollection } = await import('../../db/client.ts');

    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'discover-del-'));
    const file = path.join(tempDir, 'todelete.jpg');
    await writeFile(file, Buffer.alloc(50, 0xaa));

    const foldersColl = await foldersCollection();
    const folderResult = await foldersColl.insertOne({
      path: tempDir,
      label: path.basename(tempDir),
      last_scan: null,
      file_count: 0,
      created_at: new Date().toISOString(),
    } as never);
    const folderId = folderResult.insertedId;

    // Insert via created event first.
    await handleEvent({ kind: 'created', absPath: file }, folderId, tempDir);
    const coll = await assetsCollection();
    const filename = path.basename(file);
    const filter = {
      fileinfo: { $elemMatch: { library_id: folderId, filename } },
    } as never;
    const before = await coll.findOne(filter);
    expect(before).not.toBeNull();
    expect((before as Record<string, unknown>).deleted_at).toBeNull();

    // Now fire the removed event.
    await handleEvent({ kind: 'removed', absPath: file }, folderId, tempDir);
    const after = await coll.findOne(filter);
    expect(after).not.toBeNull();
    expect((after as Record<string, unknown>).deleted_at).not.toBeNull();

    // Clean up.
    await coll.deleteOne(filter);
    await foldersColl.deleteOne({ _id: folderId });
    await rm(tempDir, { recursive: true, force: true });
  });

  it('$setOnInsert preserves existing stage progress on re-discover', async () => {
    if (!mongoReachable) return;

    const { handleEvent } = await import('./index.ts');
    const { assetsCollection, foldersCollection } = await import('../../db/client.ts');

    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'discover-rescan-'));
    const file = path.join(tempDir, 'photo.jpg');
    await writeFile(file, Buffer.alloc(200, 0xbb));

    const foldersColl = await foldersCollection();
    const folderResult = await foldersColl.insertOne({
      abs_path: tempDir,
      name: path.basename(tempDir),
      created_at: new Date().toISOString(),
    } as never);
    const folderId = folderResult.insertedId;
    const coll = await assetsCollection();

    // First discover — inserts with skeleton (all stages start at 0).
    await handleEvent({ kind: 'created', absPath: file }, folderId, tempDir);
    // Simulate a stage completing by bumping exif.version to 1.
    const filename = path.basename(file);
    const matchFilter = {
      fileinfo: { $elemMatch: { library_id: folderId, filename } },
    } as never;
    await coll.updateOne(matchFilter, { $set: { 'stages.exif.version': 1 } });

    // Re-discover (modified event) — must not reset exif back to 0.
    await handleEvent({ kind: 'modified', absPath: file }, folderId, tempDir);
    const raw = await coll.findOne(matchFilter);
    const doc = raw as unknown as { stages?: Record<string, { version: number }> } | null;
    expect(doc).not.toBeNull();
    const stages = doc!.stages as Record<string, { version: number }>;
    expect(stages.exif.version).toBe(1); // preserved by $setOnInsert

    // Clean up.
    await coll.deleteOne(matchFilter);
    await foldersColl.deleteOne({ _id: folderId });
    await rm(tempDir, { recursive: true, force: true });
  });

  it('emits asset_changes rows on create / modify / rename / soft-delete', async () => {
    if (!mongoReachable) return;

    const { handleEvent } = await import('./index.ts');
    const { assetsCollection, foldersCollection, assetChangesCollection } =
      await import('../../db/client.ts');

    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'discover-changes-'));
    const file = path.join(tempDir, 'feed.jpg');
    await writeFile(file, Buffer.alloc(64, 0x33));

    const foldersColl = await foldersCollection();
    const folderResult = await foldersColl.insertOne({
      abs_path: tempDir,
      name: path.basename(tempDir),
      created_at: new Date().toISOString(),
    } as never);
    const folderId = folderResult.insertedId;
    const coll = await assetsCollection();
    const changesColl = await assetChangesCollection();
    await changesColl.deleteMany({});

    // create → expect a "create" change row.
    await handleEvent({ kind: 'created', absPath: file }, folderId, tempDir);
    let rows = await changesColl.find({ abs_path: file }).sort({ cursor: 1 }).toArray();
    expect(rows.length).toBe(1);
    expect(rows[0]!.kind).toBe('create');

    // modify → "update"
    await handleEvent({ kind: 'modified', absPath: file }, folderId, tempDir);
    rows = await changesColl.find({ abs_path: file }).sort({ cursor: 1 }).toArray();
    expect(rows.length).toBe(2);
    expect(rows[1]!.kind).toBe('update');

    // rename — give chokidar a new path
    const newPath = path.join(tempDir, 'feed-renamed.jpg');
    await writeFile(newPath, Buffer.alloc(64, 0x33));
    await handleEvent({ kind: 'renamed', absPath: newPath, fromPath: file }, folderId, tempDir);
    const renamedRows = await changesColl.find({ abs_path: newPath }).sort({ cursor: 1 }).toArray();
    expect(renamedRows.length).toBe(1);
    expect(renamedRows[0]!.kind).toBe('update');

    // soft-delete → "delete"
    await handleEvent({ kind: 'removed', absPath: newPath }, folderId, tempDir);
    const deleted = await changesColl.find({ abs_path: newPath, kind: 'delete' }).toArray();
    expect(deleted.length).toBe(1);

    // Clean up.
    await coll.deleteMany({ folder_id: folderId });
    await changesColl.deleteMany({ folder_id: folderId });
    await foldersColl.deleteOne({ _id: folderId });
    await rm(tempDir, { recursive: true, force: true });
  });

  it('does not collide on shared basename across subdirectories', async () => {
    if (!mongoReachable) return;

    const { handleEvent } = await import('./index.ts');
    const { assetsCollection, foldersCollection } = await import('../../db/client.ts');
    const { mkdir } = await import('node:fs/promises');

    // Same library, two subdirectories with the same basename. Used to be
    // forbidden by the (folder_id, filename) unique index; that index was
    // dropped — content dedup happens via the unique `maple_id` index in
    // PR 2 of the content-addressing migration. This test pins the
    // current behaviour: per-path rows, no collision on filename alone.
    const root = await mkdtemp(path.join(os.tmpdir(), 'discover-coll-'));
    const dir2024 = path.join(root, '2024');
    const dir2025 = path.join(root, '2025');
    await mkdir(dir2024, { recursive: true });
    await mkdir(dir2025, { recursive: true });
    const file2024 = path.join(dir2024, 'IMG_0001.DNG');
    const file2025 = path.join(dir2025, 'IMG_0001.DNG');
    await writeFile(file2024, Buffer.alloc(100, 0x11));
    await writeFile(file2025, Buffer.alloc(100, 0x22));

    const foldersColl = await foldersCollection();
    const folderResult = await foldersColl.insertOne({
      path: root,
      label: 'collision-test-folder',
      last_scan: null,
      file_count: 0,
      created_at: new Date().toISOString(),
    } as never);
    const folderId = folderResult.insertedId;

    const coll = await assetsCollection();

    // Insert two docs that share a basename but have different absolute paths.
    await handleEvent({ kind: 'created', absPath: file2024 }, folderId, root);
    await handleEvent({ kind: 'created', absPath: file2025 }, folderId, root);

    const docs = await coll
      .find({
        fileinfo: { $elemMatch: { library_id: folderId, filename: 'IMG_0001.DNG' } },
      } as never)
      .toArray();
    expect(docs.length).toBe(2);
    const paths = docs
      .map(
        (d) =>
          (d.fileinfo?.[0]?.path === ''
            ? d.fileinfo[0]!.filename
            : `${d.fileinfo?.[0]?.path}/${d.fileinfo?.[0]?.filename}`) as string,
      )
      .sort();
    expect(paths).toEqual(['2024/IMG_0001.DNG', '2025/IMG_0001.DNG'].sort());

    // Clean up.
    await coll.deleteMany({
      fileinfo: { $elemMatch: { library_id: folderId, filename: 'IMG_0001.DNG' } },
    } as never);
    await foldersColl.deleteOne({ _id: folderId });
    await rm(root, { recursive: true, force: true });
  });

  it('writes fileinfo[0] with path-relative-to-library on insert', async () => {
    if (!mongoReachable) return;

    const { handleEvent } = await import('./index.ts');
    const { assetsCollection, foldersCollection } = await import('../../db/client.ts');

    const root = await mkdtemp(path.join(os.tmpdir(), 'discover-fi-'));
    const sub = path.join(root, 'vacation', '2024');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(sub, { recursive: true });
    const file = path.join(sub, 'IMG_001.dng');
    await writeFile(file, Buffer.alloc(100, 0xdd));

    const foldersColl = await foldersCollection();
    const folderResult = await foldersColl.insertOne({
      path: root,
      label: path.basename(root),
      last_scan: null,
      file_count: 0,
      created_at: new Date().toISOString(),
    } as never);
    const folderId = folderResult.insertedId;

    await handleEvent({ kind: 'created', absPath: file }, folderId, root);

    const coll = await assetsCollection();
    const doc = await coll.findOne({
      fileinfo: { $elemMatch: { library_id: folderId, filename: 'IMG_001.dng' } },
    } as never);
    expect(doc).not.toBeNull();
    expect(doc!.fileinfo).toHaveLength(1);
    expect(doc!.fileinfo![0]!.path).toBe(path.join('vacation', '2024'));
    expect(doc!.fileinfo![0]!.filename).toBe('IMG_001.dng');
    expect(doc!.fileinfo![0]!.library_id.equals(folderId)).toBe(true);

    await coll.deleteOne({ _id: doc!._id });
    await foldersColl.deleteOne({ _id: folderId });
    await rm(root, { recursive: true, force: true });
  });

  it("fileinfo[0].path is '' for files at the library root", async () => {
    if (!mongoReachable) return;

    const { handleEvent } = await import('./index.ts');
    const { assetsCollection, foldersCollection } = await import('../../db/client.ts');

    const root = await mkdtemp(path.join(os.tmpdir(), 'discover-fi-root-'));
    const file = path.join(root, 'top.jpg');
    await writeFile(file, Buffer.alloc(50, 0xee));

    const foldersColl = await foldersCollection();
    const folderResult = await foldersColl.insertOne({
      path: root,
      label: path.basename(root),
      last_scan: null,
      file_count: 0,
      created_at: new Date().toISOString(),
    } as never);
    const folderId = folderResult.insertedId;

    await handleEvent({ kind: 'created', absPath: file }, folderId, root);

    const coll = await assetsCollection();
    const doc = await coll.findOne({
      fileinfo: { $elemMatch: { library_id: folderId, filename: 'top.jpg' } },
    } as never);
    expect(doc).not.toBeNull();
    expect(doc!.fileinfo![0]!.path).toBe('');
    expect(doc!.fileinfo![0]!.filename).toBe('top.jpg');

    await coll.deleteOne({ _id: doc!._id });
    await foldersColl.deleteOne({ _id: folderId });
    await rm(root, { recursive: true, force: true });
  });

  it('rename updates fileinfo[0] (still one entry — rename is not a new location)', async () => {
    if (!mongoReachable) return;

    const { handleEvent } = await import('./index.ts');
    const { assetsCollection, foldersCollection } = await import('../../db/client.ts');

    const root = await mkdtemp(path.join(os.tmpdir(), 'discover-fi-rename-'));
    const { mkdir, rename: fsRename } = await import('node:fs/promises');
    const dirA = path.join(root, 'a');
    const dirB = path.join(root, 'b');
    await mkdir(dirA, { recursive: true });
    await mkdir(dirB, { recursive: true });
    const before = path.join(dirA, 'x.dng');
    const after = path.join(dirB, 'x.dng');
    await writeFile(before, Buffer.alloc(50, 0xff));

    const foldersColl = await foldersCollection();
    const folderResult = await foldersColl.insertOne({
      path: root,
      label: path.basename(root),
      last_scan: null,
      file_count: 0,
      created_at: new Date().toISOString(),
    } as never);
    const folderId = folderResult.insertedId;

    await handleEvent({ kind: 'created', absPath: before }, folderId, root);
    await fsRename(before, after);
    await handleEvent({ kind: 'renamed', absPath: after, fromPath: before }, folderId, root);

    const coll = await assetsCollection();
    const doc = await coll.findOne({
      fileinfo: { $elemMatch: { library_id: folderId, path: 'b', filename: 'x.dng' } },
    } as never);
    expect(doc).not.toBeNull();
    expect(doc!.fileinfo).toHaveLength(1);
    expect(doc!.fileinfo![0]!.path).toBe('b');
    expect(doc!.fileinfo![0]!.filename).toBe('x.dng');

    await coll.deleteOne({ _id: doc!._id });
    await foldersColl.deleteOne({ _id: folderId });
    await rm(root, { recursive: true, force: true });
  });

  // ─── PR 2: hash on discover + dedup by maple_id ─────────────────────────

  it('dedups two files with identical content into one row with two fileinfo entries', async () => {
    if (!mongoReachable) return;

    const { handleEvent } = await import('./index.ts');
    const { assetsCollection, foldersCollection } = await import('../../db/client.ts');
    const { mkdir } = await import('node:fs/promises');

    const root = await mkdtemp(path.join(os.tmpdir(), 'discover-dedup-'));
    const dirA = path.join(root, 'a');
    const dirB = path.join(root, 'b');
    await mkdir(dirA, { recursive: true });
    await mkdir(dirB, { recursive: true });
    const fileA = path.join(dirA, 'IMG.dng');
    const fileB = path.join(dirB, 'IMG.dng');
    // Byte-identical content → same maple_id.
    const bytes = Buffer.alloc(70 * 1024, 0xab);
    await writeFile(fileA, bytes);
    await writeFile(fileB, bytes);

    const foldersColl = await foldersCollection();
    const folderResult = await foldersColl.insertOne({
      path: root,
      label: 'dedup-test',
      last_scan: null,
      file_count: 0,
      created_at: new Date().toISOString(),
    } as never);
    const folderId = folderResult.insertedId;
    const coll = await assetsCollection();
    // Wipe any previous run's row at this maple_id.
    const { hashFileForId } = await import('../../indexer/id.ts');
    const { maple_id } = await hashFileForId(fileA);
    await coll.deleteMany({ maple_id });

    await handleEvent({ kind: 'created', absPath: fileA }, folderId, root);
    await handleEvent({ kind: 'created', absPath: fileB }, folderId, root);

    const rows = await coll.find({ maple_id }).toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.fileinfo).toHaveLength(2);
    const entries = (rows[0]!.fileinfo ?? []).map((e: any) => `${e.path}/${e.filename}`).sort();
    expect(entries).toEqual(['a/IMG.dng', 'b/IMG.dng']);
    expect(rows[0]!.maple_id).toMatch(/^[0-9a-f]{32}$/);

    await coll.deleteMany({ maple_id });
    await foldersColl.deleteOne({ _id: folderId });
    await rm(root, { recursive: true, force: true });
  });

  it('re-discovering the same path is idempotent — no duplicate fileinfo entries', async () => {
    if (!mongoReachable) return;

    const { handleEvent } = await import('./index.ts');
    const { assetsCollection, foldersCollection } = await import('../../db/client.ts');

    const root = await mkdtemp(path.join(os.tmpdir(), 'discover-idem-'));
    const file = path.join(root, 'x.jpg');
    await writeFile(file, Buffer.alloc(80 * 1024, 0xcd));

    const foldersColl = await foldersCollection();
    const folderResult = await foldersColl.insertOne({
      path: root,
      label: 'idem-test',
      last_scan: null,
      file_count: 0,
      created_at: new Date().toISOString(),
    } as never);
    const folderId = folderResult.insertedId;
    const coll = await assetsCollection();
    const { hashFileForId } = await import('../../indexer/id.ts');
    const { maple_id } = await hashFileForId(file);
    await coll.deleteMany({ maple_id });

    // Two events for the same (library, path) — modify after create.
    await handleEvent({ kind: 'created', absPath: file }, folderId, root);
    await handleEvent({ kind: 'modified', absPath: file }, folderId, root);

    const rows = await coll.find({ maple_id }).toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.fileinfo).toHaveLength(1);

    await coll.deleteMany({ maple_id });
    await foldersColl.deleteOne({ _id: folderId });
    await rm(root, { recursive: true, force: true });
  });

  it("modified file with new content marks old row's fileinfo entry deleted", async () => {
    if (!mongoReachable) return;

    const { handleEvent } = await import('./index.ts');
    const { assetsCollection, foldersCollection } = await import('../../db/client.ts');

    const root = await mkdtemp(path.join(os.tmpdir(), 'discover-modnew-'));
    const file = path.join(root, 'shifty.jpg');
    // Write original content, discover, then OVERWRITE with different bytes.
    const oldContent = Buffer.alloc(80 * 1024, 0x11);
    const newContent = Buffer.alloc(80 * 1024, 0x99);
    await writeFile(file, oldContent);

    const foldersColl = await foldersCollection();
    const folderResult = await foldersColl.insertOne({
      path: root,
      label: 'mod-new-content',
      last_scan: null,
      file_count: 0,
      created_at: new Date().toISOString(),
    } as never);
    const folderId = folderResult.insertedId;
    const coll = await assetsCollection();
    const { hashFileForId } = await import('../../indexer/id.ts');
    const oldHashed = await hashFileForId(file);
    await coll.deleteMany({ maple_id: { $in: [oldHashed.maple_id] } });

    await handleEvent({ kind: 'created', absPath: file }, folderId, root);
    // Replace file with different content → different maple_id.
    await writeFile(file, newContent);
    const newHashed = await hashFileForId(file);
    expect(newHashed.maple_id).not.toBe(oldHashed.maple_id);

    await handleEvent({ kind: 'modified', absPath: file }, folderId, root);

    // Old row should still exist (originals are sacred — soft-delete only),
    // with its fileinfo entry at this location marked deleted.
    const oldRow = await coll.findOne({ maple_id: oldHashed.maple_id });
    expect(oldRow).not.toBeNull();
    const oldEntry = (oldRow!.fileinfo ?? []).find(
      (e: any) => e.library_id.equals(folderId) && e.path === '' && e.filename === 'shifty.jpg',
    );
    expect(oldEntry).toBeDefined();
    expect(oldEntry!.deleted_at).not.toBeNull();

    // New row exists with the new maple_id and a live fileinfo entry.
    const newRow = await coll.findOne({ maple_id: newHashed.maple_id });
    expect(newRow).not.toBeNull();
    expect(newRow!.maple_id).toBe(newHashed.maple_id);
    expect(newRow!.fileinfo).toHaveLength(1);
    expect((newRow!.fileinfo![0] as any).filename).toBe('shifty.jpg');
    expect((newRow!.fileinfo![0] as any).deleted_at ?? null).toBeNull();

    await coll.deleteMany({ maple_id: { $in: [oldHashed.maple_id, newHashed.maple_id] } });
    await foldersColl.deleteOne({ _id: folderId });
    await rm(root, { recursive: true, force: true });
  });

  it('concurrent dedup-append: race-loser becomes a silent no-op', async () => {
    if (!mongoReachable) return;

    // Two worker calls process the SAME event simultaneously. Both read
    // the existing row, both see dupIdx === -1 against the same stale
    // snapshot, both attempt to $push the same fileinfo entry. The
    // conditional $push (filter: no entry already matches) must ensure
    // exactly one append wins — the other becomes a no-op (modifiedCount
    // === 0). Fileinfo length stays at exactly 2 (the existing entry +
    // the one new one), not 3.
    const { handleEvent } = await import('./index.ts');
    const { assetsCollection, foldersCollection } = await import('../../db/client.ts');
    const { mkdir } = await import('node:fs/promises');

    const root = await mkdtemp(path.join(os.tmpdir(), 'discover-race-'));
    const dirA = path.join(root, 'a');
    const dirB = path.join(root, 'b');
    await mkdir(dirA, { recursive: true });
    await mkdir(dirB, { recursive: true });
    const fileA = path.join(dirA, 'IMG.dng');
    const fileB = path.join(dirB, 'IMG.dng');
    const bytes = Buffer.alloc(70 * 1024, 0x77);
    await writeFile(fileA, bytes);
    await writeFile(fileB, bytes);

    const foldersColl = await foldersCollection();
    const folderResult = await foldersColl.insertOne({
      path: root,
      label: 'race-test',
      last_scan: null,
      file_count: 0,
      created_at: new Date().toISOString(),
    } as never);
    const folderId = folderResult.insertedId;
    const coll = await assetsCollection();
    const { hashFileForId } = await import('../../indexer/id.ts');
    const { maple_id } = await hashFileForId(fileA);
    await coll.deleteMany({ maple_id });

    // First event lands the row with fileinfo[fileA].
    await handleEvent({ kind: 'created', absPath: fileA }, folderId, root);

    // Two concurrent appends for fileB — race them so both see dupIdx === -1.
    await Promise.all([
      handleEvent({ kind: 'created', absPath: fileB }, folderId, root),
      handleEvent({ kind: 'created', absPath: fileB }, folderId, root),
    ]);

    const rows = await coll.find({ maple_id }).toArray();
    expect(rows).toHaveLength(1);
    const entries = (rows[0]!.fileinfo ?? []).map((e: any) => `${e.path}/${e.filename}`).sort();
    expect(entries).toEqual(['a/IMG.dng', 'b/IMG.dng']);

    await coll.deleteMany({ maple_id });
    await foldersColl.deleteOne({ _id: folderId });
    await rm(root, { recursive: true, force: true });
  });

  it('insert path populates maple_id directly (no post-insert hash stage needed)', async () => {
    if (!mongoReachable) return;

    const { handleEvent } = await import('./index.ts');
    const { assetsCollection, foldersCollection } = await import('../../db/client.ts');

    const root = await mkdtemp(path.join(os.tmpdir(), 'discover-mid-'));
    const file = path.join(root, 'y.jpg');
    await writeFile(file, Buffer.alloc(50 * 1024, 0xef));

    const foldersColl = await foldersCollection();
    const folderResult = await foldersColl.insertOne({
      path: root,
      label: 'maple-id-test',
      last_scan: null,
      file_count: 0,
      created_at: new Date().toISOString(),
    } as never);
    const folderId = folderResult.insertedId;
    const coll = await assetsCollection();
    const { hashFileForId } = await import('../../indexer/id.ts');
    const expected = await hashFileForId(file);
    await coll.deleteMany({ maple_id: expected.maple_id });

    await handleEvent({ kind: 'created', absPath: file }, folderId, root);

    const doc = await coll.findOne({ maple_id: expected.maple_id });
    expect(doc).not.toBeNull();
    expect(doc!.maple_id).toBe(expected.maple_id);
    expect((doc as any).sha1_head).toBe(expected.sha1_head);
    expect(doc!.size).toBe(expected.size);

    await coll.deleteMany({ maple_id: expected.maple_id });
    await foldersColl.deleteOne({ _id: folderId });
    await rm(root, { recursive: true, force: true });
  });
});

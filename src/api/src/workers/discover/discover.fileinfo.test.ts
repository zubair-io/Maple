/**
 * Discover producer — fileinfo[] tests.
 *
 * Split from the original discover.test.ts (#251). Covers the
 * library-relative path semantics for fileinfo entries: same basename
 * across subdirectories, vacation/2024 nesting, root-level files (empty
 * path), and renames updating fileinfo in place.
 *
 * Requires: MAPLE_MONGO_URI (or a local MongoDB on localhost:27017).
 * Skips gracefully when Mongo is unreachable.
 */
import { describe, expect, it, beforeAll, afterAll } from 'bun:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import type { MongoClient } from 'mongodb';
import { type Db } from 'mongodb';
import * as os from 'node:os';
import * as path from 'node:path';
import { tryConnect } from './_test-helpers.ts';

const TEST_DB = `maple_test_discover_fileinfo_${process.pid}`;
process.env.MAPLE_MONGO_DB = TEST_DB;

let mongo: MongoClient | null = null;
let mongoReachable = false;
let db: Db | null = null;

beforeAll(async () => {
  mongo = await tryConnect();
  mongoReachable = mongo !== null;
  if (!mongoReachable) {
    console.log('[discover.fileinfo.test] skipping: MongoDB unreachable');
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

describe('discover producer — fileinfo', () => {
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

  it('records keep:true on the fileinfo entry when a `.keep` marker is in the folder', async () => {
    if (!mongoReachable) return;

    const { handleEvent } = await import('./index.ts');
    const { assetsCollection, foldersCollection } = await import('../../db/client.ts');
    const { mkdir } = await import('node:fs/promises');

    const root = await mkdtemp(path.join(os.tmpdir(), 'discover-keep-'));
    const pinned = path.join(root, 'pinned');
    const loose = path.join(root, 'loose');
    await mkdir(pinned, { recursive: true });
    await mkdir(loose, { recursive: true });
    // Marker in the pinned folder only.
    await writeFile(path.join(pinned, '.keep'), '');
    const pinnedFile = path.join(pinned, 'A.dng');
    const looseFile = path.join(loose, 'B.dng');
    await writeFile(pinnedFile, Buffer.alloc(64, 0x01));
    await writeFile(looseFile, Buffer.alloc(64, 0x02));

    const foldersColl = await foldersCollection();
    const folderResult = await foldersColl.insertOne({
      path: root,
      label: path.basename(root),
      last_scan: null,
      file_count: 0,
      created_at: new Date().toISOString(),
    } as never);
    const folderId = folderResult.insertedId;

    await handleEvent({ kind: 'created', absPath: pinnedFile }, folderId, root);
    await handleEvent({ kind: 'created', absPath: looseFile }, folderId, root);

    const coll = await assetsCollection();
    const pinnedDoc = await coll.findOne({
      fileinfo: { $elemMatch: { library_id: folderId, filename: 'A.dng' } },
    } as never);
    const looseDoc = await coll.findOne({
      fileinfo: { $elemMatch: { library_id: folderId, filename: 'B.dng' } },
    } as never);
    expect(pinnedDoc!.fileinfo![0]!.keep).toBe(true);
    expect(looseDoc!.fileinfo![0]!.keep).toBe(false);

    await coll.deleteMany({ fileinfo: { $elemMatch: { library_id: folderId } } } as never);
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
});

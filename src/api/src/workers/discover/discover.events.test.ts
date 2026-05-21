/**
 * Discover producer — event-stream tests.
 *
 * Split from the original discover.test.ts (#251). Covers the
 * removed-event soft-delete path and the `asset_changes` feed emitted
 * on create / modify / rename / delete.
 *
 * Requires: MAPLE_MONGO_URI (or a local MongoDB on localhost:27017).
 * Skips gracefully when Mongo is unreachable.
 */
import { describe, expect, it, beforeAll, afterAll } from 'bun:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { MongoClient, type Db } from 'mongodb';
import * as os from 'node:os';
import * as path from 'node:path';
import { tryConnect } from './_test-helpers.ts';

const TEST_DB = `maple_test_discover_events_${process.pid}`;
process.env.MAPLE_MONGO_DB = TEST_DB;

let mongo: MongoClient | null = null;
let mongoReachable = false;
let db: Db | null = null;

beforeAll(async () => {
  mongo = await tryConnect();
  mongoReachable = mongo !== null;
  if (!mongoReachable) {
    console.log('[discover.events.test] skipping: MongoDB unreachable');
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

describe('discover producer — events', () => {
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
});

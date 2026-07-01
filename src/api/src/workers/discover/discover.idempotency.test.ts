/**
 * Discover producer — idempotency tests.
 *
 * Split from the original discover.test.ts (#251). Verifies that
 * `$setOnInsert` preserves existing stage progress on re-discover, and
 * that re-discovering the same path is idempotent (no duplicate
 * fileinfo entries).
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

const TEST_DB = `maple_test_discover_idem_${process.pid}`;
process.env.MAPLE_MONGO_DB = TEST_DB;

let mongo: MongoClient | null = null;
let mongoReachable = false;
let db: Db | null = null;

beforeAll(async () => {
  mongo = await tryConnect();
  mongoReachable = mongo !== null;
  if (!mongoReachable) {
    console.log('[discover.idempotency.test] skipping: MongoDB unreachable');
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

describe('discover producer — idempotency', () => {
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
});

/**
 * Discover producer — stages-skeleton + module-boot tests.
 *
 * Split from the original discover.test.ts (#251). Verifies the inserted
 * doc carries the full stages skeleton from `ALL_STAGE_NAMES`, and that
 * `startDiscover` boots without error.
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
import { ALL_STAGE_NAMES } from '../stages/manifest.ts';
import { tryConnect } from './_test-helpers.ts';

const TEST_DB = `maple_test_discover_skeleton_${process.pid}`;
process.env.MAPLE_MONGO_DB = TEST_DB;

let mongo: MongoClient | null = null;
let mongoReachable = false;
let db: Db | null = null;

beforeAll(async () => {
  mongo = await tryConnect();
  mongoReachable = mongo !== null;
  if (!mongoReachable) {
    console.log('[discover.skeleton.test] skipping: MongoDB unreachable');
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

describe('discover producer — skeleton', () => {
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
    // The FolderDoc schema uses `path` (not `abs_path`) for the library root.
    const { foldersCollection, assetsCollection } = await import('../../db/client.ts');
    const foldersColl = await foldersCollection();
    const folderResult = await foldersColl.insertOne({
      path: dir,
      label: path.basename(dir),
      last_scan: null,
      file_count: 0,
      created_at: new Date().toISOString(),
    } as never);
    const folderId = folderResult.insertedId;

    // Start discover so we verify the module boots without errors.
    // folderId is now resolved per-root from the registered folders collection.
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
});

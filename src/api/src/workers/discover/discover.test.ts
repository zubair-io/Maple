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
import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { MongoClient, ObjectId, type Db } from "mongodb";
import * as os from "node:os";
import * as path from "node:path";
import { ALL_STAGE_NAMES } from "../stages/manifest.ts";

const TEST_DB = `maple_test_discover_${process.pid}`;
process.env.MAPLE_MONGO_DB = TEST_DB;
const MONGO_URI = process.env.MAPLE_MONGO_URI ?? "mongodb://localhost:27017";

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
    await c.db("admin").command({ ping: 1 });
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
    console.log("[discover.test] skipping: MongoDB unreachable");
    return;
  }
  db = mongo!.db(TEST_DB);
  await db.dropDatabase();
  const { closeDb } = await import("../../db/client.ts");
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
  const { closeDb } = await import("../../db/client.ts");
  await closeDb();
});

describe("discover producer", () => {
  let dir: string;
  let discoverHandle: { stop: () => Promise<void> } | null = null;

  afterAll(async () => {
    if (discoverHandle) await discoverHandle.stop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("inserts a doc with the full stages skeleton when a file is created", async () => {
    if (!mongoReachable) return;

    dir = await mkdtemp(path.join(os.tmpdir(), "discover-test-"));

    // Import the discover module.
    const { startDiscover, handleEvent } = await import("./index.ts");

    // Create a temporary folder row in the DB so discover can reference it.
    const { foldersCollection, assetsCollection } = await import("../../db/client.ts");
    const foldersColl = await foldersCollection();
    const folderResult = await foldersColl.insertOne({
      abs_path: dir,
      name: path.basename(dir),
      created_at: new Date().toISOString(),
    } as never);
    const folderId = folderResult.insertedId;
    const folderIdHex = folderId.toHexString();

    // Start discover so we verify the module boots without errors.
    discoverHandle = await startDiscover({ roots: [dir], folderId: folderIdHex });

    // Write a file so stat() inside handleEvent succeeds.
    const file = path.join(dir, "test.jpg");
    await writeFile(file, Buffer.alloc(100, 0xcc));

    // Directly invoke handleEvent to bypass chokidar's polling interval
    // (60 s / 300 s in production — unusable in a unit test).
    await handleEvent({ kind: "created", absPath: file }, folderId);

    // The doc should now be in the assets collection.
    const coll = await assetsCollection();
    const doc = await coll.findOne({ abs_path: file });

    expect(doc).not.toBeNull();
    expect(doc!.stages).toBeDefined();

    // Every stage name from the manifest must be present in the skeleton.
    for (const name of ALL_STAGE_NAMES) {
      const entry = (doc!.stages as Record<string, unknown>)[name] as Record<string, unknown>;
      expect(entry).toBeDefined();
      expect(entry.version).toBe(0);
      expect(entry.dead).toBe(false);
      expect(entry.last_error).toBeNull();
    }

    // Clean up: remove the test folder and asset rows.
    await foldersColl.deleteOne({ _id: folderId });
    await coll.deleteOne({ abs_path: file });
  });

  it("soft-deletes a doc when a removed event is received", async () => {
    if (!mongoReachable) return;

    const { handleEvent } = await import("./index.ts");
    const { assetsCollection, foldersCollection } = await import("../../db/client.ts");

    const tempDir = await mkdtemp(path.join(os.tmpdir(), "discover-del-"));
    const file = path.join(tempDir, "todelete.jpg");
    await writeFile(file, Buffer.alloc(50, 0xaa));

    const foldersColl = await foldersCollection();
    const folderResult = await foldersColl.insertOne({
      abs_path: tempDir,
      name: path.basename(tempDir),
      created_at: new Date().toISOString(),
    } as never);
    const folderId = folderResult.insertedId;

    // Insert via created event first.
    await handleEvent({ kind: "created", absPath: file }, folderId);
    const coll = await assetsCollection();
    const before = await coll.findOne({ abs_path: file });
    expect(before).not.toBeNull();
    expect((before as Record<string, unknown>).deleted_at).toBeNull();

    // Now fire the removed event.
    await handleEvent({ kind: "removed", absPath: file }, folderId);
    const after = await coll.findOne({ abs_path: file });
    expect(after).not.toBeNull();
    expect((after as Record<string, unknown>).deleted_at).not.toBeNull();

    // Clean up.
    await coll.deleteOne({ abs_path: file });
    await foldersColl.deleteOne({ _id: folderId });
    await rm(tempDir, { recursive: true, force: true });
  });

  it("$setOnInsert preserves existing stage progress on re-discover", async () => {
    if (!mongoReachable) return;

    const { handleEvent } = await import("./index.ts");
    const { assetsCollection, foldersCollection } = await import("../../db/client.ts");

    const tempDir = await mkdtemp(path.join(os.tmpdir(), "discover-rescan-"));
    const file = path.join(tempDir, "photo.jpg");
    await writeFile(file, Buffer.alloc(200, 0xbb));

    const foldersColl = await foldersCollection();
    const folderResult = await foldersColl.insertOne({
      abs_path: tempDir,
      name: path.basename(tempDir),
      created_at: new Date().toISOString(),
    } as never);
    const folderId = folderResult.insertedId;
    const coll = await assetsCollection();

    // First discover — inserts with skeleton (all version: 0).
    await handleEvent({ kind: "created", absPath: file }, folderId);
    // Simulate hash stage completing: bump stages.hash.version to 1.
    await coll.updateOne(
      { abs_path: file },
      { $set: { "stages.hash.version": 1 } },
    );

    // Re-discover (modified event) — must not reset hash back to 0.
    await handleEvent({ kind: "modified", absPath: file }, folderId);
    const doc = await coll.findOne({ abs_path: file });
    expect(doc).not.toBeNull();
    const stages = (doc!.stages as Record<string, { version: number }>);
    expect(stages.hash.version).toBe(1); // preserved by $setOnInsert

    // Clean up.
    await coll.deleteOne({ abs_path: file });
    await foldersColl.deleteOne({ _id: folderId });
    await rm(tempDir, { recursive: true, force: true });
  });

  it("does not collide on shared basename across folders", async () => {
    if (!mongoReachable) return;

    const { handleEvent } = await import("./index.ts");
    const { assetsCollection, foldersCollection } = await import("../../db/client.ts");

    // Create two real tmp dirs so stat() inside handleEvent succeeds for both paths.
    const dir2024 = await mkdtemp(path.join(os.tmpdir(), "discover-coll-2024-"));
    const dir2025 = await mkdtemp(path.join(os.tmpdir(), "discover-coll-2025-"));
    const file2024 = path.join(dir2024, "IMG_0001.DNG");
    const file2025 = path.join(dir2025, "IMG_0001.DNG");
    await writeFile(file2024, Buffer.alloc(100, 0x11));
    await writeFile(file2025, Buffer.alloc(100, 0x22));

    const foldersColl = await foldersCollection();
    const folderResult = await foldersColl.insertOne({
      abs_path: dir2024,
      name: "collision-test-folder",
      created_at: new Date().toISOString(),
    } as never);
    const folderId = folderResult.insertedId;

    const coll = await assetsCollection();

    // Insert two docs that share a basename but have different absolute paths.
    await handleEvent({ kind: "created", absPath: file2024 }, folderId);
    await handleEvent({ kind: "created", absPath: file2025 }, folderId);

    const docs = await coll.find({ filename: "IMG_0001.DNG" }).toArray();
    expect(docs.length).toBe(2);
    const paths = docs.map((d) => (d as Record<string, unknown>).abs_path as string).sort();
    expect(paths).toEqual([file2024, file2025].sort());

    // Clean up.
    await coll.deleteMany({ filename: "IMG_0001.DNG" });
    await foldersColl.deleteOne({ _id: folderId });
    await rm(dir2024, { recursive: true, force: true });
    await rm(dir2025, { recursive: true, force: true });
  });
});

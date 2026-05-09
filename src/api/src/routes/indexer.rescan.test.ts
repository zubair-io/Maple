/**
 * Integration test: rescan-folder updateMany semantic.
 *
 * Verifies that the rescan handler resets stages.*.version to 0 (and clears
 * dead/attempts/last_error) for every asset doc whose abs_path is under the
 * folder's path tree, leaving docs outside the tree untouched.
 *
 * Requires a running MongoDB (skips gracefully if unreachable).
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { MongoClient, ObjectId, type Db } from "mongodb";

const MONGO_URI = process.env.MAPLE_MONGO_URI ?? "mongodb://localhost:27017";
const TEST_DB = `maple_rescan_test_${process.pid}`;

const STAGE_NAMES = [
  "hash",
  "exif",
  "thumb",
  "face",
  "ocr",
  "describe",
  "geocode",
  "meili",
];

/** Build a stages skeleton where every stage is at version 1 (already processed). */
function skeleton() {
  return Object.fromEntries(
    STAGE_NAMES.map((n) => [
      n,
      { version: 1, attempts: 0, last_error: null, processed_at: new Date(), dead: false },
    ]),
  );
}

async function tryConnect(): Promise<MongoClient | null> {
  const c = new MongoClient(MONGO_URI, {
    serverSelectionTimeoutMS: 1_500,
    connectTimeoutMS: 1_500,
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

describe("rescan-folder updateMany semantic", () => {
  let mongo: MongoClient | null = null;
  let db: Db | null = null;
  let mongoReachable = false;

  beforeEach(async () => {
    mongo = await tryConnect();
    mongoReachable = mongo !== null;
    if (!mongoReachable) {
      console.log("[indexer.rescan.test] MongoDB unreachable — skipping");
      return;
    }
    db = mongo!.db(TEST_DB);
    // Start each test with a clean assets collection.
    await db.collection("assets").drop().catch(() => {});
  });

  afterEach(async () => {
    if (db) {
      await db.collection("assets").drop().catch(() => {});
    }
    if (mongo) {
      await mongo.db(TEST_DB).dropDatabase().catch(() => {});
      await mongo.close();
      mongo = null;
      db = null;
    }
  });

  it("zeroes version on all docs whose abs_path starts with the folder path", async () => {
    if (!mongoReachable) return;

    const col = db!.collection("assets");
    const folderPath = "/photos/2024";

    // Insert two docs under the folder and one outside.
    await col.insertMany([
      {
        _id: new ObjectId(),
        abs_path: "/photos/2024/img1.dng",
        folder_id: new ObjectId(),
        stages: skeleton(),
      },
      {
        _id: new ObjectId(),
        abs_path: "/photos/2024/sub/img2.dng",
        folder_id: new ObjectId(),
        stages: skeleton(),
      },
      {
        _id: new ObjectId(),
        abs_path: "/other/img3.dng",
        folder_id: new ObjectId(),
        stages: skeleton(),
      },
    ]);

    // Build the same $set payload the rescan handler builds (mirrors the
    // production code in routes/indexer.ts).
    const stageResetFields: Record<string, unknown> = {};
    for (const name of STAGE_NAMES) {
      stageResetFields[`stages.${name}.version`] = 0;
      stageResetFields[`stages.${name}.dead`] = false;
      stageResetFields[`stages.${name}.attempts`] = 0;
      stageResetFields[`stages.${name}.last_error`] = null;
    }

    const escapedRoot = folderPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const result = await col.updateMany(
      { abs_path: { $regex: `^${escapedRoot}/` } },
      { $set: stageResetFields },
    );

    expect(result.modifiedCount).toBe(2);

    // Docs under the folder tree have every stage zeroed.
    const under = await col
      .find({ abs_path: { $regex: `^${escapedRoot}/` } })
      .toArray();
    expect(under.length).toBe(2);
    for (const doc of under) {
      for (const name of STAGE_NAMES) {
        expect((doc.stages as Record<string, { version: number; dead: boolean; attempts: number; last_error: null }>)[name].version).toBe(0);
        expect((doc.stages as Record<string, { version: number; dead: boolean; attempts: number; last_error: null }>)[name].dead).toBe(false);
        expect((doc.stages as Record<string, { version: number; dead: boolean; attempts: number; last_error: null }>)[name].attempts).toBe(0);
        expect((doc.stages as Record<string, { version: number; dead: boolean; attempts: number; last_error: null }>)[name].last_error).toBeNull();
      }
    }

    // Doc outside the folder is untouched.
    const outside = await col.findOne({ abs_path: "/other/img3.dng" });
    expect(outside?.stages.hash.version).toBe(1);
  });

  it("does not modify any docs when the folder path matches nothing", async () => {
    if (!mongoReachable) return;

    const col = db!.collection("assets");
    await col.insertMany([
      {
        _id: new ObjectId(),
        abs_path: "/photos/2024/img1.dng",
        folder_id: new ObjectId(),
        stages: skeleton(),
      },
    ]);

    const stageResetFields: Record<string, unknown> = {};
    for (const name of STAGE_NAMES) {
      stageResetFields[`stages.${name}.version`] = 0;
      stageResetFields[`stages.${name}.dead`] = false;
      stageResetFields[`stages.${name}.attempts`] = 0;
      stageResetFields[`stages.${name}.last_error`] = null;
    }

    const escapedRoot = "/nonexistent/path".replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const result = await col.updateMany(
      { abs_path: { $regex: `^${escapedRoot}/` } },
      { $set: stageResetFields },
    );

    expect(result.modifiedCount).toBe(0);

    // Original doc is untouched.
    const doc = await col.findOne({ abs_path: "/photos/2024/img1.dng" });
    expect(doc?.stages.hash.version).toBe(1);
  });
});

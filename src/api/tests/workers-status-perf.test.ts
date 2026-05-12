/**
 * Integration tests for /api/workers/status performance + correctness.
 *
 * Skip-passes when MongoDB is unreachable so CI without a Mongo container
 * stays green — same pattern as tests/search-route.test.ts.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { MongoClient } from "mongodb";

const TEST_DB = `maple_test_workers_status_${process.pid}`;
const PRIOR_MONGO_DB = process.env.MAPLE_MONGO_DB;
process.env.MAPLE_MONGO_DB = TEST_DB;

const MONGO_URI = process.env.MAPLE_MONGO_URI ?? "mongodb://localhost:27017";

let mongo: MongoClient | null = null;
let mongoReachable = false;

beforeAll(async () => {
  try {
    mongo = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 500 });
    await mongo.connect();
    await mongo.db("admin").command({ ping: 1 });
    mongoReachable = true;
  } catch {
    mongoReachable = false;
  }
});

afterAll(async () => {
  if (mongo && mongoReachable) {
    try {
      await mongo.db(TEST_DB).dropDatabase();
    } catch {}
    await mongo.close();
  }
  if (PRIOR_MONGO_DB === undefined) delete process.env.MAPLE_MONGO_DB;
  else process.env.MAPLE_MONGO_DB = PRIOR_MONGO_DB;
});

describe("ensureStageIndexes — dead partial index", () => {
  it("creates stage_<name>_dead partial index for every stage", async () => {
    if (!mongoReachable) return;
    const { closeDb, ensureStageIndexes } = await import("../src/db/client.ts");
    await closeDb();
    const db = mongo!.db(TEST_DB);
    // Pre-create the assets collection so dropIndex on a fresh namespace
    // doesn't throw NamespaceNotFound (matches the pattern in
    // tests/search-route.test.ts:1310).
    try {
      await db.createCollection("assets");
    } catch {}

    await ensureStageIndexes(db);
    // Idempotent — second call must not throw.
    await ensureStageIndexes(db);

    const indexes = await db.collection("assets").indexes();
    const byName = new Map(indexes.map((i) => [i.name as string, i]));

    for (const name of [
      "hash",
      "exif",
      "thumb",
      "face",
      "ocr",
      "describe",
      "geocode",
      "meili",
    ]) {
      const idx = byName.get(`stage_${name}_dead`);
      expect(idx).toBeDefined();
      // Partial filter must restrict to dead: true so the index stays tiny.
      expect(idx?.partialFilterExpression).toEqual({
        [`stages.${name}.dead`]: true,
      });
    }
  });
});

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

describe("GET /api/workers/status — counts", () => {
  it("returns correct pending + dead counts using indexed queries", async () => {
    if (!mongoReachable) return;

    const { closeDb, ensureStageIndexes, getDb } = await import(
      "../src/db/client.ts"
    );
    await closeDb();
    const db = mongo!.db(TEST_DB);
    try {
      await db.dropCollection("assets");
    } catch {}
    try {
      await db.dropCollection("worker_config");
    } catch {}
    await db.createCollection("assets");
    await ensureStageIndexes(db);

    // Seed 6 docs against a single stage so we have a deterministic shape.
    //   - 2 docs with version < tv, dead != true  → pending
    //   - 1 doc  with version field absent        → pending
    //   - 2 docs with version == tv               → up-to-date (not counted)
    //   - 1 doc  with dead = true                 → dead
    const tv = 3;
    await db.collection("assets").insertMany([
      { stages: { hash: { version: 1 } } },
      { stages: { hash: { version: 2 } } },
      { stages: {} }, // no stages.hash at all → pending
      { stages: { hash: { version: tv } } },
      { stages: { hash: { version: tv } } },
      { stages: { hash: { version: 1, dead: true } } },
    ]);

    // Build a supervisor stub that reports the hash stage with targetVersion = tv.
    const { Elysia } = await import("elysia");
    const { workerRoutes } = await import("../src/workers/routes.ts");
    const sup = {
      refreshLiveStatus: async () => {},
      statuses: () => ({
        hash: {
          status: "running",
          inFlight: 0,
          throughput: 0,
          lastError: null,
          targetVersion: tv,
        },
      }),
    } as unknown as import("../src/workers/supervisor.ts").Supervisor;

    // Force the route's getDb() to point at TEST_DB.
    process.env.MAPLE_MONGO_DB = TEST_DB;
    await closeDb();
    await getDb();

    const app = new Elysia().use(workerRoutes(sup));
    const res = await app.handle(
      new Request("http://localhost/api/workers/status"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      stages: Array<{ name: string; pending: number; dead: number }>;
    };
    const hash = body.stages.find((s) => s.name === "hash");
    expect(hash).toBeDefined();
    expect(hash!.pending).toBe(3);
    expect(hash!.dead).toBe(1);
  });

  it("uses an index plan (no COLLSCAN) for the dead-count query", async () => {
    if (!mongoReachable) return;
    const { closeDb, ensureStageIndexes } = await import(
      "../src/db/client.ts"
    );
    await closeDb();
    const db = mongo!.db(TEST_DB);
    try {
      await db.createCollection("assets");
    } catch {}
    await ensureStageIndexes(db);

    const explain = await db
      .collection("assets")
      .find({ "stages.hash.dead": true })
      .explain("queryPlanner");
    const winning = JSON.stringify(explain.queryPlanner?.winningPlan ?? {});
    expect(winning).not.toContain("COLLSCAN");
    expect(winning).toContain("stage_hash_dead");
  });
});

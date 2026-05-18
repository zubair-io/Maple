/**
 * client.ts integration tests — exercise `ensureIndexes` against a real
 * MongoDB instance. Skip-pass when Mongo is unreachable (CI without a
 * running mongod gets a soft pass, matching the rest of the repo's pattern).
 *
 * Initial scope (this commit): Fix 1 — `deleted_at_1` partial index exists
 * with the right partial-filter expression, and the trash-GC find query
 * uses it (IXSCAN, not COLLSCAN). Subsequent commits extend this file.
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterAll,
} from "bun:test";
import { MongoClient, type Db } from "mongodb";

const TEST_DB = `maple_test_client_${process.pid}`;
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
    try { await c.close(); } catch { /* ignore */ }
    return null;
  }
}

beforeAll(async () => {
  mongo = await tryConnect();
  mongoReachable = mongo !== null;
  if (!mongoReachable) {
    console.log("[client.test] skipping: MongoDB unreachable");
    return;
  }
  db = mongo!.db(TEST_DB);
  await db.dropDatabase();
  // Pre-create auxiliary collections that ensureIndexes touches (matches
  // the people.repo.test.ts pattern — production deploys always have these
  // populated by the time ensureIndexes runs, so the prod code path doesn't
  // need to handle NamespaceNotFound on these specifically).
  for (const name of [
    "users",
    "credentials",
    "invites",
    "refresh_tokens",
    "challenges",
  ]) {
    await db.createCollection(name).catch(() => undefined);
  }
});

beforeEach(async () => {
  if (!mongoReachable) return;
  // Wipe between tests so each one starts from a known state. We don't
  // drop indexes — that's what we're testing.
  await db!.collection("assets").deleteMany({});
  await db!.collection("migrations").deleteMany({});
});

afterAll(async () => {
  if (mongo) {
    await mongo.db(TEST_DB).dropDatabase();
    await mongo.close();
  }
  const { closeDb } = await import("./client.ts");
  await closeDb();
});

describe("ensureIndexes — deleted_at partial index (Fix 1)", () => {
  it("creates deleted_at_1 with partialFilterExpression { $type: 'string' }", async () => {
    if (!mongoReachable) return;
    const { closeDb, ensureIndexes } = await import("./client.ts");
    await closeDb();
    await ensureIndexes();
    const indexes = await db!.collection("assets").indexes();
    const idx = indexes.find((i) => i.name === "deleted_at_1");
    expect(idx).toBeDefined();
    expect(idx!.key).toEqual({ deleted_at: 1 });
    // The partialFilterExpression is what stops the index from covering all
    // 430k live rows — every live row writes `deleted_at: null` explicitly,
    // so `$exists: true` would index everything. `$type: "string"` narrows
    // to the small trashed set.
    expect(idx!.partialFilterExpression).toEqual({
      deleted_at: { $type: "string" },
    });
  });

  it("trash-GC find query uses deleted_at_1 (IXSCAN, not COLLSCAN)", async () => {
    if (!mongoReachable) return;
    const { closeDb, ensureIndexes } = await import("./client.ts");
    await closeDb();
    await ensureIndexes();

    // Insert 3 live rows (deleted_at: null), 3 trashed rows
    // (deleted_at: ISO string), and 3 rows where deleted_at is absent.
    // Only the 3 trashed rows should be in the index, and only rows older
    // than the cutoff should be returned.
    const now = Date.now();
    const oldIso = new Date(now - 60 * 86_400_000).toISOString();
    const newIso = new Date(now - 1 * 86_400_000).toISOString();
    const cutoffIso = new Date(now - 30 * 86_400_000).toISOString();
    const base = {
      folder_id: "f",
      filename: "x",
      abs_path: "/x",
      size: 1,
      mtime: 0,
      rating: 0,
      flag: 0,
      color_label: "",
      indexed_at: "2026-05-11T00:00:00Z",
    };
    const docs = [
      { ...base, filename: "live-1.jpg", deleted_at: null },
      { ...base, filename: "live-2.jpg", deleted_at: null },
      { ...base, filename: "live-3.jpg", deleted_at: null },
      { ...base, filename: "trash-old-1.jpg", deleted_at: oldIso },
      { ...base, filename: "trash-old-2.jpg", deleted_at: oldIso },
      { ...base, filename: "trash-new.jpg", deleted_at: newIso },
      { ...base, filename: "absent-1.jpg" },
      { ...base, filename: "absent-2.jpg" },
      { ...base, filename: "absent-3.jpg" },
    ];
    await db!.collection("assets").insertMany(docs);

    // Mirror the exact predicate shape the trash-GC sweeper issues —
    // `$type: "string"` is the key that lets the planner prove the query
    // is fully covered by the partial filter expression. Drop it and the
    // planner falls back to a COLLSCAN.
    const explain = await db!
      .collection("assets")
      .find({ deleted_at: { $type: "string", $lt: cutoffIso, $ne: null } })
      .explain("executionStats");
    // explain.queryPlanner.winningPlan.inputStage.stage should be IXSCAN.
    // The Mongo explain shape is { queryPlanner: { winningPlan: {...} } };
    // we walk it tolerantly because the exact nesting varies by version.
    const planStr = JSON.stringify(explain);
    expect(planStr).toContain("IXSCAN");
    expect(planStr).toContain("deleted_at_1");
    expect(planStr).not.toMatch(/"stage":\s*"COLLSCAN"/);

    // Key examination should be proportional to the trashed-row count
    // (3), not the full collection (9). Two of those three pass the
    // $lt cutoff, so nReturned === 2.
    const execStats =
      (explain as { executionStats?: { totalKeysExamined?: number; nReturned?: number } })
        .executionStats ?? {};
    expect(execStats.nReturned).toBe(2);
    // The index only contains the 3 trashed rows; $lt may walk all 3 keys
    // before stopping, so the upper bound is 3 (not 9 — that would mean a
    // collection scan crept back in).
    expect(execStats.totalKeysExamined ?? 0).toBeLessThanOrEqual(3);
  });
});

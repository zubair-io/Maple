/**
 * trash-gc tests — verify the sweeper uses the `deleted_at_1` partial
 * index instead of COLLSCANning the assets collection on every pass
 * (the production bug fixed in this PR).
 *
 * Skip-passes when Mongo is unreachable.
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
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEST_DB = `maple_test_trashgc_${process.pid}`;
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
    console.log("[trash-gc.test] skipping: MongoDB unreachable");
    return;
  }
  db = mongo!.db(TEST_DB);
  await db.dropDatabase();
  for (const name of [
    "users",
    "credentials",
    "invites",
    "refresh_tokens",
    "challenges",
  ]) {
    await db.createCollection(name).catch(() => undefined);
  }
  const { closeDb, ensureIndexes } = await import("../db/client.ts");
  await closeDb();
  await ensureIndexes();
});

beforeEach(async () => {
  if (!mongoReachable) return;
  await db!.collection("assets").deleteMany({});
});

afterAll(async () => {
  if (mongo) {
    await mongo.db(TEST_DB).dropDatabase();
    await mongo.close();
  }
  const { closeDb } = await import("../db/client.ts");
  await closeDb();
});

describe("trash-gc sweeper query plan", () => {
  it("uses the deleted_at_1 partial index (IXSCAN, not COLLSCAN)", async () => {
    if (!mongoReachable) return;

    const now = Date.now();
    const oldIso = new Date(now - 60 * 86_400_000).toISOString();
    const cutoffIso = new Date(now - 30 * 86_400_000).toISOString();

    // Mixed population: live rows (deleted_at: null) outnumber the
    // trashed rows. Without the partial index this is a full scan; with
    // it the planner only walks the small set of trashed entries.
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
    const live = Array.from({ length: 50 }, (_, i) => ({
      ...base,
      filename: `live-${i}.jpg`,
      deleted_at: null,
    }));
    const trashed = Array.from({ length: 3 }, (_, i) => ({
      ...base,
      filename: `trash-${i}.jpg`,
      deleted_at: oldIso,
    }));
    await db!.collection("assets").insertMany([...live, ...trashed]);

    // The query shape MUST match what trash-gc.ts emits — `$type: "string"`
    // is what lets the planner prove the partial filter subsumes the
    // predicate. Without it the planner falls back to COLLSCAN.
    const explain = await db!
      .collection("assets")
      .find({ deleted_at: { $type: "string", $lt: cutoffIso, $ne: null } })
      .explain("executionStats");

    const planStr = JSON.stringify(explain);
    expect(planStr).toContain("IXSCAN");
    expect(planStr).toContain("deleted_at_1");
    expect(planStr).not.toMatch(/"stage":\s*"COLLSCAN"/);

    const execStats =
      (explain as { executionStats?: { totalDocsExamined?: number; nReturned?: number } })
        .executionStats ?? {};
    expect(execStats.nReturned).toBe(3);
    // docsExamined should be O(trashed), NOT O(live + trashed). The bug
    // before the fix had this at 53 (full scan); with the index it's at
    // most 3.
    expect(execStats.totalDocsExamined ?? 0).toBeLessThanOrEqual(3);
  });

  it("runTrashGcOnce purges only rows older than the cutoff", async () => {
    if (!mongoReachable) return;

    const dir = mkdtempSync(join(tmpdir(), "maple-trash-gc-"));
    const now = Date.now();
    const oldIso = new Date(now - 60 * 86_400_000).toISOString();
    const newIso = new Date(now - 1 * 86_400_000).toISOString();

    const oldPath = join(dir, "old.jpg");
    const newPath = join(dir, "new.jpg");
    writeFileSync(oldPath, "x");
    writeFileSync(newPath, "x");

    const base = {
      folder_id: "f",
      size: 1,
      mtime: 0,
      rating: 0,
      flag: 0,
      color_label: "",
      indexed_at: "2026-05-11T00:00:00Z",
    };
    await db!.collection("assets").insertMany([
      { ...base, filename: "old.jpg", abs_path: oldPath, deleted_at: oldIso },
      { ...base, filename: "new.jpg", abs_path: newPath, deleted_at: newIso },
      { ...base, filename: "live.jpg", abs_path: "/n/a", deleted_at: null },
    ]);

    const { runTrashGcOnce } = await import("./trash-gc.ts");
    const summary = await runTrashGcOnce({ retentionDays: 30 });
    expect(summary.purged).toBe(1);
    expect(summary.scanned).toBe(1);

    // The old row is gone, the new one and the live one remain.
    const remaining = await db!
      .collection("assets")
      .find({}, { projection: { filename: 1 } })
      .toArray();
    const names = remaining.map((r: { filename?: string }) => r.filename).sort();
    expect(names).toEqual(["live.jpg", "new.jpg"]);
  });
});

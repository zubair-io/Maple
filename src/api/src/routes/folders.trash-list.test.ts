/**
 * Trash-list route plan + correctness tests — verify the route uses the
 * `deleted_at_1` partial index instead of falling back to a per-folder
 * COLLSCAN.
 *
 * Issue #83: the route's filter `{ folder_id, deleted_at: { $ne: null },
 * original_path: { $ne: null } }` and its cursor predicate
 * `{ deleted_at: { $lt: iso } }` lacked `$type: "string"`, so the planner
 * could not prove the partial filter (`{ deleted_at: { $type: "string" } }`)
 * subsumes them, and chose `folder_id` IXSCAN + filter-after-fetch instead.
 *
 * Skip-passes when Mongo is unreachable so CI without a Mongo runner
 * doesn't spuriously fail.
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterAll,
} from "bun:test";
import { Elysia } from "elysia";
import { MongoClient, ObjectId, type Db } from "mongodb";

const TEST_DB = `maple_test_trash_list_${process.pid}`;
process.env.MAPLE_MONGO_DB = TEST_DB;
const MONGO_URI = process.env.MAPLE_MONGO_URI ?? "mongodb://localhost:27017";

let mongo: MongoClient | null = null;
let mongoReachable = false;
let db: Db | null = null;
let folderId: ObjectId;
let folderPath: string;

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
    console.log("[folders.trash-list.test] skipping: MongoDB unreachable");
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
  await db!.collection("folders").deleteMany({});

  folderId = new ObjectId();
  folderPath = "/srv/lib";
  await db!.collection("folders").insertOne({
    _id: folderId,
    path: folderPath,
    label: "lib",
    last_scan: null,
    file_count: 0,
    created_at: new Date().toISOString(),
  } as never);
});

afterAll(async () => {
  if (mongo) {
    await mongo.db(TEST_DB).dropDatabase();
    await mongo.close();
  }
  const { closeDb } = await import("../db/client.ts");
  await closeDb();
});

/**
 * Seed `live` live rows + `trashed` trashed rows in the test folder.
 * Returns the inserted trashed-asset ids (newest-deleted_at first).
 */
async function seed(live: number, trashed: number): Promise<ObjectId[]> {
  const base = {
    folder_id: folderId,
    size: 1,
    mtime: 0,
    rating: 0,
    flag: 0,
    color_label: "",
    indexed_at: "2026-05-11T00:00:00Z",
  };
  const liveRows = Array.from({ length: live }, (_, i) => ({
    ...base,
    filename: `live-${i}.jpg`,
    abs_path: `${folderPath}/live-${i}.jpg`,
    deleted_at: null,
  }));
  const now = Date.now();
  const trashedRows: Array<{ _id: ObjectId; [k: string]: unknown }> =
    Array.from({ length: trashed }, (_, i) => ({
      _id: new ObjectId(),
      ...base,
      filename: `trash-${i}.jpg`,
      abs_path: `${folderPath}/.maple-trash/trash-${i}.jpg`,
      original_path: `${folderPath}/trash-${i}.jpg`,
      deleted_at: new Date(now - i * 1000).toISOString(),
    }));
  if (liveRows.length > 0) {
    await db!.collection("assets").insertMany(liveRows);
  }
  if (trashedRows.length > 0) {
    await db!.collection("assets").insertMany(trashedRows);
  }
  return trashedRows.map((r) => r._id);
}

describe("buildTrashListFilter — query plan", () => {
  it("baseline: the OLD predicate (no $type) DID COLLSCAN — sanity-check the bug", async () => {
    if (!mongoReachable) return;

    // Reproduce the pre-fix predicate shape verbatim to confirm the
    // planner falls back to a per-folder scan without `$type: "string"`.
    // If this test ever flips to IXSCAN spontaneously, Mongo's planner
    // got smarter and the gate below can be relaxed.
    await seed(1000, 5);
    const brokenFilter = {
      folder_id: folderId,
      deleted_at: { $ne: null },
      original_path: { $ne: null },
    };
    const explain = await db!
      .collection("assets")
      .find(brokenFilter)
      .sort({ deleted_at: -1, _id: -1 })
      .limit(101)
      .explain("executionStats");
    const stats =
      (explain as { executionStats?: { totalDocsExamined?: number; nReturned?: number } })
        .executionStats ?? {};
    expect(stats.nReturned).toBe(5);
    // The broken predicate examines all 1005 folder_id matches even
    // though only 5 satisfy the filter.
    expect(stats.totalDocsExamined ?? 0).toBeGreaterThanOrEqual(1000);
  });

  it("uses the deleted_at_1 partial index (no COLLSCAN)", async () => {
    if (!mongoReachable) return;

    await seed(1000, 5);

    const { buildTrashListFilter } = await import("./folders.ts");
    const filter = buildTrashListFilter(folderId, null);
    const explain = await db!
      .collection("assets")
      .find(filter)
      .sort({ deleted_at: -1, _id: -1 })
      .limit(101)
      .explain("executionStats");

    const planStr = JSON.stringify(explain);
    expect(planStr).toContain("IXSCAN");
    expect(planStr).toContain("deleted_at_1");

    const stats =
      (explain as { executionStats?: { totalDocsExamined?: number; nReturned?: number } })
        .executionStats ?? {};
    expect(stats.nReturned).toBe(5);
    // The whole point of the fix: docsExamined must be O(trashed),
    // not O(live + trashed). Before the fix this was 1005.
    expect(stats.totalDocsExamined ?? 0).toBeLessThan(10);
  });

  it("cursor predicate also uses the deleted_at_1 partial index", async () => {
    if (!mongoReachable) return;

    await seed(1000, 5);

    const { buildTrashListFilter } = await import("./folders.ts");
    // Construct a cursor pointing somewhere in the middle of the result
    // set. Format matches the route's emitter: `<iso>|<hex>`.
    const iso = new Date().toISOString();
    const cursor = `${iso}|${new ObjectId().toHexString()}`;
    const filter = buildTrashListFilter(folderId, cursor);
    const explain = await db!
      .collection("assets")
      .find(filter)
      .sort({ deleted_at: -1, _id: -1 })
      .limit(101)
      .explain("executionStats");

    const planStr = JSON.stringify(explain);
    expect(planStr).toContain("IXSCAN");
    expect(planStr).toContain("deleted_at_1");

    const stats =
      (explain as { executionStats?: { totalDocsExamined?: number } })
        .executionStats ?? {};
    expect(stats.totalDocsExamined ?? 0).toBeLessThan(10);
  });
});

describe("GET /api/folders/:id/trash — response correctness", () => {
  it("returns the trashed assets and nothing else", async () => {
    if (!mongoReachable) return;
    await seed(20, 5);

    const { foldersRoutes } = await import("./folders.ts");
    const app = new Elysia().use(foldersRoutes);
    const res = await app.handle(
      new Request(`http://localhost/api/folders/${folderId.toHexString()}/trash`),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as {
      items: Array<{ filename: string; deleted_at: string }>;
      next_cursor: string | null;
    };
    expect(body.items.length).toBe(5);
    expect(body.next_cursor).toBeNull();
    for (const item of body.items) {
      expect(item.filename.startsWith("trash-")).toBe(true);
      expect(typeof item.deleted_at).toBe("string");
    }
    // Sort is deleted_at desc — descending order over the returned set.
    for (let i = 1; i < body.items.length; i++) {
      const prev = body.items[i - 1]!;
      const cur = body.items[i]!;
      expect(prev.deleted_at >= cur.deleted_at).toBe(true);
    }
  });
});

/**
 * Cursor allocator + change-row writer tests. Requires a running
 * MongoDB; skip gracefully if unreachable.
 */

import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { MongoClient, ObjectId, type Db } from "mongodb";
import {
  allocateCursor,
  recordAssetChange,
  listChangesSince,
} from "./changes.repo.ts";

const MONGO_URI = process.env.MAPLE_MONGO_URI ?? "mongodb://localhost:27017";
const TEST_DB = `maple_changes_repo_test_${process.pid}`;

let client: MongoClient | null = null;
let db: Db | null = null;

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

beforeEach(async () => {
  client = await tryConnect();
  if (!client) return;
  process.env.MAPLE_MONGO_URI = MONGO_URI;
  process.env.MAPLE_MONGO_DB = TEST_DB;
  db = client.db(TEST_DB);
  await db.dropDatabase();
});

afterAll(async () => {
  if (db) await db.dropDatabase();
  if (client) await client.close();
});

describe("changes.repo", () => {
  it("allocateCursor returns monotonically increasing values", async () => {
    if (!db) return;
    const a = await allocateCursor(db);
    const b = await allocateCursor(db);
    const c = await allocateCursor(db);
    expect(b).toBe(a + 1);
    expect(c).toBe(b + 1);
  });

  it("recordAssetChange inserts row with allocated cursor", async () => {
    if (!db) return;
    const assetId = new ObjectId();
    const folderId = new ObjectId();
    const cursor = await recordAssetChange(db, {
      kind: "update",
      asset_id: assetId,
      folder_id: folderId,
      abs_path: "/srv/photos/a.dng",
    });
    const rows = await db.collection("asset_changes").find({}).toArray();
    expect(rows.length).toBe(1);
    expect(rows[0].cursor).toBe(cursor);
    expect(rows[0].kind).toBe("update");
  });

  it("listChangesSince returns rows in cursor order", async () => {
    if (!db) return;
    for (let i = 0; i < 5; i++) {
      await recordAssetChange(db, {
        kind: "create",
        asset_id: new ObjectId(),
        folder_id: new ObjectId(),
        abs_path: `/srv/photos/${i}.dng`,
      });
    }
    const rows = await listChangesSince(db, { since: 0, limit: 100 });
    expect(rows.length).toBe(5);
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].cursor).toBeGreaterThan(rows[i - 1].cursor);
    }
  });

  it("listChangesSince respects the since cursor", async () => {
    if (!db) return;
    for (let i = 0; i < 5; i++) {
      await recordAssetChange(db, {
        kind: "create",
        asset_id: new ObjectId(),
        folder_id: new ObjectId(),
        abs_path: `/srv/photos/${i}.dng`,
      });
    }
    const all = await listChangesSince(db, { since: 0, limit: 100 });
    const mid = all[2].cursor;
    const tail = await listChangesSince(db, { since: mid, limit: 100 });
    expect(tail.length).toBe(2);
    expect(tail[0].cursor).toBeGreaterThan(mid);
  });

  it("listChangesSince respects the limit", async () => {
    if (!db) return;
    for (let i = 0; i < 10; i++) {
      await recordAssetChange(db, {
        kind: "create",
        asset_id: new ObjectId(),
        folder_id: new ObjectId(),
        abs_path: `/srv/photos/${i}.dng`,
      });
    }
    const page = await listChangesSince(db, { since: 0, limit: 3 });
    expect(page.length).toBe(3);
  });
});

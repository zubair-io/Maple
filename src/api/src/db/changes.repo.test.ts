/**
 * Cursor allocator + change-row writer tests. Requires a running
 * MongoDB; skip gracefully if unreachable.
 */

import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { MongoClient, ObjectId, type Db } from "mongodb";
import {
  allocateCursor,
  recordAssetChange,
  recordAndPublishAssetChange,
  listChangesSince,
  computeRelativePath,
  __resetFolderPathCacheForTests,
} from "./changes.repo.ts";
import {
  getChangeBus,
  __resetChangeBusForTests,
} from "../runtime/change-bus.ts";

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
  __resetFolderPathCacheForTests();
  __resetChangeBusForTests();
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
    // relative_path defaults to null when caller doesn't supply it (the
    // high-level recordAndPublishAssetChange is responsible for the
    // folder.path lookup; bare recordAssetChange stores what it's given).
    expect(rows[0].relative_path).toBeNull();
  });

  it("recordAndPublishAssetChange computes relative_path from folder.path", async () => {
    if (!db) return;
    const folderId = new ObjectId();
    await db.collection("folders").insertOne({
      _id: folderId,
      path: "/srv/photos",
      label: "lib",
    } as any);
    const assetId = new ObjectId();
    await recordAndPublishAssetChange({
      kind: "create",
      asset_id: assetId,
      folder_id: folderId,
      abs_path: "/srv/photos/2024/holiday/IMG_0001.dng",
    });
    const rows = await db.collection("asset_changes").find({}).toArray();
    expect(rows.length).toBe(1);
    expect(rows[0].relative_path).toBe("2024/holiday/IMG_0001.dng");
    // The bus payload mirrors what the repo persisted.
    const snap = getChangeBus().snapshot();
    expect(snap.length).toBe(1);
    expect(snap[0]!.relative_path).toBe("2024/holiday/IMG_0001.dng");
  });

  it("recordAndPublishAssetChange tolerates a trailing slash on folder.path", async () => {
    if (!db) return;
    const folderId = new ObjectId();
    await db.collection("folders").insertOne({
      _id: folderId,
      path: "/srv/photos/",
      label: "lib",
    } as any);
    await recordAndPublishAssetChange({
      kind: "update",
      asset_id: new ObjectId(),
      folder_id: folderId,
      abs_path: "/srv/photos/IMG_0002.dng",
    });
    const rows = await db.collection("asset_changes").find({}).toArray();
    expect(rows[0].relative_path).toBe("IMG_0002.dng");
  });

  it("recordAndPublishAssetChange stores null when abs_path is outside the folder root", async () => {
    if (!db) return;
    const folderId = new ObjectId();
    await db.collection("folders").insertOne({
      _id: folderId,
      path: "/srv/photos",
      label: "lib",
    } as any);
    // Defensive case — should not normally happen, but storing null is
    // safer than emitting a wrong path; the writer logs a warn.
    await recordAndPublishAssetChange({
      kind: "create",
      asset_id: new ObjectId(),
      folder_id: folderId,
      abs_path: "/elsewhere/oops.dng",
    });
    const rows = await db.collection("asset_changes").find({}).toArray();
    expect(rows.length).toBe(1);
    expect(rows[0].relative_path).toBeNull();
  });

  it("listChangesSince tolerates legacy rows that lack relative_path", async () => {
    if (!db) return;
    // Insert directly so the bson lacks the field entirely, mimicking a
    // row written before Phase 6.
    const cursor = await allocateCursor(db);
    await db.collection("asset_changes").insertOne({
      cursor,
      asset_id: new ObjectId(),
      folder_id: new ObjectId(),
      kind: "update",
      abs_path: "/srv/photos/legacy.dng",
      at: new Date(),
    } as any);
    const rows = await listChangesSince(db, { since: 0, limit: 10 });
    expect(rows.length).toBe(1);
    // SSE payload's `?? null` fallback turns the absent field into
    // null on the wire; the read itself must not throw.
    expect((rows[0] as any).relative_path ?? null).toBeNull();
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

describe("computeRelativePath", () => {
  it("returns empty string when absPath equals folder root", () => {
    expect(computeRelativePath("/srv/photos", "/srv/photos")).toBe("");
  });
  it("strips the folder prefix for nested paths", () => {
    expect(computeRelativePath("/srv/photos", "/srv/photos/a/b/c.dng")).toBe(
      "a/b/c.dng",
    );
  });
  it("normalises a trailing slash on the folder root", () => {
    expect(computeRelativePath("/srv/photos/", "/srv/photos/x.dng")).toBe(
      "x.dng",
    );
  });
  it("returns null when absPath is outside the folder root", () => {
    expect(computeRelativePath("/srv/photos", "/elsewhere/x.dng")).toBeNull();
  });
  it("does not false-match a sibling with a shared prefix", () => {
    // "/srv/photos2/x" must NOT be treated as living under "/srv/photos"
    expect(computeRelativePath("/srv/photos", "/srv/photos2/x.dng")).toBeNull();
  });
});

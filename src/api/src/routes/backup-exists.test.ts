/**
 * Route-integration test: POST /api/libraries/:libraryId/backup/exists
 *
 * The PhotoKit backup client computes a content-derived `maple_id` per local
 * photo and asks the server, in batches, which of those ids it does NOT
 * already have in a given library so it can skip re-uploading duplicates.
 *
 * Covers: missing ids returned, present ids excluded, unknown library → 404,
 * invalid library id → 400, > 1000 ids → 400, empty array → { missing: [] },
 * de-duplication + input-order preservation.
 *
 * Requires a running MongoDB (skips gracefully if unreachable), mirroring
 * `folders.upload.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Elysia } from "elysia";
import { MongoClient, ObjectId, type Db } from "mongodb";
import { closeDb } from "../db/client.ts";
import { backupExistsRoutes } from "./backup-exists.ts";

const MONGO_URI = process.env.MAPLE_MONGO_URI ?? "mongodb://localhost:27017";
const TEST_DB = `maple_backup_exists_test_${process.pid}`;

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

/** Insert a minimal asset row carrying `maple_id` linked to `libraryId`
 * through `fileinfo[0].library_id`, matching backup-ingest's writer shape. */
async function seedAsset(
  db: Db,
  libraryId: ObjectId,
  mapleId: string,
): Promise<void> {
  await db.collection("assets").insertOne({
    _id: new ObjectId(),
    fileinfo: [
      {
        path: "",
        filename: `${mapleId}.dng`,
        library_id: libraryId,
        deleted_at: null,
      },
    ],
    size: 4,
    mtime: Date.now(),
    rating: 0,
    flag: 0,
    color_label: "",
    indexed_at: new Date().toISOString(),
    maple_id: mapleId,
  } as never);
}

describe("POST /api/libraries/:libraryId/backup/exists", () => {
  let mongo: MongoClient | null = null;
  let db: Db | null = null;
  let libraryId: ObjectId | null = null;

  beforeEach(async () => {
    mongo = await tryConnect();
    if (!mongo) return;
    process.env.MAPLE_MONGO_URI = MONGO_URI;
    process.env.MAPLE_MONGO_DB = TEST_DB;
    // Reset module-cached client so MAPLE_MONGO_DB takes effect.
    await closeDb();
    db = mongo.db(TEST_DB);
    await db.dropDatabase();
    libraryId = new ObjectId();
    await db.collection("folders").insertOne({
      _id: libraryId,
      path: "/tmp/maple-backup-exists-test",
      label: "exists-test",
      last_scan: null,
      file_count: 0,
      created_at: new Date().toISOString(),
    } as never);
  });

  afterEach(async () => {
    if (db) await db.dropDatabase().catch(() => {});
    if (mongo) await mongo.close().catch(() => {});
    await closeDb();
    db = null;
    mongo = null;
    libraryId = null;
  });

  function makeApp() {
    return new Elysia().use(backupExistsRoutes);
  }

  async function post(libId: string, body: unknown): Promise<Response> {
    return makeApp().handle(
      new Request(`http://localhost/api/libraries/${libId}/backup/exists`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  }

  it("returns ids that are not present and excludes those that are", async () => {
    if (!mongo || !db || !libraryId) {
      console.log("[backup-exists.test] MongoDB unreachable — skipping");
      return;
    }
    await seedAsset(db, libraryId, "present-a");
    await seedAsset(db, libraryId, "present-b");

    const res = await post(libraryId.toHexString(), {
      maple_ids: ["present-a", "missing-x", "present-b", "missing-y"],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { missing: string[] };
    // Present ids excluded; missing ones returned in input order.
    expect(body.missing).toEqual(["missing-x", "missing-y"]);
  });

  it("scopes presence to the requested library", async () => {
    if (!mongo || !db || !libraryId) return;
    // Seed the same maple_id but linked to a DIFFERENT library.
    const otherLibrary = new ObjectId();
    await seedAsset(db, otherLibrary, "shared-id");

    const res = await post(libraryId.toHexString(), {
      maple_ids: ["shared-id"],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { missing: string[] };
    // Present in another library, so still "missing" for this one.
    expect(body.missing).toEqual(["shared-id"]);
  });

  it("de-duplicates input ids and preserves first-seen order", async () => {
    if (!mongo || !db || !libraryId) return;
    await seedAsset(db, libraryId, "have");

    const res = await post(libraryId.toHexString(), {
      maple_ids: ["a", "b", "a", "have", "b", "have", "c"],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { missing: string[] };
    // 'have' excluded (present); duplicates collapsed; order preserved.
    expect(body.missing).toEqual(["a", "b", "c"]);
  });

  it("empty array yields an empty missing list", async () => {
    if (!mongo || !db || !libraryId) return;
    const res = await post(libraryId.toHexString(), { maple_ids: [] });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { missing: string[] };
    expect(body.missing).toEqual([]);
  });

  it("unknown library → 404", async () => {
    if (!mongo || !db) return;
    const res = await post(new ObjectId().toHexString(), {
      maple_ids: ["anything"],
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("library not found");
  });

  it("invalid library id → 400", async () => {
    if (!mongo || !db) return;
    const res = await post("not-an-objectid", { maple_ids: ["anything"] });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid library id");
  });

  it("non-array maple_ids → 400", async () => {
    if (!mongo || !db || !libraryId) return;
    const res = await post(libraryId.toHexString(), { maple_ids: "nope" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("maple_ids must be an array");
  });

  it("missing maple_ids field → 400", async () => {
    if (!mongo || !db || !libraryId) return;
    const res = await post(libraryId.toHexString(), {});
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("maple_ids must be an array");
  });

  it("more than 1000 ids → 400", async () => {
    if (!mongo || !db || !libraryId) return;
    const tooMany = Array.from({ length: 1001 }, (_, i) => `id-${i}`);
    const res = await post(libraryId.toHexString(), { maple_ids: tooMany });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("too many ids (max 1000)");
  });

  it("accepts exactly 1000 ids", async () => {
    if (!mongo || !db || !libraryId) return;
    const exactly = Array.from({ length: 1000 }, (_, i) => `id-${i}`);
    const res = await post(libraryId.toHexString(), { maple_ids: exactly });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { missing: string[] };
    // None seeded — all 1000 are missing.
    expect(body.missing).toHaveLength(1000);
  });
});

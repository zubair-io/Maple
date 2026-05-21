/**
 * DELETE /api/assets/:id/xmp:
 *   - removes existing sidecar, 204
 *   - non-existent sidecar still returns 204 (idempotent)
 *   - never touches the paired RAW
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
} from "bun:test";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs/promises";
import { MongoClient, ObjectId, type Db } from "mongodb";
import { pendingEnrichment } from "../src/db/schema.ts";

const TEST_DB = `maple_test_fp2_delete_${process.pid}`;
const PRIOR_MONGO_DB = process.env.MAPLE_MONGO_DB;
const MONGO_URI = process.env.MAPLE_MONGO_URI ?? "mongodb://localhost:27017";

let mongo: MongoClient | null = null;
let mongoReachable = false;
let db: Db | null = null;
let tmpRoot: string;
let realTmpRoot: string;
let rawPath: string;
let xmpPath: string;
let assetId: ObjectId;

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
    try { await c.close(); } catch {}
    return null;
  }
}

describe("DELETE /api/assets/:id/xmp", () => {
  beforeAll(async () => {
    const { closeDb } = await import("../src/db/client.ts");
    await closeDb();
    process.env.MAPLE_MONGO_DB = TEST_DB;
    mongo = await tryConnect();
    mongoReachable = mongo !== null;
    if (!mongoReachable) return;

    db = mongo!.db(TEST_DB);
    await db.dropDatabase();

    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "maple-fp2-delete-"));
    realTmpRoot = await fs.realpath(tmpRoot);
    process.env.MAPLE_ROOTS = realTmpRoot;

    rawPath = path.join(realTmpRoot, "IMG_1.ARW");
    xmpPath = path.join(realTmpRoot, "IMG_1.xmp");
    await fs.writeFile(rawPath, new Uint8Array([0xff, 0xd8, 0xff]));

    const now = new Date().toISOString();
    assetId = new ObjectId();
    // Post drop-abs-path-2026-05-21: seed folder + fileinfo so the
    // route's abs_path resolution finds the on-disk RAW. See
    // assets-xmp-conflict.test.ts for the same setup pattern.
    const libraryId = new ObjectId();
    await db.collection("folders").insertOne({
      _id: libraryId,
      path: realTmpRoot,
      label: "test",
      created_at: now,
      file_count: 0,
    } as never);
    const { invalidateLibraryRoots } = await import(
      "../src/indexer/libraries.cache.ts",
    );
    invalidateLibraryRoots();
    await db.collection("assets").insertOne({
      _id: assetId,
      fileinfo: [
        { library_id: libraryId, path: "", filename: "IMG_1.ARW", deleted_at: null },
      ],
      size: 3,
      mtime: now,
      indexed_at: now,
      enrichment: pendingEnrichment(),
    } as never);
  });

  afterAll(async () => {
    const { closeDb } = await import("../src/db/client.ts");
    await closeDb();
    if (mongo) {
      try { await db?.dropDatabase(); } catch {}
      await mongo.close();
    }
    try { await fs.rm(tmpRoot, { recursive: true, force: true }); } catch {}
    if (PRIOR_MONGO_DB === undefined) delete process.env.MAPLE_MONGO_DB;
    else process.env.MAPLE_MONGO_DB = PRIOR_MONGO_DB;
  });

  it("removes an existing sidecar, returns 204, RAW untouched", async () => {
    if (!mongoReachable) return;
    await fs.writeFile(xmpPath, "<x:xmpmeta/>");
    const { assetsRoutes } = await import("../src/routes/assets.ts");
    const res = await assetsRoutes.handle(
      new Request(`http://test/api/assets/${assetId.toHexString()}/xmp`, {
        method: "DELETE",
      }),
    );
    expect(res.status).toBe(204);
    await expect(fs.access(xmpPath)).rejects.toThrow();
    await fs.access(rawPath); // RAW must still exist.
  });

  it("non-existent sidecar is idempotent (returns 204)", async () => {
    if (!mongoReachable) return;
    const { assetsRoutes } = await import("../src/routes/assets.ts");
    const res = await assetsRoutes.handle(
      new Request(`http://test/api/assets/${assetId.toHexString()}/xmp`, {
        method: "DELETE",
      }),
    );
    expect(res.status).toBe(204);
  });
});

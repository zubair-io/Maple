/**
 * `/api/fs/dir` attaches the Mongo asset `_id` (hex) to each image entry
 * whose `abs_path` matches an indexed asset doc. The client uses this id to
 * call `/api/assets/:id` for the enriched detail payload — without it,
 * FS-walk assets never resolve to a Mongo id and the detail panel's
 * enrichment sections stay empty.
 *
 * Real Mongo; skip-passes if MongoDB is unreachable. Mirrors the setup in
 * `assets-overrides.test.ts`: per-pid DB name, close the singleton between
 * phases so the route reads the test DB.
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

const TEST_DB = `maple_test_fs_dir_asset_link_${process.pid}`;
const PRIOR_MONGO_DB = process.env.MAPLE_MONGO_DB;
const MONGO_URI = process.env.MAPLE_MONGO_URI ?? "mongodb://localhost:27017";

let mongo: MongoClient | null = null;
let mongoReachable = false;
let db: Db | null = null;
let tmpRoot: string;
let realTmpRoot: string;
let indexedRawPath: string;
let unindexedRawPath: string;
let indexedAssetId: ObjectId;

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
    try {
      await c.close();
    } catch {}
    return null;
  }
}

describe("GET /api/fs/dir — asset id link", () => {
  beforeAll(async () => {
    process.env.MAPLE_MONGO_DB = TEST_DB;
    mongo = await tryConnect();
    mongoReachable = mongo !== null;
    if (!mongoReachable) {
      console.log(
        "[fs-dir-asset-link.test] skipping: MongoDB unreachable at",
        MONGO_URI,
      );
      return;
    }
    db = mongo!.db(TEST_DB);
    await db.dropDatabase();

    // Reset the singleton so the browse listing's `assetsCollection()` reads
    // the test DB, not whatever was connected first.
    const { closeDb } = await import("../src/db/client.ts");
    await closeDb();

    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "maple-fsdir-link-"));
    realTmpRoot = await fs.realpath(tmpRoot);
    indexedRawPath = path.join(realTmpRoot, "indexed.dng");
    unindexedRawPath = path.join(realTmpRoot, "unindexed.dng");
    await fs.writeFile(indexedRawPath, "raw");
    await fs.writeFile(unindexedRawPath, "raw");

    // Post drop-abs-path-2026-05-21: the browse listing's id-link
    // logic queries by `fileinfo[].filename` + resolves abs_path via
    // `assetAbsPath`. Seed the folder + write the asset with a
    // matching fileinfo[] entry pointing into `tmpRoot`.
    const libraryId = new ObjectId();
    await db.collection("folders").insertOne({
      _id: libraryId,
      path: realTmpRoot,
      label: "fsdir-link-test",
      last_scan: null,
      file_count: 0,
      created_at: new Date().toISOString(),
    } as never);
    const { invalidateLibraryRoots } = await import(
      "../src/indexer/libraries.cache.ts",
    );
    invalidateLibraryRoots();

    indexedAssetId = new ObjectId();
    await db.collection("assets").insertOne({
      _id: indexedAssetId,
      fileinfo: [
        { library_id: libraryId, path: "", filename: "indexed.dng", deleted_at: null },
      ],
      size: 3,
      mtime: Date.now(),
      rating: 0,
      flag: 0,
      color_label: "",
      indexed_at: new Date().toISOString(),
      enrichment: pendingEnrichment(),
      place: null,
      faces: [],
      description: null,
      ocr_text: null,
      search_blob: "",
    } as never);

    process.env.MAPLE_ROOTS = realTmpRoot;
  });

  afterAll(async () => {
    delete process.env.MAPLE_ROOTS;
    if (tmpRoot) await fs.rm(tmpRoot, { recursive: true, force: true });
    if (mongo && mongoReachable) {
      try {
        await mongo.db(TEST_DB).dropDatabase();
      } catch {}
      try {
        await mongo.close();
      } catch {}
    }
    try {
      const { closeDb } = await import("../src/db/client.ts");
      await closeDb();
    } catch {}
    if (PRIOR_MONGO_DB === undefined) delete process.env.MAPLE_MONGO_DB;
    else process.env.MAPLE_MONGO_DB = PRIOR_MONGO_DB;
  });

  it("sets `id` (hex) on entries whose abs_path matches an asset doc; leaves it unset otherwise", async () => {
    if (!mongoReachable) return;
    const { fsRoutes } = await import("../src/routes/fs.ts");
    const res = await fsRoutes.handle(
      new Request(
        `http://localhost/api/fs/dir?path=${encodeURIComponent(realTmpRoot)}`,
      ),
    );
    expect(res.status).toBe(200);
    const json = await res.json();

    const indexed = json.images.find((i: any) => i.name === "indexed.dng");
    const unindexed = json.images.find((i: any) => i.name === "unindexed.dng");
    expect(indexed).toBeDefined();
    expect(unindexed).toBeDefined();

    // Indexed file → `id` is the hex form of the seeded asset's _id.
    expect(indexed.id).toBe(indexedAssetId.toHexString());

    // Un-indexed file → `id` is absent. The discover-on-browse fire-and-
    // forget may have already enqueued an index job; assert it isn't set in
    // this synchronous response.
    expect(unindexed.id).toBeUndefined();
  });
});

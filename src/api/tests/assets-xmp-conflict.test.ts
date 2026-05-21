/**
 * PUT /api/assets/:id/xmp with X-If-Mtime-Matches:
 *  - omitted             → unconditional write, 204, Last-Modified set
 *  - matches on-disk     → atomic overwrite, 204, Last-Modified set
 *  - mismatches on-disk  → conflict-copy file written, 409 + JSON,
 *                          original untouched
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

const TEST_DB = `maple_test_fp2_conflict_${process.pid}`;
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

async function callPut(body: string, headers: Record<string, string> = {}): Promise<Response> {
  const { assetsRoutes } = await import("../src/routes/assets.ts");
  const url = `http://test/api/assets/${assetId.toHexString()}/xmp`;
  return assetsRoutes.handle(
    new Request(url, {
      method: "PUT",
      headers: { "content-type": "text/plain", ...headers },
      body,
    }),
  );
}

describe("PUT /api/assets/:id/xmp — conflict copies", () => {
  beforeAll(async () => {
    // Reset singleton BEFORE setting MAPLE_MONGO_DB so subsequent imports
    // pick up the test DB.
    const { closeDb } = await import("../src/db/client.ts");
    await closeDb();
    process.env.MAPLE_MONGO_DB = TEST_DB;
    mongo = await tryConnect();
    mongoReachable = mongo !== null;
    if (!mongoReachable) return;

    db = mongo!.db(TEST_DB);
    await db.dropDatabase();

    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "maple-fp2-conflict-"));
    realTmpRoot = await fs.realpath(tmpRoot);
    process.env.MAPLE_ROOTS = realTmpRoot;

    rawPath = path.join(realTmpRoot, "IMG_1.ARW");
    xmpPath = path.join(realTmpRoot, "IMG_1.xmp");
    await fs.writeFile(rawPath, new Uint8Array([0xff, 0xd8, 0xff]));

    const now = new Date().toISOString();
    assetId = new ObjectId();
    // Post drop-abs-path-2026-05-21: seed the folder + fileinfo so the
    // route's `findCoreInfoById` / `assetAbsPath` chain resolves
    // `rawPath` from the library root + primary fileinfo entry. The
    // legacy `{ folder_id, abs_path, filename }` triple no longer
    // matters to the route.
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

  it("unconditional write returns 204 with Last-Modified", async () => {
    if (!mongoReachable) return;
    const res = await callPut("<x:xmpmeta>v1</x:xmpmeta>");
    expect(res.status).toBe(204);
    expect(res.headers.get("last-modified")).toBeTruthy();
    const onDisk = await fs.readFile(xmpPath, "utf8");
    expect(onDisk).toContain("v1");
  });

  it("matching precondition overwrites atomically", async () => {
    if (!mongoReachable) return;
    const st = await fs.stat(xmpPath);
    const epoch = Math.floor(st.mtimeMs / 1000);
    const res = await callPut("<x:xmpmeta>v2</x:xmpmeta>", {
      "x-if-mtime-matches": String(epoch),
      "x-maple-device-name": "test-mbp",
    });
    expect(res.status).toBe(204);
    const onDisk = await fs.readFile(xmpPath, "utf8");
    expect(onDisk).toContain("v2");
    const dir = await fs.readdir(realTmpRoot);
    expect(dir.some((f) => f.includes("conflict from"))).toBe(false);
  });

  it("mismatching precondition writes a conflict copy", async () => {
    if (!mongoReachable) return;
    const res = await callPut("<x:xmpmeta>v3-from-B</x:xmpmeta>", {
      "x-if-mtime-matches": "1",
      "x-maple-device-name": "test-laptop-B",
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      conflict_path: string;
      conflict_mtime: string;
    };
    expect(body.conflict_path).toContain("IMG_1 (conflict from test-laptop-B).xmp");
    const onDisk = await fs.readFile(body.conflict_path, "utf8");
    expect(onDisk).toContain("v3-from-B");
    const orig = await fs.readFile(xmpPath, "utf8");
    expect(orig).toContain("v2");
  });

  it("missing device name produces 'Unknown device' conflict file", async () => {
    if (!mongoReachable) return;
    const res = await callPut("<x:xmpmeta>v4</x:xmpmeta>", {
      "x-if-mtime-matches": "1",
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { conflict_path: string };
    expect(body.conflict_path).toContain("(conflict from Unknown device)");
  });
});

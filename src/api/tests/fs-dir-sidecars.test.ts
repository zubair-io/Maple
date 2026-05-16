/**
 * `/api/fs/dir` returns a `sidecars[]` array containing every `.xmp`
 * file whose canonical base (with optional "(conflict from …)" suffix
 * stripped) pairs to an indexed image in the same directory.
 *
 * Real Mongo; skip-passes if MongoDB is unreachable. Same pattern as
 * fs-dir-asset-link.test.ts.
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

const TEST_DB = `maple_test_fs_dir_sidecars_${process.pid}`;
const PRIOR_MONGO_DB = process.env.MAPLE_MONGO_DB;
const MONGO_URI = process.env.MAPLE_MONGO_URI ?? "mongodb://localhost:27017";

let mongo: MongoClient | null = null;
let mongoReachable = false;
let db: Db | null = null;
let tmpRoot: string;
let realTmpRoot: string;
let rawPath: string;
let canonicalXmpPath: string;
let conflictXmpPath: string;
let orphanXmpPath: string;
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
    try {
      await c.close();
    } catch {}
    return null;
  }
}

describe("GET /api/fs/dir — sidecars[] pairing", () => {
  beforeAll(async () => {
    process.env.MAPLE_MONGO_DB = TEST_DB;
    mongo = await tryConnect();
    mongoReachable = mongo !== null;
    if (!mongoReachable) {
      console.log(
        "[fs-dir-sidecars.test] skipping: MongoDB unreachable at",
        MONGO_URI,
      );
      return;
    }

    db = mongo!.db(TEST_DB);
    await db.dropDatabase();

    // Reset the singleton so the route's assetsCollection() reads the test DB.
    const { closeDb } = await import("../src/db/client.ts");
    await closeDb();

    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "maple-fp2-fsdir-"));
    realTmpRoot = await fs.realpath(tmpRoot);
    process.env.MAPLE_ROOTS = realTmpRoot;

    // Write fixture files.
    rawPath = path.join(realTmpRoot, "IMG_1.ARW");
    canonicalXmpPath = path.join(realTmpRoot, "IMG_1.xmp");
    conflictXmpPath = path.join(realTmpRoot, "IMG_1 (conflict from MacBook).xmp");
    const numberedConflictXmpPath = path.join(realTmpRoot, "IMG_1 (conflict from MacBook) (2).xmp");
    orphanXmpPath = path.join(realTmpRoot, "DSCF0001.xmp");
    await fs.writeFile(rawPath, new Uint8Array([0xff, 0xd8, 0xff]));
    await fs.writeFile(canonicalXmpPath, "<x:xmpmeta/>");
    await fs.writeFile(conflictXmpPath, "<x:xmpmeta/>");
    await fs.writeFile(numberedConflictXmpPath, "<x:xmpmeta/>");
    await fs.writeFile(orphanXmpPath, "<x:xmpmeta/>");

    // Index the RAW — full shape matching the schema so insert doesn't fail.
    assetId = new ObjectId();
    await db.collection("assets").insertOne({
      _id: assetId,
      folder_id: new ObjectId(),
      filename: "IMG_1.ARW",
      abs_path: rawPath,
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
  });

  afterAll(async () => {
    delete process.env.MAPLE_ROOTS;
    if (tmpRoot) {
      try {
        await fs.rm(tmpRoot, { recursive: true, force: true });
      } catch {}
    }
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

  it("pairs canonical + conflict sidecars to the same asset", async () => {
    if (!mongoReachable) return;
    const { fsRoutes } = await import("../src/routes/fs.ts");
    const url = `http://localhost/api/fs/dir?path=${encodeURIComponent(realTmpRoot)}`;
    const res = await fsRoutes.handle(new Request(url));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sidecars: Array<{ name: string; asset_id: string }>;
    };
    const names = body.sidecars.map((s) => s.name).sort();
    expect(names).toEqual([
      "IMG_1 (conflict from MacBook) (2).xmp",
      "IMG_1 (conflict from MacBook).xmp",
      "IMG_1.xmp",
    ]);
    for (const s of body.sidecars) {
      expect(s.asset_id).toBe(assetId.toHexString());
    }
  });

  it("drops orphan sidecars (no paired indexed asset)", async () => {
    if (!mongoReachable) return;
    const { fsRoutes } = await import("../src/routes/fs.ts");
    const url = `http://localhost/api/fs/dir?path=${encodeURIComponent(realTmpRoot)}`;
    const res = await fsRoutes.handle(new Request(url));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sidecars: Array<{ name: string }>;
    };
    expect(body.sidecars.find((s) => s.name === "DSCF0001.xmp")).toBeUndefined();
  });
});

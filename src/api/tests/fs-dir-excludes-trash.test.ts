import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { MongoClient, ObjectId, type Db } from "mongodb";
import { signAccessToken } from "../src/auth/tokens.ts";

process.env.MAPLE_JWT_SECRET = "x".repeat(32);
const BEARER = "Bearer " + signAccessToken(
  { sub: "00000000000000000000000a", email: "tester@maple.local", role: "owner" },
  process.env.MAPLE_JWT_SECRET!,
);

const TEST_DB = `maple_test_fp3_dir_excl_${process.pid}`;
const PRIOR_MONGO_DB = process.env.MAPLE_MONGO_DB;
const PRIOR_MAPLE_ROOTS = process.env.MAPLE_ROOTS;
const MONGO_URI = process.env.MAPLE_MONGO_URI ?? "mongodb://localhost:27017";

let mongo: MongoClient | null = null;
let mongoReachable = false;
let db: Db | null = null;
let tmpRoot: string;
let realTmpRoot: string;
let folderId: ObjectId;

async function tryConnect(): Promise<MongoClient | null> {
  const c = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 1500, connectTimeoutMS: 1500 });
  try { await c.connect(); await c.db("admin").command({ ping: 1 }); return c; }
  catch { try { await c.close(); } catch {}; return null; }
}

describe("GET /api/fs/dir excludes trashed assets", () => {
  beforeAll(async () => {
    const { closeDb } = await import("../src/db/client.ts");
    await closeDb();
    process.env.MAPLE_MONGO_DB = TEST_DB;
    mongo = await tryConnect();
    mongoReachable = mongo !== null;
    if (!mongoReachable) return;
    db = mongo!.db(TEST_DB);
    await db.dropDatabase();
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "maple-fp3-dirx-"));
    realTmpRoot = await fs.realpath(tmpRoot);
    process.env.MAPLE_ROOTS = realTmpRoot;
    folderId = new ObjectId();
    await db.collection("folders").insertOne({
      _id: folderId, path: realTmpRoot, label: "t",
      created_at: new Date().toISOString(), file_count: 0,
    } as never);
  });

  afterAll(async () => {
    // Close the APP DB client first so it doesn't leak across tests
    // (the routes import the `getDb()` singleton). Pattern mirrors
    // assets-xmp-delete.test.ts.
    const { closeDb } = await import("../src/db/client.ts");
    await closeDb();
    if (mongo) {
      try { await mongo.db(TEST_DB).dropDatabase(); } catch {}
      await mongo.close();
    }
    if (tmpRoot) await fs.rm(tmpRoot, { recursive: true, force: true });
    if (PRIOR_MONGO_DB === undefined) delete process.env.MAPLE_MONGO_DB;
    else process.env.MAPLE_MONGO_DB = PRIOR_MONGO_DB;
    if (PRIOR_MAPLE_ROOTS === undefined) delete process.env.MAPLE_ROOTS;
    else process.env.MAPLE_ROOTS = PRIOR_MAPLE_ROOTS;
  });

  test("if an indexed file is trashed but somehow still on disk, listing omits it", async () => {
    if (!mongoReachable) return;
    const live = path.join(realTmpRoot, "live.ARW");
    const ghost = path.join(realTmpRoot, "ghost.ARW");
    await fs.writeFile(live, "live");
    await fs.writeFile(ghost, "ghost");
    await db!.collection("assets").insertMany([
      { _id: new ObjectId(), folder_id: folderId, filename: "live.ARW", abs_path: live, size: 4, mtime: Date.now(), indexed_at: new Date().toISOString(), deleted_at: null } as never,
      { _id: new ObjectId(), folder_id: folderId, filename: "ghost.ARW", abs_path: ghost, size: 5, mtime: Date.now(), indexed_at: new Date().toISOString(), deleted_at: new Date().toISOString(), original_path: ghost } as never,
    ]);

    const { app } = await import("../src/index.ts");
    const res = await app.handle(new Request(`http://localhost/api/fs/dir?path=${encodeURIComponent(realTmpRoot)}`, {
      headers: { Authorization: BEARER },
    }));
    expect(res.status).toBe(200);
    const body = await res.json() as { images: Array<{ name: string }> };
    const names = body.images.map((i) => i.name).sort();
    expect(names).toEqual(["live.ARW"]);
  });
});

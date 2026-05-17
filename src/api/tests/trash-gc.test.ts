import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { MongoClient, ObjectId, type Db } from "mongodb";
import { runTrashGcOnce } from "../src/workers/trash-gc.ts";

const TEST_DB = `maple_test_fp3_trash_gc_${process.pid}`;
const PRIOR_MONGO_DB = process.env.MAPLE_MONGO_DB;
const PRIOR_MAPLE_ROOTS = process.env.MAPLE_ROOTS;
const MONGO_URI = process.env.MAPLE_MONGO_URI ?? "mongodb://localhost:27017";

let mongo: MongoClient | null = null;
let mongoReachable = false;
let db: Db | null = null;
let tmpRoot: string;
let realTmpRoot: string;

async function tryConnect(): Promise<MongoClient | null> {
  const c = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 1500, connectTimeoutMS: 1500 });
  try { await c.connect(); await c.db("admin").command({ ping: 1 }); return c; }
  catch { try { await c.close(); } catch {}; return null; }
}

describe("trash-gc", () => {
  beforeAll(async () => {
    const { closeDb } = await import("../src/db/client.ts");
    await closeDb();
    process.env.MAPLE_MONGO_DB = TEST_DB;
    mongo = await tryConnect();
    mongoReachable = mongo !== null;
    if (!mongoReachable) return;
    db = mongo!.db(TEST_DB);
    await db.dropDatabase();
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "maple-fp3-gc-"));
    realTmpRoot = await fs.realpath(tmpRoot);
    process.env.MAPLE_ROOTS = realTmpRoot;
  });

  afterAll(async () => {
    // Close the APP DB client first so it doesn't leak across tests
    // (`runTrashGcOnce` uses the `getDb()` singleton). Pattern mirrors
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

  test("purges files + docs older than the retention window; preserves fresh", async () => {
    if (!mongoReachable) return;
    const old = path.join(realTmpRoot, ".maple", "trash", "old.ARW");
    const oldXmp = path.join(realTmpRoot, ".maple", "trash", "old.xmp");
    const fresh = path.join(realTmpRoot, ".maple", "trash", "fresh.ARW");
    await fs.mkdir(path.dirname(old), { recursive: true });
    await fs.writeFile(old, "o"); await fs.writeFile(oldXmp, "ox"); await fs.writeFile(fresh, "f");

    const oldId = new ObjectId(); const freshId = new ObjectId(); const liveId = new ObjectId();
    const days = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
    await db!.collection("assets").insertMany([
      { _id: oldId, folder_id: new ObjectId(), filename: "old.ARW", abs_path: old, size: 1, mtime: 0, indexed_at: days(60), deleted_at: days(31), original_path: "/x/old.ARW" } as never,
      { _id: freshId, folder_id: new ObjectId(), filename: "fresh.ARW", abs_path: fresh, size: 1, mtime: 0, indexed_at: days(60), deleted_at: days(7), original_path: "/x/fresh.ARW" } as never,
      { _id: liveId, folder_id: new ObjectId(), filename: "live.ARW", abs_path: path.join(realTmpRoot, "live.ARW"), size: 1, mtime: 0, indexed_at: days(1), deleted_at: null } as never,
    ]);

    const summary = await runTrashGcOnce({ retentionDays: 30 });
    expect(summary.purged).toBe(1);

    await expect(fs.stat(old)).rejects.toThrow();
    await expect(fs.stat(oldXmp)).rejects.toThrow();
    await fs.stat(fresh);
    expect(await db!.collection("assets").findOne({ _id: oldId })).toBeNull();
    expect(await db!.collection("assets").findOne({ _id: freshId })).not.toBeNull();
    expect(await db!.collection("assets").findOne({ _id: liveId })).not.toBeNull();
  });
});

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

const TEST_DB = `maple_test_fp3_trash_list_${process.pid}`;
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

describe("GET /api/folders/:id/trash", () => {
  beforeAll(async () => {
    const { closeDb } = await import("../src/db/client.ts");
    await closeDb();
    process.env.MAPLE_MONGO_DB = TEST_DB;
    mongo = await tryConnect();
    mongoReachable = mongo !== null;
    if (!mongoReachable) return;
    db = mongo!.db(TEST_DB);
    await db.dropDatabase();
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "maple-fp3-tlist-"));
    realTmpRoot = await fs.realpath(tmpRoot);
    process.env.MAPLE_ROOTS = realTmpRoot;
    folderId = new ObjectId();
    await db.collection("folders").insertOne({
      _id: folderId, path: realTmpRoot, label: "t",
      created_at: new Date().toISOString(), file_count: 0,
    } as never);
    // Three trashed assets at different times.
    const now = Date.now();
    for (let i = 0; i < 3; i++) {
      const filename = `T${i}.ARW`;
      const trash = path.join(realTmpRoot, ".maple", "trash", filename);
      await fs.mkdir(path.dirname(trash), { recursive: true });
      await fs.writeFile(trash, `r${i}`);
      await db.collection("assets").insertOne({
        _id: new ObjectId(),
        folder_id: folderId,
        filename, abs_path: trash, size: 2, mtime: now,
        indexed_at: new Date().toISOString(),
        deleted_at: new Date(now - i * 1000).toISOString(),
        original_path: path.join(realTmpRoot, filename),
      } as never);
    }
    // One vanished (watcher-removed) asset — deleted_at set, original_path absent.
    await db.collection("assets").insertOne({
      _id: new ObjectId(),
      folder_id: folderId,
      filename: "vanished.ARW",
      abs_path: path.join(realTmpRoot, "vanished.ARW"),
      size: 0, mtime: now, indexed_at: new Date().toISOString(),
      deleted_at: new Date().toISOString(),
    } as never);
  });

  afterAll(async () => {
    if (tmpRoot) await fs.rm(tmpRoot, { recursive: true, force: true });
    if (mongo) await mongo.close();
  });

  test("returns trashed assets newest-first, excludes vanished (no original_path)", async () => {
    if (!mongoReachable) return;
    const { app } = await import("../src/index.ts");
    const res = await app.handle(new Request(`http://localhost/api/folders/${folderId.toHexString()}/trash`, {
      headers: { Authorization: BEARER },
    }));
    expect(res.status).toBe(200);
    const body = await res.json() as { items: Array<{ filename: string; original_relative_path: string; deleted_at: string; mtime: string }>; next_cursor: string | null };
    expect(body.items).toHaveLength(3);
    expect(body.items[0].filename).toBe("T0.ARW");
    expect(body.items[2].filename).toBe("T2.ARW");
    expect(body.items[0].original_relative_path).toBe("T0.ARW");
    // mtime must be emitted as ISO-8601 (not epoch-ms float) — the
    // Swift Date decoder cannot otherwise consume it.
    expect(typeof body.items[0].mtime).toBe("string");
    expect(body.items[0].mtime).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  test("400 on non-numeric limit (regression: NaN→500 via .limit())", async () => {
    if (!mongoReachable) return;
    const { app } = await import("../src/index.ts");
    const res = await app.handle(new Request(`http://localhost/api/folders/${folderId.toHexString()}/trash?limit=abc`, {
      headers: { Authorization: BEARER },
    }));
    expect(res.status).toBe(400);
  });

  test("400 on negative limit", async () => {
    if (!mongoReachable) return;
    const { app } = await import("../src/index.ts");
    const res = await app.handle(new Request(`http://localhost/api/folders/${folderId.toHexString()}/trash?limit=-1`, {
      headers: { Authorization: BEARER },
    }));
    expect(res.status).toBe(400);
  });

  test("pagination via limit + cursor returns subsequent page", async () => {
    if (!mongoReachable) return;
    const { app } = await import("../src/index.ts");
    const first = await app.handle(new Request(`http://localhost/api/folders/${folderId.toHexString()}/trash?limit=2`, {
      headers: { Authorization: BEARER },
    }));
    const firstBody = await first.json() as { items: Array<{ filename: string }>; next_cursor: string | null };
    expect(firstBody.items).toHaveLength(2);
    expect(firstBody.next_cursor).toBeTruthy();
    const second = await app.handle(new Request(`http://localhost/api/folders/${folderId.toHexString()}/trash?limit=2&cursor=${encodeURIComponent(firstBody.next_cursor!)}`, {
      headers: { Authorization: BEARER },
    }));
    const secondBody = await second.json() as { items: Array<{ filename: string }>; next_cursor: string | null };
    expect(secondBody.items).toHaveLength(1);
    expect(secondBody.items[0].filename).toBe("T2.ARW");
    expect(secondBody.next_cursor).toBeNull();
  });
});

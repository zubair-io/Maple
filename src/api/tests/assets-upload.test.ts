import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { MongoClient, ObjectId, type Db } from "mongodb";
import { signAccessToken } from "../src/auth/tokens.ts";

// JWT bootstrap MUST run before any module that touches `requireAuth`.
process.env.MAPLE_JWT_SECRET = "x".repeat(32);
const BEARER = "Bearer " + signAccessToken(
  { sub: "00000000000000000000000a", email: "tester@maple.local", role: "owner" },
  process.env.MAPLE_JWT_SECRET!,
);

const TEST_DB = `maple_test_fp3_upload_${process.pid}`;
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

describe("POST /api/folders/:id/upload", () => {
  beforeAll(async () => {
    const { closeDb } = await import("../src/db/client.ts");
    await closeDb();
    process.env.MAPLE_MONGO_DB = TEST_DB;
    mongo = await tryConnect();
    mongoReachable = mongo !== null;
    if (!mongoReachable) return;

    db = mongo!.db(TEST_DB);
    await db.dropDatabase();

    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "maple-fp3-upload-"));
    realTmpRoot = await fs.realpath(tmpRoot);
    process.env.MAPLE_ROOTS = realTmpRoot;

    folderId = new ObjectId();
    await db.collection("folders").insertOne({
      _id: folderId, path: realTmpRoot, label: "test",
      created_at: new Date().toISOString(), file_count: 0,
    } as never);
  });

  afterAll(async () => {
    if (tmpRoot) await fs.rm(tmpRoot, { recursive: true, force: true });
    if (mongo) await mongo.close();
  });

  function upload(body: Buffer, headers: Record<string, string>): Request {
    return new Request(`http://localhost/api/folders/${folderId.toHexString()}/upload`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream", "Content-Length": String(body.byteLength), Authorization: BEARER, ...headers },
      body,
    });
  }

  test("happy path: ARW upload writes file + inserts asset doc with stages skeleton", async () => {
    if (!mongoReachable) return;
    const { app } = await import("../src/index.ts");
    const bytes = Buffer.alloc(64, 7);
    const res = await app.handle(upload(bytes, {
      "X-Maple-Target-Path": "2024/IMG_42.ARW",
    }));
    expect(res.status).toBe(201);
    const body = await res.json() as { asset_id: string; abs_path: string; size: number };
    expect(body.size).toBe(64);
    expect(body.abs_path).toBe(path.join(realTmpRoot, "2024", "IMG_42.ARW"));
    const onDisk = await fs.readFile(body.abs_path);
    expect(onDisk.byteLength).toBe(64);

    const doc = await db!.collection("assets").findOne({ _id: new ObjectId(body.asset_id) });
    expect(doc).toBeTruthy();
    expect((doc as Record<string, unknown>).deleted_at).toBeNull();
    expect((doc as Record<string, unknown>).stages).toBeDefined();
    // Every stage must be initialised pending so controllers pick it up.
    const stages = (doc as Record<string, unknown>).stages as Record<string, { version: number; processed_at: null }>;
    for (const stage of ["hash", "exif", "thumb", "face", "ocr", "describe", "geocode", "meili"]) {
      expect(stages[stage]).toBeDefined();
      expect(stages[stage].version).toBe(0);
      expect(stages[stage].processed_at).toBeNull();
    }
  });

  test("415 on unsupported extension; no file on disk, no asset doc", async () => {
    if (!mongoReachable) return;
    const { app } = await import("../src/index.ts");
    const res = await app.handle(upload(Buffer.from("hello"), {
      "X-Maple-Target-Path": "notes.txt",
    }));
    expect(res.status).toBe(415);
    await expect(fs.stat(path.join(realTmpRoot, "notes.txt"))).rejects.toThrow();
    const doc = await db!.collection("assets").findOne({ abs_path: path.join(realTmpRoot, "notes.txt") });
    expect(doc).toBeNull();
  });

  test("400 on path-escape attempt", async () => {
    if (!mongoReachable) return;
    const { app } = await import("../src/index.ts");
    const res = await app.handle(upload(Buffer.from("x"), {
      "X-Maple-Target-Path": "../../etc/IMG.ARW",
    }));
    expect(res.status).toBe(400);
  });

  test("400 on absolute path", async () => {
    if (!mongoReachable) return;
    const { app } = await import("../src/index.ts");
    const res = await app.handle(upload(Buffer.from("x"), {
      "X-Maple-Target-Path": "/etc/IMG.ARW",
    }));
    expect(res.status).toBe(400);
  });

  test("400 on leading-dot path component (would land in .maple/)", async () => {
    if (!mongoReachable) return;
    const { app } = await import("../src/index.ts");
    const res = await app.handle(upload(Buffer.from("x"), {
      "X-Maple-Target-Path": ".maple/IMG.ARW",
    }));
    expect(res.status).toBe(400);
  });

  test("404 on unknown folder id", async () => {
    if (!mongoReachable) return;
    const { app } = await import("../src/index.ts");
    const otherId = new ObjectId().toHexString();
    const res = await app.handle(new Request(`http://localhost/api/folders/${otherId}/upload`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream", "Content-Length": "1", "X-Maple-Target-Path": "x.ARW", Authorization: BEARER },
      body: Buffer.from("x"),
    }));
    expect(res.status).toBe(404);
  });

  test("409 when target file already exists", async () => {
    if (!mongoReachable) return;
    const { app } = await import("../src/index.ts");
    const dest = path.join(realTmpRoot, "exists.ARW");
    await fs.writeFile(dest, "old");
    const res = await app.handle(upload(Buffer.from("new"), {
      "X-Maple-Target-Path": "exists.ARW",
    }));
    expect(res.status).toBe(409);
    expect(await fs.readFile(dest, "utf-8")).toBe("old");
  });
});

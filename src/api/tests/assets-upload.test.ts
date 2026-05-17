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
    const body = await res.json() as { asset_id: string; abs_path: string; size: number; mtime: string };
    expect(body.size).toBe(64);
    expect(body.abs_path).toBe(path.join(realTmpRoot, "2024", "IMG_42.ARW"));
    // mtime must be ISO-8601 (Swift Date decoder expects this format).
    expect(typeof body.mtime).toBe("string");
    expect(body.mtime).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
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

  test("400 on malformed percent-escape in X-Maple-Target-Path", async () => {
    if (!mongoReachable) return;
    const { app } = await import("../src/index.ts");
    // `%ZZ` is not a valid percent escape; decodeURIComponent throws
    // URIError. The route must surface 400 instead of falling through
    // to the global 500 handler.
    const res = await app.handle(upload(Buffer.from("x"), {
      "X-Maple-Target-Path": "broken%ZZ.ARW",
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

  // Regression: Cat A1+A4 — a soft-deleted asset under the same filename
  // must NOT block a fresh upload. Previously the `{folder_id, filename}`
  // unique index reserved the trashed row's filename, so re-uploading
  // `A.jpg` after trashing the original failed with 409. The fix makes
  // the unique index partial (`deleted_at: null`).
  test("re-upload after soft-delete with the same filename succeeds", async () => {
    if (!mongoReachable) return;
    const { app } = await import("../src/index.ts");
    // Seed: a previously-soft-deleted asset under the upload's intended name.
    await db!.collection("assets").insertOne({
      _id: new ObjectId(),
      folder_id: folderId,
      filename: "REUSE.ARW",
      abs_path: path.join(realTmpRoot, ".maple", "trash", "REUSE.ARW"),
      size: 1, mtime: Date.now(),
      indexed_at: new Date().toISOString(),
      deleted_at: new Date().toISOString(),
      original_path: path.join(realTmpRoot, "REUSE.ARW"),
    } as never);

    const res = await app.handle(upload(Buffer.alloc(4, 9), {
      "X-Maple-Target-Path": "REUSE.ARW",
    }));
    expect(res.status).toBe(201);
    // Both rows now exist — the trashed one and the new live one.
    const all = await db!.collection("assets").find({ folder_id: folderId, filename: "REUSE.ARW" }).toArray();
    expect(all.length).toBe(2);
    const live = all.find((d) => (d as Record<string, unknown>).deleted_at === null);
    expect(live).toBeTruthy();
  });

  // Regression: the previous implementation used a stat-then-rename pattern
  // that left a TOCTOU window — two concurrent uploads to the same target
  // both saw `stat` ENOENT, both wrote distinct tmps, and the second
  // `rename` silently overwrote the first. Two asset docs ended up
  // pointing at the same `abs_path`. The fix uses `open(target, "wx")`
  // (O_EXCL) to atomically claim the target before writing — second
  // claimant gets EEXIST → 409.
  test("concurrent uploads to the same target: one 201, one 409, one file, one asset doc", async () => {
    if (!mongoReachable) return;
    const { app } = await import("../src/index.ts");
    const targetRel = "race/IMG_RACE.ARW";
    const dest = path.join(realTmpRoot, targetRel);

    // Issue both requests as close to simultaneously as possible. The
    // claim happens early in the handler (before the async writeFile),
    // so even with cooperative scheduling one of them must lose the race.
    const [resA, resB] = await Promise.all([
      app.handle(upload(Buffer.alloc(32, 1), { "X-Maple-Target-Path": targetRel })),
      app.handle(upload(Buffer.alloc(32, 2), { "X-Maple-Target-Path": targetRel })),
    ]);

    const statuses = [resA.status, resB.status].sort();
    expect(statuses).toEqual([201, 409]);

    // Exactly one asset doc, exactly one file on disk.
    const winner = resA.status === 201 ? resA : resB;
    const winnerBody = await winner.json() as { asset_id: string; abs_path: string; size: number };
    expect(winnerBody.abs_path).toBe(dest);
    expect(winnerBody.size).toBe(32);

    const onDisk = await fs.readFile(dest);
    expect(onDisk.byteLength).toBe(32);

    const docs = await db!.collection("assets").find({ abs_path: dest }).toArray();
    expect(docs.length).toBe(1);
    expect(docs[0]!._id.toHexString()).toBe(winnerBody.asset_id);

    // The loser must not have left a tmp file or partial state in the dir.
    const dirEntries = await fs.readdir(path.dirname(dest));
    const tmps = dirEntries.filter((n) => n.startsWith(".upload-"));
    expect(tmps).toEqual([]);
  });
});

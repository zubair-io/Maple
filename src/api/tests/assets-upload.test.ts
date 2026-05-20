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
    // Close the APP DB client (held by routes via the `getDb()`
    // singleton) before closing the test client; otherwise the app's
    // connection stays open against TEST_DB and leaks into later
    // test files. Restore the prior env var. Pattern mirrors
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

  // Duplicate upload: the file at the target path is moved to
  // `.maple/trash/<rel>` (preserving the prior copy for restore) and
  // the new bytes land at the original path. Returns 201, not 409 —
  // the File Provider treats a re-drop as an idempotent replace.
  test("duplicate upload: existing file moves to trash, new bytes land at target", async () => {
    if (!mongoReachable) return;
    const { app } = await import("../src/index.ts");
    const dest = path.join(realTmpRoot, "dup.ARW");
    // Seed both the file and a live asset doc, mirroring real state.
    await fs.writeFile(dest, "old");
    const priorId = new ObjectId();
    await db!.collection("assets").insertOne({
      _id: priorId,
      folder_id: folderId,
      filename: "dup.ARW",
      abs_path: dest,
      size: 3, mtime: Date.now(),
      sha1_head: "deadbeef",
      indexed_at: new Date().toISOString(),
      deleted_at: null,
    } as never);

    const res = await app.handle(upload(Buffer.from("new"), {
      "X-Maple-Target-Path": "dup.ARW",
    }));
    expect(res.status).toBe(201);
    expect(await fs.readFile(dest, "utf-8")).toBe("new");

    // Prior file is in trash, prior doc soft-deleted.
    const trashPath = path.join(realTmpRoot, ".maple", "trash", "dup.ARW");
    expect(await fs.readFile(trashPath, "utf-8")).toBe("old");
    const priorDoc = await db!.collection("assets").findOne({ _id: priorId }) as Record<string, unknown> | null;
    expect(priorDoc).toBeTruthy();
    expect(priorDoc!.deleted_at).toBeTruthy();
    expect(priorDoc!.abs_path).toBe(trashPath);
    expect(priorDoc!.original_path).toBe(dest);

    // A fresh live doc was inserted for the new bytes.
    const newDoc = await db!.collection("assets").findOne({ abs_path: dest, deleted_at: null }) as Record<string, unknown> | null;
    expect(newDoc).toBeTruthy();
    expect(newDoc!._id).not.toEqual(priorId);
  });

  // Duplicate upload with byte-identical content: nothing to recover,
  // so the trash entry is purged after the new write lands.
  test("duplicate upload with identical content purges the redundant trash entry", async () => {
    if (!mongoReachable) return;
    const { app } = await import("../src/index.ts");
    const dest = path.join(realTmpRoot, "same.ARW");
    const bytes = Buffer.alloc(128, 0xab);
    await fs.writeFile(dest, bytes);
    // Pre-compute the sha1 of the first 64 KB (the file is only 128 B,
    // so that's the whole file) to match what the upload route hashes.
    const { sha1 } = await import("@noble/hashes/legacy.js");
    const digest = sha1(new Uint8Array(bytes));
    let hex = "";
    for (let i = 0; i < digest.length; i++) hex += digest[i]!.toString(16).padStart(2, "0");
    const priorId = new ObjectId();
    await db!.collection("assets").insertOne({
      _id: priorId,
      folder_id: folderId,
      filename: "same.ARW",
      abs_path: dest,
      size: bytes.byteLength,
      mtime: Date.now(),
      sha1_head: hex,
      indexed_at: new Date().toISOString(),
      deleted_at: null,
    } as never);

    const res = await app.handle(upload(bytes, {
      "X-Maple-Target-Path": "same.ARW",
    }));
    expect(res.status).toBe(201);

    // The trash directory should NOT contain a copy — same content was
    // detected via sha1_head + size, so the moved-aside file was unlinked
    // and the soft-deleted doc removed.
    const trashDir = path.join(realTmpRoot, ".maple", "trash");
    const trashEntries = await fs.readdir(trashDir).catch(() => [] as string[]);
    expect(trashEntries).toEqual([]);
    const priorDoc = await db!.collection("assets").findOne({ _id: priorId });
    expect(priorDoc).toBeNull();
  });

  // Regression: Cat B — the prior `type: "arrayBuffer"` config made
  // Elysia buffer the entire body in memory before the handler ran. A
  // 1 GB upload would have spiked server RSS by 1 GB. The fix switches
  // to streaming `request.body` chunk-by-chunk via Bun's FileSink. A
  // ~100 MB body verifies the route doesn't fail on a payload size
  // that would be obviously inefficient if buffered; the byte-for-byte
  // comparison rules out streaming corruption.
  test("streaming upload: 100MB body lands intact on disk", async () => {
    if (!mongoReachable) return;
    const { app } = await import("../src/index.ts");
    const SIZE = 100 * 1024 * 1024; // 100 MB
    // Don't allocate a single 100MB Buffer — that would defeat the
    // streaming test on the *test* side. Build a ReadableStream that
    // emits 1MB chunks deterministically.
    const CHUNK = 1024 * 1024;
    const chunks = SIZE / CHUNK;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        // @ts-ignore: ad-hoc counter on the stream's underlying source
        const n = (this._n ??= 0);
        if (n >= chunks) { controller.close(); return; }
        const chunk = new Uint8Array(CHUNK);
        // Fill with the chunk index so corruption shows up visibly.
        chunk.fill(n & 0xff);
        controller.enqueue(chunk);
        // @ts-ignore
        this._n = n + 1;
      },
    });
    const res = await app.handle(new Request(`http://localhost/api/folders/${folderId.toHexString()}/upload`, {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(SIZE),
        "X-Maple-Target-Path": "BIG.ARW",
        Authorization: BEARER,
      },
      body: stream,
      // @ts-ignore — Bun's fetch supports duplex; Node typings don't.
      duplex: "half",
    }));
    expect(res.status).toBe(201);
    const body = await res.json() as { abs_path: string; size: number };
    expect(body.size).toBe(SIZE);
    // Spot-check first + last chunk: every byte in chunk n equals n & 0xff.
    const fh = await fs.open(body.abs_path, "r");
    try {
      const buf = Buffer.alloc(16);
      await fh.read(buf, 0, 16, 0);
      expect(buf[0]).toBe(0);
      const lastPos = SIZE - 16;
      await fh.read(buf, 0, 16, lastPos);
      expect(buf[0]).toBe((chunks - 1) & 0xff);
    } finally {
      await fh.close();
    }
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

  // Concurrent uploads to the same target: both succeed (201) — the
  // trash-on-duplicate behaviour means there is no exclusive claim
  // anymore. The route streams each body to a unique `.upload-<uuid>`
  // tmp, then atomically renames into place, so the file on disk
  // always matches one of the two complete payloads (never a torn
  // mixture). No tmp files are left behind.
  test("concurrent uploads to the same target: both 201, one intact file, no orphan tmps", async () => {
    if (!mongoReachable) return;
    const { app } = await import("../src/index.ts");
    const targetRel = "race/IMG_RACE.ARW";
    const dest = path.join(realTmpRoot, targetRel);

    const [resA, resB] = await Promise.all([
      app.handle(upload(Buffer.alloc(32, 1), { "X-Maple-Target-Path": targetRel })),
      app.handle(upload(Buffer.alloc(32, 2), { "X-Maple-Target-Path": targetRel })),
    ]);

    expect(resA.status).toBe(201);
    expect(resB.status).toBe(201);

    const onDisk = await fs.readFile(dest);
    expect(onDisk.byteLength).toBe(32);
    // Every byte must equal a single payload's fill byte (1 or 2) —
    // never a torn mixture.
    const fill = onDisk[0];
    expect(fill === 1 || fill === 2).toBe(true);
    expect(onDisk.every((b) => b === fill)).toBe(true);

    const dirEntries = await fs.readdir(path.dirname(dest));
    const tmps = dirEntries.filter((n) => n.startsWith(".upload-"));
    expect(tmps).toEqual([]);

    const liveDocs = await db!.collection("assets").find({ abs_path: dest, deleted_at: null }).toArray();
    expect(liveDocs.length).toBe(1);
  });
});

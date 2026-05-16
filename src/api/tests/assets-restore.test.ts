import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { MongoClient, ObjectId, type Db } from "mongodb";
import { pendingEnrichment } from "../src/db/schema.ts";
import { signAccessToken } from "../src/auth/tokens.ts";

process.env.MAPLE_JWT_SECRET = "x".repeat(32);
const BEARER = "Bearer " + signAccessToken(
  { sub: "00000000000000000000000a", email: "tester@maple.local", role: "owner" },
  process.env.MAPLE_JWT_SECRET!,
);

const TEST_DB = `maple_test_fp3_restore_${process.pid}`;
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

async function trashedAsset(filename: string): Promise<{ assetId: ObjectId; originalPath: string; trashPath: string }> {
  const originalPath = path.join(realTmpRoot, "2024", filename);
  const trashPath = path.join(realTmpRoot, ".maple", "trash", "2024", filename);
  await fs.mkdir(path.dirname(originalPath), { recursive: true });
  await fs.mkdir(path.dirname(trashPath), { recursive: true });
  await fs.writeFile(trashPath, "raw");
  const assetId = new ObjectId();
  await db!.collection("assets").insertOne({
    _id: assetId,
    folder_id: folderId,
    filename,
    abs_path: trashPath,
    size: 3,
    mtime: Date.now(),
    indexed_at: new Date().toISOString(),
    deleted_at: new Date().toISOString(),
    original_path: originalPath,
    enrichment: pendingEnrichment(),
  } as never);
  return { assetId, originalPath, trashPath };
}

function jsonReq(url: string, body: Record<string, unknown>): Request {
  return new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: BEARER },
    body: JSON.stringify(body),
  });
}

describe("POST /api/assets/:id/restore", () => {
  beforeAll(async () => {
    const { closeDb } = await import("../src/db/client.ts");
    await closeDb();
    process.env.MAPLE_MONGO_DB = TEST_DB;
    mongo = await tryConnect();
    mongoReachable = mongo !== null;
    if (!mongoReachable) return;
    db = mongo!.db(TEST_DB);
    await db.dropDatabase();
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "maple-fp3-restore-"));
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

  test("restores to original_path; clears deleted_at + original_path", async () => {
    if (!mongoReachable) return;
    const { app } = await import("../src/index.ts");
    const { assetId, originalPath, trashPath } = await trashedAsset("IMG_R1.ARW");

    const res = await app.handle(jsonReq(`http://localhost/api/assets/${assetId.toHexString()}/restore`, {}));
    expect(res.status).toBe(200);
    const body = await res.json() as { abs_path: string };
    expect(body.abs_path).toBe(originalPath);

    await fs.stat(originalPath);
    await expect(fs.stat(trashPath)).rejects.toThrow();
    const doc = await db!.collection("assets").findOne({ _id: assetId }) as Record<string, unknown>;
    expect(doc.deleted_at).toBeNull();
    expect(doc.original_path).toBeNull();
    expect(doc.abs_path).toBe(originalPath);
  });

  test("restores to body-supplied target_relative_path", async () => {
    if (!mongoReachable) return;
    const { app } = await import("../src/index.ts");
    const { assetId } = await trashedAsset("IMG_R2.ARW");
    const target = "elsewhere/IMG_R2.ARW";
    const res = await app.handle(jsonReq(`http://localhost/api/assets/${assetId.toHexString()}/restore`, { target_relative_path: target }));
    expect(res.status).toBe(200);
    const body = await res.json() as { abs_path: string };
    expect(body.abs_path).toBe(path.join(realTmpRoot, target));
    await fs.stat(body.abs_path);
  });

  test(".restored suffix appended on collision", async () => {
    if (!mongoReachable) return;
    const { app } = await import("../src/index.ts");
    const { assetId, originalPath } = await trashedAsset("IMG_R3.ARW");
    // Create a new file at the original path so restore must rename.
    await fs.writeFile(originalPath, "occupier");

    const res = await app.handle(jsonReq(`http://localhost/api/assets/${assetId.toHexString()}/restore`, {}));
    expect(res.status).toBe(200);
    const body = await res.json() as { abs_path: string };
    expect(body.abs_path).toBe(path.join(path.dirname(originalPath), "IMG_R3.restored.ARW"));
    expect(await fs.readFile(originalPath, "utf-8")).toBe("occupier");
    expect(await fs.readFile(body.abs_path, "utf-8")).toBe("raw");
  });

  test("409 when asset is not trashed", async () => {
    if (!mongoReachable) return;
    const { app } = await import("../src/index.ts");
    const assetId = new ObjectId();
    await db!.collection("assets").insertOne({
      _id: assetId, folder_id: folderId, filename: "live.ARW",
      abs_path: path.join(realTmpRoot, "live.ARW"), size: 0, mtime: 0,
      indexed_at: new Date().toISOString(), deleted_at: null,
    } as never);
    const res = await app.handle(jsonReq(`http://localhost/api/assets/${assetId.toHexString()}/restore`, {}));
    expect(res.status).toBe(409);
  });

  test("404 on unknown asset id", async () => {
    if (!mongoReachable) return;
    const { app } = await import("../src/index.ts");
    const otherId = new ObjectId().toHexString();
    const res = await app.handle(jsonReq(`http://localhost/api/assets/${otherId}/restore`, {}));
    expect(res.status).toBe(404);
  });
});

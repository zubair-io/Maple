import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { MongoClient, ObjectId, type Db } from "mongodb";
import { pendingEnrichment } from "../src/db/schema.ts";
import { signAccessToken } from "../src/auth/tokens.ts";
import {
  setMeilisearchClientForTests,
  type MeilisearchClient,
  type MeilisearchAssetDoc,
} from "../src/enrichment/meilisearch-client.ts";

process.env.MAPLE_JWT_SECRET = "x".repeat(32);
const BEARER = "Bearer " + signAccessToken(
  { sub: "00000000000000000000000a", email: "tester@maple.local", role: "owner" },
  process.env.MAPLE_JWT_SECRET!,
);

const TEST_DB = `maple_test_fp3_restore_${process.pid}`;
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

async function trashedAsset(filename: string, opts?: { mapleId?: string; description?: string }): Promise<{ assetId: ObjectId; originalPath: string; trashPath: string; mapleId: string | null }> {
  const originalPath = path.join(realTmpRoot, "2024", filename);
  const trashPath = path.join(realTmpRoot, ".maple", "trash", "2024", filename);
  await fs.mkdir(path.dirname(originalPath), { recursive: true });
  await fs.mkdir(path.dirname(trashPath), { recursive: true });
  await fs.writeFile(trashPath, "raw");
  const assetId = new ObjectId();
  const mapleId = opts?.mapleId ?? null;
  const doc: Record<string, unknown> = {
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
  };
  if (mapleId) doc.maple_id = mapleId;
  if (opts?.description) doc.description = opts.description;
  await db!.collection("assets").insertOne(doc as never);
  return { assetId, originalPath, trashPath, mapleId };
}

interface CapturingMeili extends MeilisearchClient {
  tombstones: string[];
  upserts: MeilisearchAssetDoc[];
}

function capturingMeili(): CapturingMeili {
  const tombstones: string[] = [];
  const upserts: MeilisearchAssetDoc[] = [];
  return {
    tombstones,
    upserts,
    isConfigured: () => true,
    health: async () => true,
    ensureIndex: async () => {},
    upsert: async (doc) => { upserts.push(doc); },
    upsertOrThrow: async (doc) => { upserts.push(doc); },
    tombstone: async (id) => { tombstones.push(id); },
    search: async () => ({ ids: [], estimatedTotal: 0 }),
  };
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
    setMeilisearchClientForTests(null);
    if (PRIOR_MONGO_DB === undefined) delete process.env.MAPLE_MONGO_DB;
    else process.env.MAPLE_MONGO_DB = PRIOR_MONGO_DB;
    if (PRIOR_MAPLE_ROOTS === undefined) delete process.env.MAPLE_ROOTS;
    else process.env.MAPLE_ROOTS = PRIOR_MAPLE_ROOTS;
  });

  beforeEach(() => {
    setMeilisearchClientForTests(null);
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
    const body = await res.json() as { abs_path: string; filename: string; size: number; mtime: string };
    expect(body.abs_path).toBe(path.join(path.dirname(originalPath), "IMG_R3.restored.ARW"));
    expect(await fs.readFile(originalPath, "utf-8")).toBe("occupier");
    expect(await fs.readFile(body.abs_path, "utf-8")).toBe("raw");
    // Response must carry the freshly-stat'd metadata so the File
    // Provider extension doesn't need to stat the server-side path.
    expect(body.filename).toBe("IMG_R3.restored.ARW");
    expect(body.size).toBe(3); // "raw"
    // Wire contract: `mtime` is an ISO-8601 string so the Swift
    // `RestoreResponse.mtime: Date` decoder (RemoteCatalog.swift) accepts
    // it. The DB column stays epoch-ms — see assertion below.
    expect(typeof body.mtime).toBe("string");
    expect(Number.isFinite(Date.parse(body.mtime))).toBe(true);
    // Doc must carry the renamed filename so the unique
    // {folder_id, filename} index no longer reserves the OLD basename
    // (otherwise a fresh upload at the original name would 409).
    const doc = await db!.collection("assets").findOne({ _id: assetId }) as Record<string, unknown>;
    expect(doc.filename).toBe("IMG_R3.restored.ARW");
    expect(doc.size).toBe(3);
    // DB stays epoch-ms (number) — only the wire response is ISO.
    expect(typeof doc.mtime).toBe("number");
  });

  // Regression for #166: a restored asset's mtime must persist as a
  // number in Mongo so the assets-list serialiser (`Math.floor(r.mtime
  // / 1000)`) doesn't yield NaN, AND must surface as an ISO-8601 string
  // on the restore wire so the Swift `RestoreResponse.mtime: Date`
  // decoder accepts it. Previously the restore handler wrote an ISO
  // string into the DB, which broke the Swift client's
  // contentModificationDate downstream via GET /api/assets.
  test("restored mtime is ISO on wire, number in DB, finite seconds via GET /api/assets", async () => {
    if (!mongoReachable) return;
    const { app } = await import("../src/index.ts");
    const { assetId } = await trashedAsset("IMG_R166.ARW");

    const res = await app.handle(jsonReq(`http://localhost/api/assets/${assetId.toHexString()}/restore`, {}));
    expect(res.status).toBe(200);
    const body = await res.json() as { mtime: unknown };
    // Wire: ISO-8601 string (Swift decoder expects Date).
    expect(typeof body.mtime).toBe("string");
    expect(Number.isFinite(Date.parse(body.mtime as string))).toBe(true);

    // DB: epoch-ms number.
    const doc = await db!.collection("assets").findOne({ _id: assetId }) as Record<string, unknown>;
    expect(typeof doc.mtime).toBe("number");
    expect(Number.isFinite(doc.mtime as number)).toBe(true);

    // Round-trip through GET /api/assets: must yield a finite integer in
    // seconds for the restored asset (not NaN).
    const listRes = await app.handle(new Request(`http://localhost/api/assets?limit=20000`, {
      headers: { Authorization: BEARER },
    }));
    expect(listRes.status).toBe(200);
    const listBody = await listRes.json() as { assets: Array<{ id: string; mtime: number }> };
    const restored = listBody.assets.find((a) => a.id === assetId.toHexString());
    expect(restored).toBeTruthy();
    expect(typeof restored!.mtime).toBe("number");
    expect(Number.isNaN(restored!.mtime)).toBe(false);
    expect(Number.isFinite(restored!.mtime)).toBe(true);
  });

  // Cat A3: cross-library restore must be rejected. The server's file
  // move uses the asset's ORIGINAL folder root; restoring into a
  // different library would silently land in the wrong place.
  test("400 when target_folder_id != asset's folder_id (cross-library guard)", async () => {
    if (!mongoReachable) return;
    const { app } = await import("../src/index.ts");
    const { assetId } = await trashedAsset("IMG_XLIB.ARW");
    const otherFolderId = new ObjectId().toHexString();
    const res = await app.handle(jsonReq(`http://localhost/api/assets/${assetId.toHexString()}/restore`, {
      target_folder_id: otherFolderId,
    }));
    expect(res.status).toBe(400);
    // Doc unchanged.
    const doc = await db!.collection("assets").findOne({ _id: assetId }) as Record<string, unknown>;
    expect(doc.deleted_at).toBeTruthy();
  });

  test("200 when target_folder_id matches asset's folder_id", async () => {
    if (!mongoReachable) return;
    const { app } = await import("../src/index.ts");
    const { assetId } = await trashedAsset("IMG_XLIB_OK.ARW");
    const res = await app.handle(jsonReq(`http://localhost/api/assets/${assetId.toHexString()}/restore`, {
      target_folder_id: folderId.toHexString(),
    }));
    expect(res.status).toBe(200);
  });

  // Cat A4-restore: watcher race — if the discover watcher beat the
  // route handler and upserted a fresh asset row at the restored
  // abs_path, the route used to fail on the {folder_id, filename}
  // unique index. Now we delete the watcher's transient row before
  // updating.
  test("restore wins over a watcher-inserted ghost row at the same abs_path", async () => {
    if (!mongoReachable) return;
    const { app } = await import("../src/index.ts");
    const { assetId, originalPath } = await trashedAsset("IMG_WATCHER.ARW");
    // Simulate the watcher: insert a transient row at the restore target.
    const ghostId = new ObjectId();
    await db!.collection("assets").insertOne({
      _id: ghostId,
      folder_id: folderId,
      filename: "IMG_WATCHER.ARW",
      abs_path: originalPath,
      size: 99,
      mtime: Date.now(),
      indexed_at: new Date().toISOString(),
      deleted_at: null,
    } as never);

    const res = await app.handle(jsonReq(`http://localhost/api/assets/${assetId.toHexString()}/restore`, {}));
    expect(res.status).toBe(200);
    // Ghost is gone, original asset row is now live at the restored path.
    const ghost = await db!.collection("assets").findOne({ _id: ghostId });
    expect(ghost).toBeNull();
    const restored = await db!.collection("assets").findOne({ _id: assetId }) as Record<string, unknown>;
    expect(restored.deleted_at).toBeNull();
    expect(restored.abs_path).toBe(originalPath);
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

  test("restore re-indexes the asset in Meilisearch with deletedAt=null", async () => {
    if (!mongoReachable) return;
    const meili = capturingMeili();
    setMeilisearchClientForTests(meili);
    const { app } = await import("../src/index.ts");
    const mapleId = "feedfacefeedface";
    const { assetId, originalPath } = await trashedAsset("IMG_RM1.ARW", {
      mapleId,
      description: "a sunset over the river",
    });

    const res = await app.handle(jsonReq(`http://localhost/api/assets/${assetId.toHexString()}/restore`, {}));
    expect(res.status).toBe(200);

    expect(meili.upserts.length).toBe(1);
    const upserted = meili.upserts[0]!;
    expect(upserted.id).toBe(mapleId);
    expect(upserted.deletedAt).toBeNull();
    expect(upserted.folderId).toBe(folderId.toHexString());
    expect(upserted.description).toBe("a sunset over the river");
    // searchBlob is a sorted, deduped token bag — the description tokens
    // are present in some order.
    expect(upserted.searchBlob).toContain("sunset");
    expect(upserted.searchBlob).toContain("river");

    // File restored regardless of Meili side-effects.
    await fs.stat(originalPath);
  });

  test("restore skips Meilisearch when maple_id is absent (legacy row)", async () => {
    if (!mongoReachable) return;
    const meili = capturingMeili();
    setMeilisearchClientForTests(meili);
    const { app } = await import("../src/index.ts");
    const { assetId } = await trashedAsset("IMG_RM2.ARW");

    const res = await app.handle(jsonReq(`http://localhost/api/assets/${assetId.toHexString()}/restore`, {}));
    expect(res.status).toBe(200);
    expect(meili.upserts).toEqual([]);
  });

  test("restore returns 200 even when Meilisearch throws", async () => {
    if (!mongoReachable) return;
    const failing: MeilisearchClient = {
      isConfigured: () => true,
      health: async () => true,
      ensureIndex: async () => {},
      upsert: async () => { throw new Error("meili down"); },
      upsertOrThrow: async () => { throw new Error("meili down"); },
      tombstone: async () => {},
      search: async () => ({ ids: [], estimatedTotal: 0 }),
    };
    setMeilisearchClientForTests(failing);
    const { app } = await import("../src/index.ts");
    const { assetId, originalPath } = await trashedAsset("IMG_RM3.ARW", { mapleId: "xyz789" });

    const res = await app.handle(jsonReq(`http://localhost/api/assets/${assetId.toHexString()}/restore`, {}));
    expect(res.status).toBe(200);
    // Mongo restored and file moved despite Meili failure.
    const doc = await db!.collection("assets").findOne({ _id: assetId }) as Record<string, unknown>;
    expect(doc.deleted_at).toBeNull();
    expect(doc.original_path).toBeNull();
    expect(doc.abs_path).toBe(originalPath);
    await fs.stat(originalPath);
  });

  test("404 on unknown asset id", async () => {
    if (!mongoReachable) return;
    const { app } = await import("../src/index.ts");
    const otherId = new ObjectId().toHexString();
    const res = await app.handle(jsonReq(`http://localhost/api/assets/${otherId}/restore`, {}));
    expect(res.status).toBe(404);
  });
});

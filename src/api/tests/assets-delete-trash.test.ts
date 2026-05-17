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

const TEST_DB = `maple_test_fp3_delete_${process.pid}`;
const PRIOR_MONGO_DB = process.env.MAPLE_MONGO_DB;
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

async function makeAsset(filename: string, content: Buffer, opts?: { mapleId?: string }): Promise<{ assetId: ObjectId; absPath: string; mapleId: string | null }> {
  const absPath = path.join(realTmpRoot, "2024", filename);
  await fs.mkdir(path.dirname(absPath), { recursive: true });
  await fs.writeFile(absPath, content);
  const assetId = new ObjectId();
  const mapleId = opts?.mapleId ?? null;
  const doc: Record<string, unknown> = {
    _id: assetId,
    folder_id: folderId,
    filename,
    abs_path: absPath,
    size: content.byteLength,
    mtime: Date.now(),
    indexed_at: new Date().toISOString(),
    deleted_at: null,
    enrichment: pendingEnrichment(),
  };
  if (mapleId) doc.maple_id = mapleId;
  await db!.collection("assets").insertOne(doc as never);
  return { assetId, absPath, mapleId };
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

describe("DELETE /api/assets/:id (trash + permanent purge)", () => {
  beforeAll(async () => {
    const { closeDb } = await import("../src/db/client.ts");
    await closeDb();
    process.env.MAPLE_MONGO_DB = TEST_DB;
    mongo = await tryConnect();
    mongoReachable = mongo !== null;
    if (!mongoReachable) return;

    db = mongo!.db(TEST_DB);
    await db.dropDatabase();

    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "maple-fp3-delete-"));
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
  });

  beforeEach(() => {
    // Reset the meili mock before every test so calls don't leak across
    // cases. Individual tests reinstall a capturing mock when needed.
    setMeilisearchClientForTests(null);
  });

  test("moves RAW + sidecar to trash; sets deleted_at + original_path", async () => {
    if (!mongoReachable) return;
    const { app } = await import("../src/index.ts");
    const { assetId, absPath } = await makeAsset("IMG_1.ARW", Buffer.from("raw"));
    await fs.writeFile(absPath.replace(/\.ARW$/, ".xmp"), "canon");
    await fs.writeFile(absPath.replace(/\.ARW$/, " (conflict from Mac).xmp"), "conflict");

    const res = await app.handle(new Request(`http://localhost/api/assets/${assetId.toHexString()}`, {
      method: "DELETE", headers: { Authorization: BEARER },
    }));
    expect(res.status).toBe(204);

    // Files gone from original.
    await expect(fs.stat(absPath)).rejects.toThrow();
    await expect(fs.stat(absPath.replace(/\.ARW$/, ".xmp"))).rejects.toThrow();
    await expect(fs.stat(absPath.replace(/\.ARW$/, " (conflict from Mac).xmp"))).rejects.toThrow();

    // Files present in trash, mirrored relative path.
    const trashRaw = path.join(realTmpRoot, ".maple", "trash", "2024", "IMG_1.ARW");
    const trashCanon = path.join(realTmpRoot, ".maple", "trash", "2024", "IMG_1.xmp");
    const trashConflict = path.join(realTmpRoot, ".maple", "trash", "2024", "IMG_1 (conflict from Mac).xmp");
    await fs.stat(trashRaw);
    await fs.stat(trashCanon);
    await fs.stat(trashConflict);

    // Asset doc flipped.
    const doc = await db!.collection("assets").findOne({ _id: assetId }) as Record<string, unknown>;
    expect(doc.deleted_at).toBeTruthy();
    expect(doc.original_path).toBe(absPath);
    expect(doc.abs_path).toBe(trashRaw);
  });

  test("DELETE on already-trashed asset permanently purges file + doc", async () => {
    if (!mongoReachable) return;
    const { app } = await import("../src/index.ts");
    const { assetId, absPath } = await makeAsset("IMG_2.ARW", Buffer.from("raw"));
    await app.handle(new Request(`http://localhost/api/assets/${assetId.toHexString()}`, {
      method: "DELETE", headers: { Authorization: BEARER },
    }));

    const trashed = await db!.collection("assets").findOne({ _id: assetId }) as Record<string, unknown>;
    const trashRaw = trashed.abs_path as string;
    await fs.stat(trashRaw);

    const res = await app.handle(new Request(`http://localhost/api/assets/${assetId.toHexString()}`, {
      method: "DELETE", headers: { Authorization: BEARER },
    }));
    expect(res.status).toBe(204);

    await expect(fs.stat(trashRaw)).rejects.toThrow();
    const doc = await db!.collection("assets").findOne({ _id: assetId });
    expect(doc).toBeNull();
    void absPath; // assertion is on the post-trash path
  });

  test("soft-delete tombstones the asset in Meilisearch when maple_id is present", async () => {
    if (!mongoReachable) return;
    const meili = capturingMeili();
    setMeilisearchClientForTests(meili);
    const { app } = await import("../src/index.ts");
    const mapleId = "deadbeefdeadbeef";
    const { assetId } = await makeAsset("IMG_meili1.ARW", Buffer.from("raw"), { mapleId });

    const res = await app.handle(new Request(`http://localhost/api/assets/${assetId.toHexString()}`, {
      method: "DELETE", headers: { Authorization: BEARER },
    }));
    expect(res.status).toBe(204);
    expect(meili.tombstones).toEqual([mapleId]);
    expect(meili.upserts).toEqual([]);
  });

  test("soft-delete skips Meilisearch when maple_id is absent (legacy row)", async () => {
    if (!mongoReachable) return;
    const meili = capturingMeili();
    setMeilisearchClientForTests(meili);
    const { app } = await import("../src/index.ts");
    const { assetId } = await makeAsset("IMG_meili2.ARW", Buffer.from("raw"));

    const res = await app.handle(new Request(`http://localhost/api/assets/${assetId.toHexString()}`, {
      method: "DELETE", headers: { Authorization: BEARER },
    }));
    expect(res.status).toBe(204);
    expect(meili.tombstones).toEqual([]);
  });

  test("soft-delete 204s even when Meilisearch throws", async () => {
    if (!mongoReachable) return;
    const failing: MeilisearchClient = {
      isConfigured: () => true,
      health: async () => true,
      ensureIndex: async () => {},
      upsert: async () => {},
      upsertOrThrow: async () => {},
      tombstone: async () => { throw new Error("meili boom"); },
      search: async () => ({ ids: [], estimatedTotal: 0 }),
    };
    setMeilisearchClientForTests(failing);
    const { app } = await import("../src/index.ts");
    const { assetId, absPath } = await makeAsset("IMG_meili3.ARW", Buffer.from("raw"), { mapleId: "abc123" });

    const res = await app.handle(new Request(`http://localhost/api/assets/${assetId.toHexString()}`, {
      method: "DELETE", headers: { Authorization: BEARER },
    }));
    expect(res.status).toBe(204);
    // Mongo state still flipped despite Meili failure.
    const doc = await db!.collection("assets").findOne({ _id: assetId }) as Record<string, unknown>;
    expect(doc.deleted_at).toBeTruthy();
    expect(doc.original_path).toBe(absPath);
  });

  test("404 on unknown asset id", async () => {
    if (!mongoReachable) return;
    const { app } = await import("../src/index.ts");
    const otherId = new ObjectId().toHexString();
    const res = await app.handle(new Request(`http://localhost/api/assets/${otherId}`, {
      method: "DELETE", headers: { Authorization: BEARER },
    }));
    expect(res.status).toBe(404);
  });
});

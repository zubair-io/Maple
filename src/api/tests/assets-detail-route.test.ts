/**
 * End-to-end coverage for GET /api/assets/:id — exercises the wire
 * contract of the metadata DTO produced by `routes/assets/metadata.ts`
 * + `db/assets.repo.ts:findDetailById`.
 *
 * Sibling assets endpoints already have e2e coverage
 * (assets-list.test.ts, assets-xmp-*.test.ts, assets-overrides.test.ts,
 * assets-restore.test.ts, assets-delete-trash.test.ts,
 * enrichment-route.test.ts, assets.thumb-etag.test.ts) — this file fills
 * the gap for the detail GET, which is the most field-heavy DTO in the
 * assets repo (vision, vision_meta, enrichment, description_meta).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { Elysia } from "elysia";
import { MongoClient, ObjectId, type Db } from "mongodb";
import { closeDb } from "../src/db/client.ts";
import { assetsRoutes } from "../src/routes/assets.ts";
import { pendingEnrichment } from "../src/db/schema.ts";

const MONGO_URI = process.env.MAPLE_MONGO_URI ?? "mongodb://localhost:27017";
const TEST_DB = `maple_assets_detail_route_test_${process.pid}`;

let client: MongoClient | null = null;
let db: Db | null = null;
// Capture once in beforeAll (not beforeEach — beforeEach mutates the
// envs and would clobber the originals on the second iteration). Used
// by afterAll to restore the host's MAPLE_MONGO_URI / MAPLE_MONGO_DB
// so this suite doesn't leak into sibling test files / processes.
let priorMongoUri: string | undefined;
let priorMongoDb: string | undefined;

async function tryConnect(): Promise<MongoClient | null> {
  const c = new MongoClient(MONGO_URI, {
    serverSelectionTimeoutMS: 1_500,
    connectTimeoutMS: 1_500,
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

beforeAll(() => {
  priorMongoUri = process.env.MAPLE_MONGO_URI;
  priorMongoDb = process.env.MAPLE_MONGO_DB;
});

beforeEach(async () => {
  client = await tryConnect();
  if (!client) return;
  process.env.MAPLE_MONGO_URI = MONGO_URI;
  process.env.MAPLE_MONGO_DB = TEST_DB;
  await closeDb();
  db = client.db(TEST_DB);
  await db.dropDatabase();
});

afterAll(async () => {
  if (db) await db.dropDatabase();
  if (client) await client.close();
  await closeDb();
  // Restore the originals so this suite doesn't leak env mutations into
  // other tests / the host shell.
  if (priorMongoUri === undefined) delete process.env.MAPLE_MONGO_URI;
  else process.env.MAPLE_MONGO_URI = priorMongoUri;
  if (priorMongoDb === undefined) delete process.env.MAPLE_MONGO_DB;
  else process.env.MAPLE_MONGO_DB = priorMongoDb;
});

describe("GET /api/assets/:id", () => {
  it("returns 400 for a malformed id", async () => {
    if (!db) return;
    const app = new Elysia().use(assetsRoutes);
    const res = await app.handle(
      new Request("http://localhost/api/assets/not-an-objectid"),
    );
    expect(res.status).toBe(400);
  });

  it("returns 404 when the id is well-formed but absent", async () => {
    if (!db) return;
    const app = new Elysia().use(assetsRoutes);
    const res = await app.handle(
      new Request(`http://localhost/api/assets/${new ObjectId().toHexString()}`),
    );
    expect(res.status).toBe(404);
  });

  it("returns the full DTO shape for a populated asset", async () => {
    if (!db) return;
    const id = new ObjectId();
    const folderId = new ObjectId();
    const describeMeta = {
      provider: "ollama",
      model: "qwen2.5vl:7b",
      prompt_version: 4,
      generated_at: "2026-05-01T00:00:00Z",
      cost_usd: 0,
    };
    await db.collection("assets").insertOne({
      _id: id,
      folder_id: folderId,
      filename: "a.dng",
      abs_path: "/lib/a.dng",
      size: 4096,
      mtime: 1_700_000_000_000, // epoch ms — detail DTO keeps ms
      rating: 4,
      flag: 1,
      color_label: "red",
      indexed_at: "2026-04-01T00:00:00Z",
      enrichment: pendingEnrichment(),
      place: null,
      faces: [],
      description: "a caption",
      description_meta: describeMeta,
      ocr_text: "VISIBLE TEXT",
      ocr_meta: {
        engine: "qwen2.5-vl",
        engine_version: "2026.05",
        generated_at: "2026-05-01T00:00:00Z",
        mean_confidence: null,
      },
      vision: null,
      vision_meta: null,
      is_screenshot: false,
      deleted_at: null,
    } as never);

    const app = new Elysia().use(assetsRoutes);
    const res = await app.handle(
      new Request(`http://localhost/api/assets/${id.toHexString()}`),
    );
    expect(res.status).toBe(200);
    const body = await res.json();

    // id + folder_id are hex strings on the wire (not ObjectId).
    expect(body.id).toBe(id.toHexString());
    expect(body.folder_id).toBe(folderId.toHexString());
    // mtime stays in ms in the detail DTO (only the list endpoint
    // divides by 1000).
    expect(body.mtime).toBe(1_700_000_000_000);
    expect(body.size).toBe(4096);
    expect(body.rating).toBe(4);
    expect(body.flag).toBe(1);
    expect(body.color_label).toBe("red");
    expect(body.indexed_at).toBe("2026-04-01T00:00:00Z");
    expect(body.description).toBe("a caption");
    expect(body.ocr_text).toBe("VISIBLE TEXT");
    expect(body.is_screenshot).toBe(false);
    // description_meta isn't typed on AssetDoc — verify it round-trips
    // verbatim through the repo's passthrough cast.
    expect(body.description_meta).toEqual(describeMeta);
    // ocr_meta passes through as-is.
    expect(body.ocr_meta?.engine).toBe("qwen2.5-vl");
    // Enrichment subdoc is normalised — every stage carries the
    // pending-shape fields.
    expect(body.enrichment.geocode.done_at).toBeNull();
    expect(body.enrichment.face.done_at).toBeNull();
    expect(body.enrichment.describe.done_at).toBeNull();
  });

  it("defaults vision + place + faces when absent on the row", async () => {
    if (!db) return;
    const id = new ObjectId();
    await db.collection("assets").insertOne({
      _id: id,
      folder_id: new ObjectId(),
      filename: "minimal.dng",
      abs_path: "/lib/minimal.dng",
      size: 1,
      mtime: 1,
      rating: 0,
      flag: 0,
      color_label: "",
      indexed_at: "now",
      deleted_at: null,
    } as never);

    const app = new Elysia().use(assetsRoutes);
    const res = await app.handle(
      new Request(`http://localhost/api/assets/${id.toHexString()}`),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.place).toBeNull();
    expect(body.faces).toEqual([]);
    expect(body.description).toBeNull();
    expect(body.description_meta).toBeNull();
    expect(body.vision).toBeNull();
    expect(body.vision_meta).toBeNull();
    // Enrichment is normalised even when the field is completely
    // missing from the doc.
    expect(body.enrichment.geocode.done_at).toBeNull();
    expect(body.enrichment.face.done_at).toBeNull();
    expect(body.enrichment.describe.done_at).toBeNull();
  });
});

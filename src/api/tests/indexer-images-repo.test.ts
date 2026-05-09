/**
 * Phase 1 (`docs/indexer-enrichment.md` §8 Phase 1): the fast-tier upsert
 * writes a skeleton row whose `enrichment` subdocument and enrichment outputs
 * (`place`, `faces`, `description`) survive subsequent re-upserts triggered
 * by mtime / sha1Head changes. Workers patch enrichment later — the fast
 * pipeline must never clobber their writes.
 *
 * Round-trips against a real MongoDB; skip-passes if no instance is reachable
 * (mirrors the existing search-route + indexer-id integration patterns).
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterAll,
} from "bun:test";
import { MongoClient, ObjectId, type Db } from "mongodb";
import type { Place } from "../src/db/schema.ts";

// Each bun process gets its own DB so concurrent test shards don't collide.
const TEST_DB = `maple_test_indexer_repo_${process.pid}`;
process.env.MAPLE_MONGO_DB = TEST_DB;

const MONGO_URI = process.env.MAPLE_MONGO_URI ?? "mongodb://localhost:27017";

let mongo: MongoClient | null = null;
let mongoReachable = false;
let db: Db | null = null;

async function tryConnect(): Promise<MongoClient | null> {
  const c = new MongoClient(MONGO_URI, {
    serverSelectionTimeoutMS: 1500,
    connectTimeoutMS: 1500,
  });
  try {
    await c.connect();
    await c.db("admin").command({ ping: 1 });
    return c;
  } catch {
    try { await c.close(); } catch {}
    return null;
  }
}

beforeAll(async () => {
  mongo = await tryConnect();
  mongoReachable = mongo !== null;
  if (!mongoReachable) {
    console.log(
      "[indexer-images-repo.test] skipping: MongoDB unreachable at",
      MONGO_URI,
    );
    return;
  }
  db = mongo!.db(TEST_DB);
  await db.dropDatabase();
  // The repo singleton may already point at a different DB if an earlier test
  // in the same bun process initialised the connection; reset before importing.
  const { closeDb } = await import("../src/db/client.ts");
  await closeDb();
});

beforeEach(async () => {
  if (!mongoReachable) return;
  await db!.collection("assets").deleteMany({});
});

afterAll(async () => {
  if (mongo) {
    await mongo.db(TEST_DB).dropDatabase();
    await mongo.close();
  }
  const { closeDb } = await import("../src/db/client.ts");
  await closeDb();
});

describe("upsertByMapleId — skeleton schema", () => {
  it("inserts a fresh asset with all enrichment stages pending and outputs nulled", async () => {
    if (!mongoReachable) return;
    const { upsertByMapleId } = await import("../src/indexer/images.repo.ts");
    const folderId = new ObjectId();
    const filename = "fresh.dng";

    await upsertByMapleId({
      folderId,
      filename,
      absPath: `/lib/${filename}`,
      size: 1024,
      mtime: 1_700_000_000_000,
      mapleId: "01" + "a".repeat(30),
      sha1Head: "deadbeef",
      exif: null,
    });

    const doc = await db!
      .collection("assets")
      .findOne({ folder_id: folderId, filename });
    expect(doc).toBeTruthy();

    // Fast-tier fields are all written.
    expect(doc!.size).toBe(1024);
    expect(doc!.mtime).toBe(1_700_000_000_000);
    expect(doc!.sha1_head).toBe("deadbeef");
    expect(doc!.maple_id).toBe("01" + "a".repeat(30));
    expect(doc!.exif).toBeNull();
    expect(doc!.deleted_at).toBeNull();

    // Skeleton seeds: enrichment outputs default to null/empty.
    expect(doc!.place).toBeNull();
    expect(doc!.description).toBeNull();
    expect(doc!.faces).toEqual([]);
    expect(doc!.ai_tags).toEqual([]);

    // Skeleton seeds: every enrichment stage is fully pending.
    expect(doc!.enrichment).toEqual({
      geocode: {
        done_at: null,
        locked_by: null,
        lease_expires_at: null,
        attempts: 0,
        last_error: null,
        version: null,
        dead_letter_at: null,
      },
      face: {
        done_at: null,
        locked_by: null,
        lease_expires_at: null,
        attempts: 0,
        last_error: null,
        version: null,
        dead_letter_at: null,
      },
      describe: {
        done_at: null,
        locked_by: null,
        lease_expires_at: null,
        attempts: 0,
        last_error: null,
        version: null,
        dead_letter_at: null,
      },
      ocr: {
        done_at: null,
        locked_by: null,
        lease_expires_at: null,
        attempts: 0,
        last_error: null,
        version: null,
        dead_letter_at: null,
      },
    });

    // Browse defaults are seeded too.
    expect(doc!.rating).toBe(0);
    expect(doc!.flag).toBe(0);
    expect(doc!.color_label).toBe("");
  });
});

describe("upsertByMapleId — re-upsert preservation", () => {
  it("does not clobber enrichment.<stage>.done_at on a second upsert", async () => {
    if (!mongoReachable) return;
    const { upsertByMapleId } = await import("../src/indexer/images.repo.ts");
    const folderId = new ObjectId();
    const filename = "geocoded.dng";

    // Insert skeleton.
    await upsertByMapleId({
      folderId,
      filename,
      absPath: `/lib/${filename}`,
      size: 1024,
      mtime: 1_700_000_000_000,
      mapleId: "0100000000000000000000000000000a",
      sha1Head: "aaaa",
      exif: null,
    });

    // Worker writes a completed geocode stage and a non-null place.
    await db!.collection("assets").updateOne(
      { folder_id: folderId, filename },
      {
        $set: {
          "enrichment.geocode.done_at": "2026-05-08T12:00:00.000Z",
          "enrichment.geocode.version": 1,
          place: makeTestPlace(),
        },
      },
    );

    // Re-upsert: simulate the watcher firing again (e.g. mtime ticked).
    await upsertByMapleId({
      folderId,
      filename,
      absPath: `/lib/${filename}`,
      size: 2048, // ← changed
      mtime: 1_700_000_999_000, // ← changed
      mapleId: "0100000000000000000000000000000a",
      sha1Head: "bbbb", // ← changed
      exif: null,
    });

    const after = await db!
      .collection("assets")
      .findOne({ folder_id: folderId, filename });

    // Fast-tier fields are updated.
    expect(after!.size).toBe(2048);
    expect(after!.mtime).toBe(1_700_000_999_000);
    expect(after!.sha1_head).toBe("bbbb");

    // Worker-written enrichment + place are intact.
    expect(after!.enrichment.geocode.done_at).toBe("2026-05-08T12:00:00.000Z");
    expect(after!.enrichment.geocode.version).toBe(1);
    expect(after!.place).not.toBeNull();
    expect(after!.place.display_name).toBe(
      "New York State Museum, Albany, NY, USA",
    );

    // Untouched stages are still pending.
    expect(after!.enrichment.face.done_at).toBeNull();
    expect(after!.enrichment.describe.done_at).toBeNull();
  });

  it("does not clobber a worker-written non-null place on re-upsert", async () => {
    if (!mongoReachable) return;
    const { upsertByMapleId } = await import("../src/indexer/images.repo.ts");
    const folderId = new ObjectId();
    const filename = "place-survives.dng";

    await upsertByMapleId({
      folderId,
      filename,
      absPath: `/lib/${filename}`,
      size: 1024,
      mtime: 1,
      mapleId: "0100000000000000000000000000000b",
      sha1Head: "cccc",
      exif: null,
    });

    const place = makeTestPlace();
    await db!
      .collection("assets")
      .updateOne(
        { folder_id: folderId, filename },
        { $set: { place } },
      );

    await upsertByMapleId({
      folderId,
      filename,
      absPath: `/lib/${filename}`,
      size: 1024,
      mtime: 2,
      mapleId: "0100000000000000000000000000000b",
      sha1Head: "cccc",
      exif: null,
    });

    const after = await db!
      .collection("assets")
      .findOne({ folder_id: folderId, filename });
    expect(after!.place).toEqual(place);
  });

  it("does not clobber worker-written faces / description / ai_tags on re-upsert", async () => {
    if (!mongoReachable) return;
    const { upsertByMapleId } = await import("../src/indexer/images.repo.ts");
    const folderId = new ObjectId();
    const filename = "outputs-survive.dng";

    await upsertByMapleId({
      folderId,
      filename,
      absPath: `/lib/${filename}`,
      size: 1,
      mtime: 1,
      mapleId: "0100000000000000000000000000000c",
      sha1Head: "1111",
      exif: null,
    });

    const faces = [
      {
        bbox: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 },
        person_id: null,
        confidence: 0.97,
      },
    ];
    const description = "A blue heron at sunset.";
    const aiTags = ["bird", "sunset"];
    await db!.collection("assets").updateOne(
      { folder_id: folderId, filename },
      { $set: { faces, description, ai_tags: aiTags } },
    );

    // Re-upsert with bumped mtime to simulate watcher re-trigger.
    await upsertByMapleId({
      folderId,
      filename,
      absPath: `/lib/${filename}`,
      size: 1,
      mtime: 2,
      mapleId: "0100000000000000000000000000000c",
      sha1Head: "1111",
      exif: null,
    });

    const after = await db!
      .collection("assets")
      .findOne({ folder_id: folderId, filename });
    expect(after!.faces).toEqual(faces);
    expect(after!.description).toBe(description);
    expect(after!.ai_tags).toEqual(aiTags);
  });

  it("re-upsert updates mtime and sha1_head when they change", async () => {
    if (!mongoReachable) return;
    const { upsertByMapleId } = await import("../src/indexer/images.repo.ts");
    const folderId = new ObjectId();
    const filename = "mtime-updates.dng";

    await upsertByMapleId({
      folderId,
      filename,
      absPath: `/lib/${filename}`,
      size: 100,
      mtime: 100,
      mapleId: "0100000000000000000000000000000d",
      sha1Head: "old-head",
      exif: null,
    });

    await upsertByMapleId({
      folderId,
      filename,
      absPath: `/lib/${filename}`,
      size: 200,
      mtime: 200,
      mapleId: "0100000000000000000000000000000d",
      sha1Head: "new-head",
      exif: null,
    });

    const after = await db!
      .collection("assets")
      .findOne({ folder_id: folderId, filename });
    expect(after!.size).toBe(200);
    expect(after!.mtime).toBe(200);
    expect(after!.sha1_head).toBe("new-head");
  });
});

describe("read-path defaults — old rows without enrichment", () => {
  it("normaliseEnrichment returns a fully-pending skeleton when the field is missing", async () => {
    if (!mongoReachable) return;
    const { normaliseEnrichment, pendingEnrichment } = await import(
      "../src/db/schema.ts"
    );
    expect(normaliseEnrichment(undefined)).toEqual(pendingEnrichment());
    expect(normaliseEnrichment(null)).toEqual(pendingEnrichment());
    expect(normaliseEnrichment({})).toEqual(pendingEnrichment());
  });

  it("normaliseEnrichment fills in missing per-stage fields without overriding present ones", async () => {
    const { normaliseEnrichment } = await import("../src/db/schema.ts");
    const partial = {
      geocode: {
        done_at: "2026-05-08T00:00:00.000Z",
        version: 2,
      } as Partial<import("../src/db/schema.ts").EnrichmentStageState> as never,
    } as never;
    const out = normaliseEnrichment(partial);
    expect(out.geocode.done_at).toBe("2026-05-08T00:00:00.000Z");
    expect(out.geocode.version).toBe(2);
    expect(out.geocode.attempts).toBe(0);
    expect(out.geocode.locked_by).toBeNull();
    // Stages absent from the partial input are fully pending.
    expect(out.face.done_at).toBeNull();
    expect(out.describe.done_at).toBeNull();
  });

  it("an old row inserted directly (no enrichment field) round-trips through findOne without crashing", async () => {
    if (!mongoReachable) return;
    const folderId = new ObjectId();
    await db!.collection("assets").insertOne({
      folder_id: folderId,
      filename: "ancient.dng",
      abs_path: "/lib/ancient.dng",
      size: 10,
      mtime: 1,
      rating: 0,
      flag: 0,
      color_label: "",
      indexed_at: new Date().toISOString(),
    } as never);

    const found = await db!
      .collection("assets")
      .findOne({ folder_id: folderId, filename: "ancient.dng" });
    expect(found).toBeTruthy();
    expect(found!.enrichment).toBeUndefined();
    expect(found!.place).toBeUndefined();
    expect(found!.faces).toBeUndefined();
    expect(found!.description).toBeUndefined();

    // The schema's read-side normaliser is what the asset-detail route uses.
    const { normaliseEnrichment } = await import("../src/db/schema.ts");
    const normalised = normaliseEnrichment(found!.enrichment);
    expect(normalised.geocode.done_at).toBeNull();
    expect(normalised.face.done_at).toBeNull();
    expect(normalised.describe.done_at).toBeNull();
  });
});

function makeTestPlace(): Place {
  return {
    source: "nominatim",
    geocoder_version: 1,
    geocoded_at: "2026-05-08T11:59:00.000Z",
    lat: 42.6526,
    lon: -73.7562,
    display_name: "New York State Museum, Albany, NY, USA",
    address: {
      city: "Albany",
      state: "New York",
      state_code: "NY",
      country: "United States",
      country_code: "us",
    },
    pois: [{ name: "New York State Museum", category: "tourism", type: "museum" }],
    rollups: {
      locality: "Albany",
      region: "New York",
      country_code: "us",
    },
    search_blob: "Albany New York NY United States museum tourism",
  };
}

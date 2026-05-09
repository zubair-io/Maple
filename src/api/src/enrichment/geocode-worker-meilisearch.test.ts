/**
 * Verifies the geocode worker pushes a Meilisearch upsert after `complete()`,
 * AND that a Meilisearch failure does NOT break the Mongo write.
 *
 * Real Mongo (skip-pass when unreachable) + a fake Nominatim client + a
 * captured-call stub for the Meilisearch client.
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
import type { AssetDoc } from "../db/schema.ts";
import { CircuitBreaker } from "./circuit-breaker.ts";
import { CoordinateCache } from "./coordinate-cache.ts";
import { GeocodeWorker, GEOCODE_HANDLER_VERSION } from "./geocode-worker.ts";
import {
  type MeilisearchAssetDoc,
  type MeilisearchClient,
} from "./meilisearch-client.ts";
import { NominatimClient } from "./nominatim-client.ts";

const TEST_DB = `maple_test_geocode_meili_${process.pid}`;
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
    console.log("[geocode-worker-meilisearch.test] skipping: MongoDB unreachable");
    return;
  }
  db = mongo!.db(TEST_DB);
  await db.dropDatabase();
  const { closeDb } = await import("../db/client.ts");
  await closeDb();
});

beforeEach(async () => {
  if (!mongoReachable) return;
  await db!.collection("assets").deleteMany({});
  await db!.collection("geocode_cache").deleteMany({});
});

afterAll(async () => {
  if (mongo) {
    await mongo.db(TEST_DB).dropDatabase();
    await mongo.close();
  }
  const { closeDb } = await import("../db/client.ts");
  await closeDb();
});

interface CapturedMeili {
  client: MeilisearchClient;
  upserts: MeilisearchAssetDoc[];
  tombstones: string[];
  /** Make `upsert` throw on the next call. */
  failNextUpsert?: boolean;
}

function makeCapturingMeili(): CapturedMeili {
  const upserts: MeilisearchAssetDoc[] = [];
  const tombstones: string[] = [];
  const c: CapturedMeili = {
    upserts,
    tombstones,
    client: {
      isConfigured: () => true,
      health: async () => true,
      ensureIndex: async () => {},
      upsert: async (doc) => {
        if (c.failNextUpsert) {
          c.failNextUpsert = false;
          throw new Error("simulated meili upsert failure");
        }
        upserts.push(doc);
      },
      tombstone: async (id) => {
        tombstones.push(id);
      },
      search: async () => ({ ids: [], estimatedTotal: 0 }),
    },
  };
  return c;
}

/** Build a fake Nominatim client backed by a programmable response array. */
function fakeNominatim(body: unknown): NominatimClient {
  // The structural `typeof fetch` signature includes a `preconnect`
  // static; cast through `unknown` so the test fake type-checks.
  const fetchImpl = (async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as unknown as typeof fetch;
  return new NominatimClient({
    baseUrl: "http://nominatim.local",
    fetchImpl,
  });
}

const FOLDER_ID = new ObjectId();

async function seedAsset(
  db: Db,
  mapleId: string,
  gps: { lat: number; lng: number },
): Promise<ObjectId> {
  const doc: Partial<AssetDoc> & { maple_id: string } = {
    folder_id: FOLDER_ID,
    maple_id: mapleId,
    abs_path: `/lib/${mapleId}.dng`,
    filename: `${mapleId}.dng`,
    size: 1024,
    mtime: Date.now(),
    rating: 0,
    flag: 0,
    color_label: "",
    indexed_at: new Date().toISOString(),
    exif: {
      captured_at: "2024-06-01T12:00:00.000Z",
      captured_year: 2024,
      captured_month: 6,
      camera_make: "Sony",
      camera_model: "A7R V",
      lens: "FE 24-70mm",
      iso: 200,
      aperture: 4.0,
      shutter: "1/250",
      focal_length: 35,
      gps,
    },
    enrichment: {
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
    },
    place: null,
  };
  const r = await db.collection("assets").insertOne(doc as unknown as AssetDoc);
  return r.insertedId;
}

const NOMINATIM_OK = {
  category: "tourism",
  type: "museum",
  name: "New York State Museum",
  display_name: "New York State Museum, Albany",
  address: {
    city: "Albany",
    state: "New York",
    "ISO3166-2-lvl4": "US-NY",
    country: "United States",
    country_code: "us",
    tourism: "New York State Museum",
  },
};

describe("GeocodeWorker — Meilisearch sync", () => {
  it("complete() upserts the doc to Meilisearch", async () => {
    if (!mongoReachable) return;
    await seedAsset(db!, "maple-albany-1", { lat: 42.65, lng: -73.75 });
    const meili = makeCapturingMeili();
    const worker = new GeocodeWorker({
      client: fakeNominatim(NOMINATIM_OK),
      cache: new CoordinateCache({ geocoderVersion: GEOCODE_HANDLER_VERSION }),
      breaker: new CircuitBreaker(),
      meilisearch: meili.client,
      pollMs: 1,
      leaseMs: 60_000,
    });
    const result = await worker.tick();
    expect(result.kind).toBe("completed");

    expect(meili.upserts.length).toBe(1);
    const u = meili.upserts[0]!;
    expect(u.id).toBe("maple-albany-1");
    expect(u.folderId).toBe(FOLDER_ID.toHexString());
    expect(u.capturedAt).toBe("2024-06-01T12:00:00.000Z");
    expect(u.deletedAt).toBeNull();
    expect(u.searchBlob.length).toBeGreaterThan(0);
    // The blob should at minimum contain the locality + state code.
    expect(u.searchBlob).toContain("albany");
  });

  it("Mongo write succeeds even when the Meilisearch upsert fails", async () => {
    if (!mongoReachable) return;
    await seedAsset(db!, "maple-albany-2", { lat: 42.65, lng: -73.75 });
    const meili = makeCapturingMeili();
    meili.failNextUpsert = true;
    const worker = new GeocodeWorker({
      client: fakeNominatim(NOMINATIM_OK),
      cache: new CoordinateCache({ geocoderVersion: GEOCODE_HANDLER_VERSION }),
      breaker: new CircuitBreaker(),
      meilisearch: meili.client,
      pollMs: 1,
      leaseMs: 60_000,
    });
    const result = await worker.tick();
    // Worker must still report the geocode as completed — Meilisearch is
    // an optional sidecar.
    expect(result.kind).toBe("completed");

    // The Meilisearch upsert was attempted but failed: zero successful
    // upserts captured.
    expect(meili.upserts.length).toBe(0);

    // Mongo row was patched with `place` and `enrichment.geocode.done_at`.
    const after = await db!
      .collection<AssetDoc>("assets")
      .findOne({ maple_id: "maple-albany-2" });
    expect(after).not.toBeNull();
    expect(after!.place).not.toBeNull();
    expect(after!.enrichment?.geocode.done_at).not.toBeNull();
  });

  it("skips the Meilisearch upsert when the row has no maple_id", async () => {
    if (!mongoReachable) return;
    // Insert a legacy-shaped row without `maple_id`.
    await db!.collection("assets").insertOne({
      folder_id: FOLDER_ID,
      abs_path: "/lib/legacy.dng",
      filename: "legacy.dng",
      size: 1024,
      mtime: Date.now(),
      rating: 0,
      flag: 0,
      color_label: "",
      indexed_at: new Date().toISOString(),
      exif: {
        captured_at: "2024-06-01T12:00:00.000Z",
        captured_year: 2024,
        captured_month: 6,
        camera_make: null,
        camera_model: null,
        lens: null,
        iso: null,
        aperture: null,
        shutter: null,
        focal_length: null,
        gps: { lat: 42.65, lng: -73.75 },
      },
      enrichment: {
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
      },
      place: null,
    } as unknown as AssetDoc);

    const meili = makeCapturingMeili();
    const worker = new GeocodeWorker({
      client: fakeNominatim(NOMINATIM_OK),
      cache: new CoordinateCache({ geocoderVersion: GEOCODE_HANDLER_VERSION }),
      breaker: new CircuitBreaker(),
      meilisearch: meili.client,
      pollMs: 1,
      leaseMs: 60_000,
    });
    const result = await worker.tick();
    expect(result.kind).toBe("completed");
    // Without a maple_id we skip the Meilisearch upsert entirely.
    expect(meili.upserts.length).toBe(0);
  });
});

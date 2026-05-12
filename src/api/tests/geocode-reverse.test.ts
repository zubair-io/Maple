import { describe, test, expect, beforeAll } from "bun:test";
import { Elysia } from "elysia";
import { MongoClient } from "mongodb";
import { quantizedKey } from "../src/enrichment/coordinate-cache.ts";

const TEST_DB = `maple_test_geocode_reverse_${process.pid}`;
const PRIOR_MONGO_DB = process.env.MAPLE_MONGO_DB;
process.env.MAPLE_MONGO_DB = TEST_DB;

const MONGO_URI = process.env.MAPLE_MONGO_URI ?? "mongodb://localhost:27017";

let mongo: MongoClient | null = null;
let mongoReachable = false;

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
    try {
      await c.close();
    } catch {}
    return null;
  }
}

beforeAll(async () => {
  mongo = await tryConnect();
  mongoReachable = mongo !== null;
  if (!mongoReachable) {
    console.log(
      "[geocode-reverse.test] skipping: MongoDB unreachable at",
      MONGO_URI,
    );
    return;
  }
  const db = mongo!.db(TEST_DB);
  await db.dropDatabase();

  // Reset the singleton DB connection so subsequent imports use TEST_DB.
  const { closeDb } = await import("../src/db/client.ts");
  await closeDb();

  const { geocodeCacheCollection } = await import("../src/db/client.ts");
  const c = await geocodeCacheCollection();
  await c.deleteMany({});
  // Seed with coords that differ at precision=4 vs precision=2 so the
  // custom-precision miss test (precision=2) genuinely misses.
  // quantizedKey(35.6801, 139.6901, 4) → "lat:35.6801,lon:139.6901"
  // quantizedKey(35.6801, 139.6901, 2) → "lat:35.68,lon:139.69"  (different → miss)
  await c.insertOne({
    _id: quantizedKey(35.6801, 139.6901),
    place: {
      address: {} as any,
      pois: [{ name: "Tokyo Station", category: "public_transport", type: "station" }],
      rollups: { locality: "Tokyo", region: "Tokyo", country: "Japan" } as any,
      search_blob: "Tokyo Station Tokyo Japan",
    } as any,
    fetched_at: new Date(),
    geocoder_version: 1,
  } as any);
});

describe("GET /api/geocode/reverse", () => {
  test("returns the cached Place when present", async () => {
    if (!mongoReachable) return;
    const { geocodeReverseRoutes } = await import(
      "../src/routes/geocode-reverse.ts"
    );
    const app = new Elysia().use(geocodeReverseRoutes);
    const res = await app.handle(
      new Request(
        "http://localhost/api/geocode/reverse?lat=35.6801&lon=139.6901",
      ),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.place.pois[0].name).toBe("Tokyo Station");
    expect(body.place.rollups.locality).toBe("Tokyo");
  });

  test("returns 404 when no cache row matches", async () => {
    if (!mongoReachable) return;
    const { geocodeReverseRoutes } = await import(
      "../src/routes/geocode-reverse.ts"
    );
    const app = new Elysia().use(geocodeReverseRoutes);
    const res = await app.handle(
      new Request("http://localhost/api/geocode/reverse?lat=0&lon=0"),
    );
    expect(res.status).toBe(404);
  });

  test("rejects missing params with 400", async () => {
    if (!mongoReachable) return;
    const { geocodeReverseRoutes } = await import(
      "../src/routes/geocode-reverse.ts"
    );
    const app = new Elysia().use(geocodeReverseRoutes);
    const res = await app.handle(
      new Request(
        "http://localhost/api/geocode/reverse?lat=35.68",
      ),
    );
    expect(res.status).toBe(400);
  });

  test("accepts custom precision", async () => {
    if (!mongoReachable) return;
    // Pre-seeded at precision 4. Query at precision 2 quantises differently → miss.
    const { geocodeReverseRoutes } = await import(
      "../src/routes/geocode-reverse.ts"
    );
    const app = new Elysia().use(geocodeReverseRoutes);
    const res = await app.handle(
      new Request(
        "http://localhost/api/geocode/reverse?lat=35.6801&lon=139.6901&precision=2",
      ),
    );
    expect(res.status).toBe(404);
  });
});

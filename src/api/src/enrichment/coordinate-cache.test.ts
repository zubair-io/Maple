/**
 * CoordinateCache tests — mostly real Mongo round-trips. Skip-pass when no
 * Mongo instance is reachable.
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterAll,
} from "bun:test";
import { MongoClient, type Db, type Collection } from "mongodb";
import {
  CoordinateCache,
  quantize,
  quantizedKey,
} from "./coordinate-cache.ts";
import type { GeocodeCacheDoc, Place } from "../db/schema.ts";

const TEST_DB = `maple_test_geocode_cache_${process.pid}`;
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
    console.log("[coordinate-cache.test] skipping: MongoDB unreachable");
    return;
  }
  db = mongo!.db(TEST_DB);
  await db.dropDatabase();
  const { closeDb } = await import("../db/client.ts");
  await closeDb();
});

beforeEach(async () => {
  if (!mongoReachable) return;
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

describe("quantize / quantizedKey — pure logic", () => {
  it("rounds to 4 decimal places by default", () => {
    expect(quantize(42.65261234, 4)).toBe(42.6526);
    expect(quantize(-73.75624999, 4)).toBe(-73.7562);
  });

  it("does not banker's-round at the .5 boundary", () => {
    // Math.round(...) rounds away from zero on positive halves; document the
    // contract so a test catches a regression to Number.toFixed.
    expect(quantize(0.00005, 4)).toBe(0.0001);
  });

  it("emits the documented key format", () => {
    expect(quantizedKey(42.6526, -73.7562)).toBe("lat:42.6526,lon:-73.7562");
  });

  it("collapses two coordinates within ~11m to the same key", () => {
    // Both lat values round to 42.6526 (0..0.5 below the next 4dp step).
    const a = quantizedKey(42.6526321, -73.7562109);
    const b = quantizedKey(42.6526111, -73.7562444);
    expect(a).toBe(b);
  });
});

describe("CoordinateCache — round-trip", () => {
  it("get() returns null on a cache miss", async () => {
    if (!mongoReachable) return;
    const cache = new CoordinateCache({ geocoderVersion: 1 });
    expect(await cache.get(42.6526, -73.7562)).toBeNull();
  });

  it("set() then get() returns the same Place", async () => {
    if (!mongoReachable) return;
    const cache = new CoordinateCache({ geocoderVersion: 1 });
    const place = makePlace();
    await cache.set(42.6526, -73.7562, place);
    const out = await cache.get(42.6526, -73.7562);
    expect(out).toEqual(place);
  });

  it("set() upserts on the quantised key, not the raw coords", async () => {
    if (!mongoReachable) return;
    const cache = new CoordinateCache({ geocoderVersion: 1 });
    // Both pairs round to (42.6526, -73.7562).
    await cache.set(42.65261234, -73.75623456, makePlace());
    const place2 = { ...makePlace(), display_name: "Updated" };
    await cache.set(42.65264111, -73.75618901, place2);
    const out = await cache.get(42.6526, -73.7562);
    expect(out!.display_name).toBe("Updated");

    // Only one row for this quantised key.
    const count = await cacheColl().countDocuments({
      _id: cache.keyFor(42.6526, -73.7562),
    });
    expect(count).toBe(1);
  });

  it("treats a stale geocoderVersion as a miss", async () => {
    if (!mongoReachable) return;
    const v1Cache = new CoordinateCache({ geocoderVersion: 1 });
    await v1Cache.set(42.6526, -73.7562, makePlace());
    const v2Cache = new CoordinateCache({ geocoderVersion: 2 });
    expect(await v2Cache.get(42.6526, -73.7562)).toBeNull();
  });

  it("set() at v2 overwrites the v1 row", async () => {
    if (!mongoReachable) return;
    const v1Cache = new CoordinateCache({ geocoderVersion: 1 });
    await v1Cache.set(42.6526, -73.7562, makePlace());
    const v2Place = { ...makePlace(), geocoder_version: 2 };
    const v2Cache = new CoordinateCache({ geocoderVersion: 2 });
    await v2Cache.set(42.6526, -73.7562, v2Place);
    expect(await v2Cache.get(42.6526, -73.7562)).toEqual(v2Place);
    // The v1 read still treats the row as a miss because the stored
    // geocoder_version is now 2.
    expect(await v1Cache.get(42.6526, -73.7562)).toBeNull();
  });

  it("records fetched_at on set()", async () => {
    if (!mongoReachable) return;
    const fixed = new Date("2026-05-08T13:00:00.000Z");
    const cache = new CoordinateCache({ geocoderVersion: 1, now: () => fixed });
    await cache.set(42.6526, -73.7562, makePlace());
    const row = await cacheColl().findOne({
      _id: cache.keyFor(42.6526, -73.7562),
    });
    expect(row!.fetched_at).toEqual(fixed);
  });
});

function cacheColl(): Collection<GeocodeCacheDoc> {
  return db!.collection<GeocodeCacheDoc>("geocode_cache");
}

function makePlace(): Place {
  return {
    source: "nominatim",
    geocoder_version: 1,
    geocoded_at: "2026-05-08T11:59:00.000Z",
    lat: 42.6526,
    lon: -73.7562,
    display_name: "New York State Museum",
    address: { city: "Albany", state: "New York", state_code: "NY" },
    pois: [{ name: "New York State Museum", category: "tourism", type: "museum" }],
    rollups: { locality: "Albany", region: "New York", country_code: "us" },
    search_blob: "",
  };
}

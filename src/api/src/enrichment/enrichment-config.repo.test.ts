/**
 * enrichment-config repo tests — pure resolver logic + real-Mongo round-trip.
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterAll,
} from "bun:test";
import { MongoClient, type Db } from "mongodb";
import {
  loadEnrichmentConfig,
  resolveEnrichmentConfig,
  saveEnrichmentConfig,
} from "./enrichment-config.repo.ts";

const TEST_DB = `maple_test_enrichment_cfg_${process.pid}`;
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
    console.log("[enrichment-config.test] skipping: MongoDB unreachable");
    return;
  }
  db = mongo!.db(TEST_DB);
  await db.dropDatabase();
  const { closeDb } = await import("../db/client.ts");
  await closeDb();
});

beforeEach(async () => {
  if (!mongoReachable) return;
  await db!.collection("app_settings").deleteMany({});
});

afterAll(async () => {
  if (mongo) {
    await mongo.db(TEST_DB).dropDatabase();
    await mongo.close();
  }
  const { closeDb } = await import("../db/client.ts");
  await closeDb();
});

describe("resolveEnrichmentConfig — pure logic", () => {
  it("falls back to env when there is no DB row", () => {
    const r = resolveEnrichmentConfig(null, {
      MAPLE_NOMINATIM_URL: "http://nominatim.lan:8080",
      MAPLE_GEOCODE_WORKER_ENABLED: "true",
    });
    expect(r.nominatim_url).toBe("http://nominatim.lan:8080");
    expect(r.geocode_worker_enabled).toBe(true);
    expect(r.source.nominatim_url).toBe("env");
    expect(r.source.geocode_worker_enabled).toBe("env");
  });

  it("DB wins over env", () => {
    const r = resolveEnrichmentConfig(
      { nominatim_url: "http://db.lan", geocode_worker_enabled: false },
      { MAPLE_NOMINATIM_URL: "http://env.lan", MAPLE_GEOCODE_WORKER_ENABLED: "true" },
    );
    expect(r.nominatim_url).toBe("http://db.lan");
    expect(r.geocode_worker_enabled).toBe(false);
    expect(r.source.nominatim_url).toBe("db");
    expect(r.source.geocode_worker_enabled).toBe("db");
  });

  it("returns defaults when neither DB nor env have a value", () => {
    const r = resolveEnrichmentConfig(null, {});
    expect(r.nominatim_url).toBeNull();
    expect(r.geocode_worker_enabled).toBe(true);
    expect(r.source.nominatim_url).toBe("unset");
    expect(r.source.geocode_worker_enabled).toBe("default");
  });

  it("MAPLE_GEOCODE_WORKER_ENABLED='false' disables", () => {
    const r = resolveEnrichmentConfig(null, {
      MAPLE_GEOCODE_WORKER_ENABLED: "false",
    });
    expect(r.geocode_worker_enabled).toBe(false);
    expect(r.source.geocode_worker_enabled).toBe("env");
  });

  it("DB null URL falls through to env", () => {
    const r = resolveEnrichmentConfig(
      { nominatim_url: null, geocode_worker_enabled: true },
      { MAPLE_NOMINATIM_URL: "http://env.lan" },
    );
    expect(r.nominatim_url).toBe("http://env.lan");
    expect(r.source.nominatim_url).toBe("env");
  });

  it("rate limit defaults to 10 when neither DB nor env set it", () => {
    const r = resolveEnrichmentConfig(null, {});
    expect(r.nominatim_rate_limit_per_sec).toBe(10);
    expect(r.source.nominatim_rate_limit_per_sec).toBe("default");
  });

  it("rate limit reads MAPLE_NOMINATIM_RATE_LIMIT_PER_SEC from env", () => {
    const r = resolveEnrichmentConfig(null, {
      MAPLE_NOMINATIM_RATE_LIMIT_PER_SEC: "5",
    });
    expect(r.nominatim_rate_limit_per_sec).toBe(5);
    expect(r.source.nominatim_rate_limit_per_sec).toBe("env");
  });

  it("rate limit DB wins over env", () => {
    const r = resolveEnrichmentConfig(
      {
        nominatim_url: null,
        geocode_worker_enabled: true,
        nominatim_rate_limit_per_sec: 2,
      },
      { MAPLE_NOMINATIM_RATE_LIMIT_PER_SEC: "20" },
    );
    expect(r.nominatim_rate_limit_per_sec).toBe(2);
    expect(r.source.nominatim_rate_limit_per_sec).toBe("db");
  });

  it("rate limit ignores non-positive DB values and falls through", () => {
    const r = resolveEnrichmentConfig(
      {
        nominatim_url: null,
        geocode_worker_enabled: true,
        nominatim_rate_limit_per_sec: 0,
      },
      { MAPLE_NOMINATIM_RATE_LIMIT_PER_SEC: "7" },
    );
    expect(r.nominatim_rate_limit_per_sec).toBe(7);
    expect(r.source.nominatim_rate_limit_per_sec).toBe("env");
  });

  it("rate limit ignores garbage env values and uses default", () => {
    const r = resolveEnrichmentConfig(null, {
      MAPLE_NOMINATIM_RATE_LIMIT_PER_SEC: "not-a-number",
    });
    expect(r.nominatim_rate_limit_per_sec).toBe(10);
    expect(r.source.nominatim_rate_limit_per_sec).toBe("default");
  });

  it("rate limit DB null falls through to env", () => {
    const r = resolveEnrichmentConfig(
      {
        nominatim_url: null,
        geocode_worker_enabled: true,
        nominatim_rate_limit_per_sec: null,
      },
      { MAPLE_NOMINATIM_RATE_LIMIT_PER_SEC: "3" },
    );
    expect(r.nominatim_rate_limit_per_sec).toBe(3);
    expect(r.source.nominatim_rate_limit_per_sec).toBe("env");
  });
});

describe("saveEnrichmentConfig + loadEnrichmentConfig — Mongo round-trip", () => {
  it("returns null before any save", async () => {
    if (!mongoReachable) return;
    const c = await loadEnrichmentConfig();
    expect(c).toBeNull();
  });

  it("save then load round-trips both fields", async () => {
    if (!mongoReachable) return;
    await saveEnrichmentConfig({
      nominatim_url: "http://nominatim.test:8080",
      geocode_worker_enabled: true,
    });
    const c = await loadEnrichmentConfig();
    expect(c).toMatchObject({
      nominatim_url: "http://nominatim.test:8080",
      geocode_worker_enabled: true,
    });
    expect(typeof c!.updated_at).toBe("number");
  });

  it("partial save preserves existing fields", async () => {
    if (!mongoReachable) return;
    await saveEnrichmentConfig({
      nominatim_url: "http://a.test",
      geocode_worker_enabled: true,
    });
    await saveEnrichmentConfig({ geocode_worker_enabled: false });
    const c = await loadEnrichmentConfig();
    expect(c!.nominatim_url).toBe("http://a.test");
    expect(c!.geocode_worker_enabled).toBe(false);
  });

  it("can clear the URL by saving null", async () => {
    if (!mongoReachable) return;
    await saveEnrichmentConfig({
      nominatim_url: "http://x",
      geocode_worker_enabled: true,
    });
    await saveEnrichmentConfig({ nominatim_url: null });
    const c = await loadEnrichmentConfig();
    expect(c!.nominatim_url).toBeNull();
  });

  it("partial save persists rate-limit and preserves URL", async () => {
    if (!mongoReachable) return;
    await saveEnrichmentConfig({
      nominatim_url: "http://saved.lan",
      geocode_worker_enabled: true,
    });
    await saveEnrichmentConfig({ nominatim_rate_limit_per_sec: 4 });
    const c = await loadEnrichmentConfig();
    expect(c!.nominatim_url).toBe("http://saved.lan");
    expect(c!.nominatim_rate_limit_per_sec).toBe(4);
  });

  it("can clear the rate limit by saving null", async () => {
    if (!mongoReachable) return;
    await saveEnrichmentConfig({
      nominatim_url: "http://saved.lan",
      geocode_worker_enabled: true,
      nominatim_rate_limit_per_sec: 4,
    });
    await saveEnrichmentConfig({ nominatim_rate_limit_per_sec: null });
    const c = await loadEnrichmentConfig();
    expect(c!.nominatim_rate_limit_per_sec).toBeNull();
  });
});

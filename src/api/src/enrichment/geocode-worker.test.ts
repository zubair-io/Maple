/**
 * GeocodeWorker integration tests.
 *
 * Real Mongo (skip-pass when unreachable). The Nominatim client is built
 * with a mock fetch so CI never depends on a real Nominatim instance.
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterAll,
} from "bun:test";
import {
  MongoClient,
  ObjectId,
  type Collection,
  type Db,
} from "mongodb";
import type { AssetDoc } from "../db/schema.ts";
import { CircuitBreaker } from "./circuit-breaker.ts";
import { CoordinateCache } from "./coordinate-cache.ts";
import {
  GeocodeWorker,
  GEOCODE_HANDLER_VERSION,
} from "./geocode-worker.ts";
import {
  NominatimClient,
  NominatimError,
} from "./nominatim-client.ts";

const TEST_DB = `maple_test_geocode_worker_${process.pid}`;
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
    console.log("[geocode-worker.test] skipping: MongoDB unreachable");
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

interface MockHttp {
  client: NominatimClient;
  /** Each entry is consumed in order; the last entry is reused for any
   * additional calls (so most tests can specify just one response). */
  setResponses: (responses: Array<MockResponse>) => void;
  callCount: () => number;
}

type MockResponse =
  | { kind: "ok"; body: unknown }
  | { kind: "status"; status: number }
  | { kind: "throw"; error: Error };

function mockClient(): MockHttp {
  let responses: Array<MockResponse> = [];
  let i = 0;
  const fetchImpl = (async () => {
    const r = responses[Math.min(i++, responses.length - 1)];
    if (!r) {
      return new Response("{}", { status: 200 });
    }
    if (r.kind === "throw") throw r.error;
    if (r.kind === "status") return new Response("{}", { status: r.status });
    return new Response(JSON.stringify(r.body), { status: 200 });
  }) as unknown as typeof fetch;

  const client = new NominatimClient({
    baseUrl: "http://nominatim.test",
    fetchImpl,
    rateLimitPerSec: 1000, // effectively unbounded for tests
  });
  return {
    client,
    setResponses: (r) => { responses = r; i = 0; },
    callCount: () => i,
  };
}

function museumResponse(): unknown {
  return {
    address: { city: "Albany", state: "New York", country_code: "us" },
    display_name: "Test Museum, Albany",
    category: "tourism",
    type: "museum",
    name: "Test Museum",
  };
}

interface SeedOpts {
  hasGps?: boolean;
  lockedBy?: string | null;
  leaseExpiresAt?: string | null;
  doneAt?: string | null;
  attempts?: number;
  deadLetterAt?: string | null;
}

async function seedAsset(opts: SeedOpts = {}): Promise<ObjectId> {
  const c = assetsColl();
  const _id = new ObjectId();
  const exif = opts.hasGps !== false
    ? {
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
        gps: { lat: 42.6526, lng: -73.7562 },
      }
    : null;
  await c.insertOne({
    _id,
    folder_id: new ObjectId(),
    filename: `${_id.toHexString()}.dng`,
    abs_path: `/lib/${_id.toHexString()}.dng`,
    size: 1,
    mtime: 1,
    rating: 0,
    flag: 0,
    color_label: "",
    indexed_at: new Date().toISOString(),
    exif: exif as never,
    enrichment: {
      geocode: {
        done_at: opts.doneAt ?? null,
        locked_by: opts.lockedBy ?? null,
        lease_expires_at: opts.leaseExpiresAt ?? null,
        attempts: opts.attempts ?? 0,
        last_error: null,
        version: null,
        dead_letter_at: opts.deadLetterAt ?? null,
      },
      face: {
        done_at: null, locked_by: null, lease_expires_at: null,
        attempts: 0, last_error: null, version: null, dead_letter_at: null,
      },
      describe: {
        done_at: null, locked_by: null, lease_expires_at: null,
        attempts: 0, last_error: null, version: null, dead_letter_at: null,
      },
    },
    place: null,
    faces: [],
    description: null,
  } as never);
  return _id;
}

function assetsColl(): Collection<AssetDoc> {
  return db!.collection<AssetDoc>("assets");
}

function makeWorker(opts: {
  http: MockHttp;
  workerId?: string;
  fixedNow?: Date;
  maxAttempts?: number;
  leaseMs?: number;
}): GeocodeWorker {
  const cache = new CoordinateCache({ geocoderVersion: GEOCODE_HANDLER_VERSION });
  return new GeocodeWorker({
    client: opts.http.client,
    cache,
    workerId: opts.workerId,
    pollMs: 0,
    leaseMs: opts.leaseMs ?? 5 * 60 * 1000,
    maxAttempts: opts.maxAttempts,
    now: opts.fixedNow ? () => opts.fixedNow! : undefined,
    log: () => {}, // silence
  });
}

describe("GeocodeWorker.tick — happy path", () => {
  it("claims a pending asset, geocodes it, and writes place + done_at", async () => {
    if (!mongoReachable) return;
    const id = await seedAsset();
    const http = mockClient();
    http.setResponses([{ kind: "ok", body: museumResponse() }]);
    const worker = makeWorker({ http });

    const result = await worker.tick();
    expect(result.kind).toBe("completed");

    const doc = await assetsColl().findOne({ _id: id });
    expect(doc!.place?.display_name).toBe("Test Museum, Albany");
    expect(doc!.enrichment!.geocode.done_at).toBeTruthy();
    expect(doc!.enrichment!.geocode.version).toBe(GEOCODE_HANDLER_VERSION);
    expect(doc!.enrichment!.geocode.locked_by).toBeNull();
    expect(doc!.enrichment!.geocode.lease_expires_at).toBeNull();
  });

  it("returns no-claim when nothing is pending", async () => {
    if (!mongoReachable) return;
    const http = mockClient();
    const worker = makeWorker({ http });
    const result = await worker.tick();
    expect(result.kind).toBe("no-claim");
    expect(http.callCount()).toBe(0);
  });

  it("ignores assets without GPS (covered by the claim filter)", async () => {
    if (!mongoReachable) return;
    await seedAsset({ hasGps: false });
    const http = mockClient();
    const worker = makeWorker({ http });
    const result = await worker.tick();
    expect(result.kind).toBe("no-claim");
    expect(http.callCount()).toBe(0);
  });

  it("ignores assets already done", async () => {
    if (!mongoReachable) return;
    await seedAsset({ doneAt: new Date().toISOString() });
    const http = mockClient();
    const worker = makeWorker({ http });
    const result = await worker.tick();
    expect(result.kind).toBe("no-claim");
  });
});

describe("GeocodeWorker.claim — atomic single-winner", () => {
  it("only one of two parallel claim attempts wins", async () => {
    if (!mongoReachable) return;
    const id = await seedAsset();
    const http = mockClient();
    http.setResponses([{ kind: "ok", body: museumResponse() }]);
    const a = makeWorker({ http, workerId: "worker-A" });
    const b = makeWorker({ http, workerId: "worker-B" });

    const [ra, rb] = await Promise.all([a.tick(), b.tick()]);
    const completedCount = [ra, rb].filter((r) => r.kind === "completed").length;
    const noClaimCount = [ra, rb].filter((r) => r.kind === "no-claim").length;
    expect(completedCount).toBe(1);
    expect(noClaimCount).toBe(1);

    const doc = await assetsColl().findOne({ _id: id });
    expect(doc!.enrichment!.geocode.done_at).toBeTruthy();
  });
});

describe("GeocodeWorker — lease expiry", () => {
  it("re-claims a row whose lease has expired", async () => {
    if (!mongoReachable) return;
    const id = await seedAsset({
      lockedBy: "dead-worker",
      leaseExpiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const http = mockClient();
    http.setResponses([{ kind: "ok", body: museumResponse() }]);
    const worker = makeWorker({ http });
    const result = await worker.tick();
    expect(result.kind).toBe("completed");

    const doc = await assetsColl().findOne({ _id: id });
    expect(doc!.enrichment!.geocode.done_at).toBeTruthy();
  });

  it("does NOT re-claim a row whose lease is still active", async () => {
    if (!mongoReachable) return;
    await seedAsset({
      lockedBy: "live-worker",
      leaseExpiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    });
    const http = mockClient();
    const worker = makeWorker({ http });
    const result = await worker.tick();
    expect(result.kind).toBe("no-claim");
    expect(http.callCount()).toBe(0);
  });
});

describe("GeocodeWorker — retry + dead-letter", () => {
  it("a 5xx increments attempts and releases the lock for re-claim", async () => {
    if (!mongoReachable) return;
    const id = await seedAsset();
    const http = mockClient();
    http.setResponses([{ kind: "status", status: 503 }]);
    const worker = makeWorker({ http, maxAttempts: 5 });

    const result = await worker.tick();
    expect(result.kind).toBe("failed");
    expect(result.kind === "failed" && result.retryable).toBe(true);
    expect(result.kind === "failed" && result.deadLettered).toBe(false);

    const doc = await assetsColl().findOne({ _id: id });
    expect(doc!.enrichment!.geocode.attempts).toBe(1);
    expect(doc!.enrichment!.geocode.locked_by).toBeNull();
    expect(doc!.enrichment!.geocode.last_error).toMatch(/5xx|503/);
    expect(doc!.enrichment!.geocode.dead_letter_at).toBeNull();
  });

  it("after maxAttempts retryable failures, dead-letters the row", async () => {
    if (!mongoReachable) return;
    const id = await seedAsset({ attempts: 4 }); // one more failure → dead-letter
    const http = mockClient();
    http.setResponses([{ kind: "status", status: 503 }]);
    const worker = makeWorker({ http, maxAttempts: 5 });

    const result = await worker.tick();
    expect(result.kind === "failed" && result.deadLettered).toBe(true);

    const doc = await assetsColl().findOne({ _id: id });
    expect(doc!.enrichment!.geocode.attempts).toBe(5);
    expect(doc!.enrichment!.geocode.dead_letter_at).toBeTruthy();
  });

  it("a 4xx dead-letters immediately (non-retryable)", async () => {
    if (!mongoReachable) return;
    const id = await seedAsset();
    const http = mockClient();
    http.setResponses([{ kind: "status", status: 400 }]);
    const worker = makeWorker({ http });

    const result = await worker.tick();
    expect(result.kind === "failed" && result.retryable).toBe(false);
    expect(result.kind === "failed" && result.deadLettered).toBe(true);

    const doc = await assetsColl().findOne({ _id: id });
    expect(doc!.enrichment!.geocode.dead_letter_at).toBeTruthy();
  });

  it("dead-lettered rows are not re-claimed", async () => {
    if (!mongoReachable) return;
    await seedAsset({
      deadLetterAt: new Date().toISOString(),
      attempts: 5,
    });
    const http = mockClient();
    const worker = makeWorker({ http });
    const result = await worker.tick();
    expect(result.kind).toBe("no-claim");
  });
});

describe("GeocodeWorker — circuit breaker", () => {
  it("once open, subsequent ticks return circuit-open without calling Nominatim", async () => {
    if (!mongoReachable) return;
    const http = mockClient();
    http.setResponses([{ kind: "status", status: 503 }]);
    const breaker = new CircuitBreaker({ failureThreshold: 1, openDurationMs: 1_000 });
    const cache = new CoordinateCache({ geocoderVersion: GEOCODE_HANDLER_VERSION });
    const worker = new GeocodeWorker({
      client: http.client,
      cache,
      breaker,
      pollMs: 0,
      log: () => {},
    });

    await seedAsset();
    const r1 = await worker.tick();
    expect(r1.kind).toBe("failed");

    // Now breaker is open. New seed, but tick must not call the client.
    await seedAsset();
    const r2 = await worker.tick();
    expect(r2.kind).toBe("circuit-open");
    // Only one HTTP call (the original 503).
    expect(http.callCount()).toBe(1);
  });
});

describe("GeocodeWorker — coordinate cache", () => {
  it("two assets at the same location share a single Nominatim call", async () => {
    if (!mongoReachable) return;
    await seedAsset();
    await seedAsset(); // same coords by default
    const http = mockClient();
    http.setResponses([{ kind: "ok", body: museumResponse() }]);
    const worker = makeWorker({ http });

    const r1 = await worker.tick();
    const r2 = await worker.tick();
    expect(r1.kind).toBe("completed");
    expect(r2.kind).toBe("completed");
    expect(r1.kind === "completed" && r1.cacheHit).toBe(false);
    expect(r2.kind === "completed" && r2.cacheHit).toBe(true);
    expect(http.callCount()).toBe(1);
  });
});

describe("GeocodeWorker — Place provenance", () => {
  it("uses the asset's lat/lon, not the Nominatim response's", async () => {
    if (!mongoReachable) return;
    const id = await seedAsset();
    const http = mockClient();
    http.setResponses([
      { kind: "ok", body: { ...(museumResponse() as object), lat: "99.9", lon: "99.9" } },
    ]);
    const worker = makeWorker({ http });
    await worker.tick();
    const doc = await assetsColl().findOne({ _id: id });
    expect(doc!.place?.lat).toBe(42.6526);
    expect(doc!.place?.lon).toBe(-73.7562);
  });
});

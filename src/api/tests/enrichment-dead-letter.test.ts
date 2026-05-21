/**
 * Slow-tier enrichment dead-letter triage tests.
 *
 * Covers `dead-letter.repo.ts` (list / group / reset) and the
 * `/api/enrichment/dead-letter/*` route surface. Round-trips against a
 * real MongoDB; skip-passes when the instance is unreachable, mirroring
 * the geocode-worker + indexer-dead-letter integration tests.
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterAll,
} from "bun:test";
import { Elysia } from "elysia";
import {
  MongoClient,
  ObjectId,
  type Collection,
  type Db,
} from "mongodb";
import type { AssetDoc, EnrichmentStageState } from "../src/db/schema.ts";
import type { EnrichmentStage } from "../src/enrichment/dead-letter.repo.ts";

const TEST_DB = `maple_test_enrichment_deadletter_${process.pid}`;
process.env.MAPLE_MONGO_DB = TEST_DB;
const MONGO_URI = process.env.MAPLE_MONGO_URI ?? "mongodb://localhost:27017";

let mongo: MongoClient | null = null;
let mongoReachable = false;
let db: Db | null = null;
let app: Elysia | null = null;

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
    } catch {
      /* ignore */
    }
    return null;
  }
}

// Single shared library id — every seeded asset's `fileinfo[0]` points
// at this library so `dead-letter.repo.ts` can resolve abs_path via the
// process-wide libraries cache. Path is `/lib` so the assertion
// `abs_path.startsWith("/lib/")` still holds.
const LIBRARY_ID = new ObjectId();

beforeAll(async () => {
  mongo = await tryConnect();
  mongoReachable = mongo !== null;
  if (!mongoReachable) {
    console.log("[enrichment-dead-letter.test] skipping: MongoDB unreachable");
    return;
  }
  db = mongo!.db(TEST_DB);
  await db.dropDatabase();
  await db.collection("folders").insertOne({
    _id: LIBRARY_ID,
    path: "/lib",
    label: "lib",
    last_scan: null,
    file_count: 0,
    created_at: new Date().toISOString(),
  } as never);
  // Reset the singleton so getDb() reads MAPLE_MONGO_DB on next call.
  const { closeDb } = await import("../src/db/client.ts");
  await closeDb();
  // Invalidate the process-wide library cache so `loadLibraryRoots`
  // re-reads the test DB rather than reusing sibling-suite entries.
  const { invalidateLibraryRoots } = await import(
    "../src/indexer/libraries.cache.ts"
  );
  invalidateLibraryRoots();
  // Mount the routes WITHOUT requireAuth — mirrors enrichment-route.test.ts.
  const { enrichmentAdminRoutes } = await import(
    "../src/routes/enrichment-admin.ts"
  );
  app = new Elysia().use(enrichmentAdminRoutes);
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

function pendingState(): EnrichmentStageState {
  return {
    done_at: null,
    locked_by: null,
    lease_expires_at: null,
    attempts: 0,
    last_error: null,
    version: null,
    dead_letter_at: null,
  };
}

interface SeedOpts {
  stage: EnrichmentStage;
  deadLetterAt: string | null;
  lastError?: string | null;
  attempts?: number;
  /** Optional second stage to seed in dead-letter on the SAME row. */
  alsoStage?: EnrichmentStage;
  alsoDeadLetterAt?: string | null;
  alsoLastError?: string | null;
  alsoAttempts?: number;
}

function assetsColl(): Collection<AssetDoc> {
  return db!.collection<AssetDoc>("assets");
}

async function seedAsset(opts: SeedOpts): Promise<ObjectId> {
  const _id = new ObjectId();
  const enrichment = {
    geocode: pendingState(),
    face: pendingState(),
    describe: pendingState(),
  };
  enrichment[opts.stage] = {
    ...pendingState(),
    dead_letter_at: opts.deadLetterAt,
    last_error: opts.lastError ?? null,
    attempts: opts.attempts ?? 0,
  };
  if (opts.alsoStage) {
    enrichment[opts.alsoStage] = {
      ...pendingState(),
      dead_letter_at: opts.alsoDeadLetterAt ?? null,
      last_error: opts.alsoLastError ?? null,
      attempts: opts.alsoAttempts ?? 0,
    };
  }
  await assetsColl().insertOne({
    _id,
    // Post drop-abs-path-2026-05-21 the on-disk pointer is solely
    // `fileinfo[]`; the dead-letter route resolves abs_path through the
    // libraries cache so the seeded folder above gives `/lib/<id>.dng`.
    fileinfo: [
      {
        library_id: LIBRARY_ID,
        path: "",
        filename: `${_id.toHexString()}.dng`,
        deleted_at: null,
      },
    ],
    size: 1,
    mtime: 1,
    rating: 0,
    flag: 0,
    color_label: "",
    indexed_at: new Date().toISOString(),
    exif: null,
    enrichment,
    place: null,
    faces: [],
    description: null,
  } as never);
  return _id;
}

// ---------------------------------------------------------------------------
// listEnrichmentDeadLetter
// ---------------------------------------------------------------------------

describe("listEnrichmentDeadLetter", () => {
  it("filters by stage and sorts newest dead_letter_at first", async () => {
    if (!mongoReachable) return;
    const { listEnrichmentDeadLetter } = await import(
      "../src/enrichment/dead-letter.repo.ts"
    );
    const idOldest = await seedAsset({
      stage: "geocode",
      deadLetterAt: "2026-05-01T00:00:00.000Z",
      lastError: "Nominatim 503",
      attempts: 5,
    });
    const idNewest = await seedAsset({
      stage: "geocode",
      deadLetterAt: "2026-05-08T00:00:00.000Z",
      lastError: "Nominatim timeout",
      attempts: 5,
    });
    const idMiddle = await seedAsset({
      stage: "geocode",
      deadLetterAt: "2026-05-04T00:00:00.000Z",
      lastError: "parse error",
      attempts: 5,
    });
    // A face-stage dead letter that should NOT appear in the geocode list.
    await seedAsset({
      stage: "face",
      deadLetterAt: "2026-05-09T00:00:00.000Z",
      lastError: "face boom",
      attempts: 5,
    });
    // A pending (not dead-lettered) geocode row that should also be excluded.
    await seedAsset({
      stage: "geocode",
      deadLetterAt: null,
    });

    const rows = await listEnrichmentDeadLetter({ stage: "geocode" });
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.asset_id)).toEqual([
      idNewest.toHexString(),
      idMiddle.toHexString(),
      idOldest.toHexString(),
    ]);
    const newest = rows[0]!;
    expect(newest.last_error).toBe("Nominatim timeout");
    expect(newest.attempts).toBe(5);
    expect(newest.dead_letter_at).toBe("2026-05-08T00:00:00.000Z");
    // Post drop-abs-path-2026-05-21: `abs_path` is `string | null`
    // (resolved server-side, null when fileinfo can't be matched to a
    // library). This seed has fileinfo + a folder, so it should resolve.
    expect(newest.abs_path).not.toBeNull();
    expect(newest.abs_path!.startsWith("/lib/")).toBe(true);
  });

  it("respects the limit parameter", async () => {
    if (!mongoReachable) return;
    const { listEnrichmentDeadLetter } = await import(
      "../src/enrichment/dead-letter.repo.ts"
    );
    for (let i = 0; i < 5; i++) {
      await seedAsset({
        stage: "geocode",
        deadLetterAt: `2026-05-0${i + 1}T00:00:00.000Z`,
        lastError: `err ${i}`,
        attempts: 5,
      });
    }
    const rows = await listEnrichmentDeadLetter({ stage: "geocode", limit: 2 });
    expect(rows).toHaveLength(2);
    expect(rows[0]!.dead_letter_at).toBe("2026-05-05T00:00:00.000Z");
    expect(rows[1]!.dead_letter_at).toBe("2026-05-04T00:00:00.000Z");
  });
});

// ---------------------------------------------------------------------------
// groupEnrichmentDeadLetter
// ---------------------------------------------------------------------------

describe("groupEnrichmentDeadLetter", () => {
  it("clusters identical errors and returns count + latestTs", async () => {
    if (!mongoReachable) return;
    const { groupEnrichmentDeadLetter } = await import(
      "../src/enrichment/dead-letter.repo.ts"
    );
    await seedAsset({
      stage: "geocode",
      deadLetterAt: "2026-05-01T00:00:00.000Z",
      lastError: "Nominatim 503",
      attempts: 5,
    });
    await seedAsset({
      stage: "geocode",
      deadLetterAt: "2026-05-08T00:00:00.000Z",
      lastError: "Nominatim 503",
      attempts: 5,
    });
    await seedAsset({
      stage: "geocode",
      deadLetterAt: "2026-05-05T00:00:00.000Z",
      lastError: "Nominatim 503",
      attempts: 5,
    });
    await seedAsset({
      stage: "geocode",
      deadLetterAt: "2026-05-09T00:00:00.000Z",
      lastError: "parse error",
      attempts: 5,
    });
    // face-stage dead letter — must NOT appear when we group geocode.
    await seedAsset({
      stage: "face",
      deadLetterAt: "2026-05-09T00:00:00.000Z",
      lastError: "Nominatim 503",
      attempts: 5,
    });

    const groups = await groupEnrichmentDeadLetter({ stage: "geocode" });
    expect(groups).toHaveLength(2);
    const top = groups[0]!;
    expect(top.errorClass).toBe("Nominatim 503");
    expect(top.count).toBe(3);
    expect(top.latestTs).toBe("2026-05-08T00:00:00.000Z");
    const second = groups[1]!;
    expect(second.errorClass).toBe("parse error");
    expect(second.count).toBe(1);
  });

  it("truncates errorClass at 80 chars so long messages with the same head collapse", async () => {
    if (!mongoReachable) return;
    const { groupEnrichmentDeadLetter } = await import(
      "../src/enrichment/dead-letter.repo.ts"
    );
    const head = "Nominatim 503 - retry after backoff (";
    expect(head.length).toBeLessThan(80);
    const longA = head + "x".repeat(80) + "_unique_A";
    const longB = head + "x".repeat(80) + "_unique_B";
    await seedAsset({
      stage: "geocode",
      deadLetterAt: "2026-05-01T00:00:00.000Z",
      lastError: longA,
      attempts: 5,
    });
    await seedAsset({
      stage: "geocode",
      deadLetterAt: "2026-05-02T00:00:00.000Z",
      lastError: longB,
      attempts: 5,
    });

    const groups = await groupEnrichmentDeadLetter({ stage: "geocode" });
    expect(groups).toHaveLength(1);
    expect(groups[0]!.count).toBe(2);
    expect(groups[0]!.errorClass.length).toBe(80);
    expect(longA.startsWith(groups[0]!.errorClass)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// resetEnrichmentDeadLetter
// ---------------------------------------------------------------------------

describe("resetEnrichmentDeadLetter", () => {
  it("targets one row when assetId is provided and clears dead_letter_at, last_error, attempts", async () => {
    if (!mongoReachable) return;
    const { resetEnrichmentDeadLetter } = await import(
      "../src/enrichment/dead-letter.repo.ts"
    );
    const target = await seedAsset({
      stage: "geocode",
      deadLetterAt: "2026-05-01T00:00:00.000Z",
      lastError: "Nominatim 503",
      attempts: 5,
    });
    const other = await seedAsset({
      stage: "geocode",
      deadLetterAt: "2026-05-02T00:00:00.000Z",
      lastError: "parse error",
      attempts: 5,
    });

    const res = await resetEnrichmentDeadLetter({
      stage: "geocode",
      assetId: target.toHexString(),
    });
    expect(res.resetCount).toBe(1);

    const targetDoc = await assetsColl().findOne({ _id: target });
    expect(targetDoc!.enrichment!.geocode.dead_letter_at).toBeNull();
    expect(targetDoc!.enrichment!.geocode.last_error).toBeNull();
    expect(targetDoc!.enrichment!.geocode.attempts).toBe(0);

    const otherDoc = await assetsColl().findOne({ _id: other });
    expect(otherDoc!.enrichment!.geocode.dead_letter_at).toBe(
      "2026-05-02T00:00:00.000Z",
    );
    expect(otherDoc!.enrichment!.geocode.attempts).toBe(5);
  });

  it("resets all dead-lettered rows for the stage when assetId is omitted", async () => {
    if (!mongoReachable) return;
    const { resetEnrichmentDeadLetter } = await import(
      "../src/enrichment/dead-letter.repo.ts"
    );
    const a = await seedAsset({
      stage: "geocode",
      deadLetterAt: "2026-05-01T00:00:00.000Z",
      lastError: "err a",
      attempts: 5,
    });
    const b = await seedAsset({
      stage: "geocode",
      deadLetterAt: "2026-05-02T00:00:00.000Z",
      lastError: "err b",
      attempts: 5,
    });
    // Pending (not dead-lettered) geocode row — must NOT be touched.
    const pending = await seedAsset({ stage: "geocode", deadLetterAt: null });

    const res = await resetEnrichmentDeadLetter({ stage: "geocode" });
    expect(res.resetCount).toBe(2);

    const docA = await assetsColl().findOne({ _id: a });
    const docB = await assetsColl().findOne({ _id: b });
    const docPending = await assetsColl().findOne({ _id: pending });
    expect(docA!.enrichment!.geocode.dead_letter_at).toBeNull();
    expect(docA!.enrichment!.geocode.attempts).toBe(0);
    expect(docB!.enrichment!.geocode.dead_letter_at).toBeNull();
    expect(docB!.enrichment!.geocode.attempts).toBe(0);
    // Pending row is unchanged (no dead_letter_at set, attempts still 0).
    expect(docPending!.enrichment!.geocode.dead_letter_at).toBeNull();
    expect(docPending!.enrichment!.geocode.attempts).toBe(0);
  });

  it("zeros attempts so the worker's retry budget is fresh", async () => {
    if (!mongoReachable) return;
    const { resetEnrichmentDeadLetter } = await import(
      "../src/enrichment/dead-letter.repo.ts"
    );
    const id = await seedAsset({
      stage: "geocode",
      deadLetterAt: "2026-05-01T00:00:00.000Z",
      lastError: "Nominatim 503",
      attempts: 5,
    });
    const res = await resetEnrichmentDeadLetter({
      stage: "geocode",
      assetId: id.toHexString(),
    });
    expect(res.resetCount).toBe(1);
    const doc = await assetsColl().findOne({ _id: id });
    // All three fields land in one updateMany — observe the post-state in
    // a single read.
    expect(doc!.enrichment!.geocode.dead_letter_at).toBeNull();
    expect(doc!.enrichment!.geocode.last_error).toBeNull();
    expect(doc!.enrichment!.geocode.attempts).toBe(0);
  });

  it("does not touch other stages on the same row", async () => {
    if (!mongoReachable) return;
    const { resetEnrichmentDeadLetter } = await import(
      "../src/enrichment/dead-letter.repo.ts"
    );
    const id = await seedAsset({
      stage: "geocode",
      deadLetterAt: "2026-05-01T00:00:00.000Z",
      lastError: "geocode err",
      attempts: 5,
      alsoStage: "face",
      alsoDeadLetterAt: "2026-05-02T00:00:00.000Z",
      alsoLastError: "face err",
      alsoAttempts: 5,
    });
    const res = await resetEnrichmentDeadLetter({
      stage: "geocode",
      assetId: id.toHexString(),
    });
    expect(res.resetCount).toBe(1);
    const doc = await assetsColl().findOne({ _id: id });
    expect(doc!.enrichment!.geocode.dead_letter_at).toBeNull();
    expect(doc!.enrichment!.geocode.last_error).toBeNull();
    expect(doc!.enrichment!.geocode.attempts).toBe(0);
    // Face stage is intact.
    expect(doc!.enrichment!.face.dead_letter_at).toBe(
      "2026-05-02T00:00:00.000Z",
    );
    expect(doc!.enrichment!.face.last_error).toBe("face err");
    expect(doc!.enrichment!.face.attempts).toBe(5);
  });

  it("returns resetCount: 0 for an unknown asset id", async () => {
    if (!mongoReachable) return;
    const { resetEnrichmentDeadLetter } = await import(
      "../src/enrichment/dead-letter.repo.ts"
    );
    const res = await resetEnrichmentDeadLetter({
      stage: "geocode",
      assetId: new ObjectId().toHexString(),
    });
    expect(res.resetCount).toBe(0);
  });

  it("returns resetCount: 0 for a malformed asset id", async () => {
    if (!mongoReachable) return;
    const { resetEnrichmentDeadLetter } = await import(
      "../src/enrichment/dead-letter.repo.ts"
    );
    const res = await resetEnrichmentDeadLetter({
      stage: "geocode",
      assetId: "not-a-valid-objectid",
    });
    expect(res.resetCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// HTTP routes
// ---------------------------------------------------------------------------

async function get(path: string): Promise<{ status: number; body: unknown }> {
  const res = await app!.handle(new Request(`http://localhost${path}`));
  return {
    status: res.status,
    body: res.status === 204 ? null : await res.json(),
  };
}

async function post(
  path: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: unknown }> {
  const res = await app!.handle(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return {
    status: res.status,
    body: res.status === 204 ? null : await res.json(),
  };
}

describe("GET /api/enrichment/dead-letter", () => {
  it("returns rows newest-first for the stage", async () => {
    if (!mongoReachable) return;
    const idNewest = await seedAsset({
      stage: "geocode",
      deadLetterAt: "2026-05-08T00:00:00.000Z",
      lastError: "Nominatim timeout",
      attempts: 5,
    });
    await seedAsset({
      stage: "geocode",
      deadLetterAt: "2026-05-01T00:00:00.000Z",
      lastError: "Nominatim 503",
      attempts: 5,
    });
    const r = await get("/api/enrichment/dead-letter?stage=geocode&limit=10");
    expect(r.status).toBe(200);
    const body = r.body as {
      rows: Array<{ asset_id: string; last_error: string }>;
    };
    expect(body.rows).toHaveLength(2);
    expect(body.rows[0]!.asset_id).toBe(idNewest.toHexString());
    expect(body.rows[0]!.last_error).toBe("Nominatim timeout");
  });

  it("rejects unknown stage with 400", async () => {
    if (!mongoReachable) return;
    const r = await get("/api/enrichment/dead-letter?stage=bogus");
    expect(r.status).toBe(400);
    expect((r.body as { error: string }).error).toMatch(/Invalid stage/);
  });
});

describe("GET /api/enrichment/dead-letter/groups", () => {
  it("returns clustered groups for the stage", async () => {
    if (!mongoReachable) return;
    await seedAsset({
      stage: "geocode",
      deadLetterAt: "2026-05-01T00:00:00.000Z",
      lastError: "Nominatim 503",
      attempts: 5,
    });
    await seedAsset({
      stage: "geocode",
      deadLetterAt: "2026-05-02T00:00:00.000Z",
      lastError: "Nominatim 503",
      attempts: 5,
    });
    await seedAsset({
      stage: "geocode",
      deadLetterAt: "2026-05-03T00:00:00.000Z",
      lastError: "Nominatim 503",
      attempts: 5,
    });
    const r = await get(
      "/api/enrichment/dead-letter/groups?stage=geocode",
    );
    expect(r.status).toBe(200);
    const body = r.body as {
      groups: Array<{ errorClass: string; count: number }>;
    };
    expect(body.groups).toHaveLength(1);
    expect(body.groups[0]!.count).toBe(3);
    expect(body.groups[0]!.errorClass).toBe("Nominatim 503");
  });

  it("rejects unknown stage with 400", async () => {
    if (!mongoReachable) return;
    const r = await get("/api/enrichment/dead-letter/groups?stage=bogus");
    expect(r.status).toBe(400);
  });
});

describe("POST /api/enrichment/dead-letter/reset", () => {
  it("resets one row when assetId is provided", async () => {
    if (!mongoReachable) return;
    const target = await seedAsset({
      stage: "geocode",
      deadLetterAt: "2026-05-01T00:00:00.000Z",
      lastError: "Nominatim 503",
      attempts: 5,
    });
    const r = await post("/api/enrichment/dead-letter/reset", {
      stage: "geocode",
      assetId: target.toHexString(),
    });
    expect(r.status).toBe(200);
    expect((r.body as { resetCount: number }).resetCount).toBe(1);
    const doc = await assetsColl().findOne({ _id: target });
    expect(doc!.enrichment!.geocode.dead_letter_at).toBeNull();
    expect(doc!.enrichment!.geocode.attempts).toBe(0);
  });

  it("resets all dead-lettered rows when assetId is omitted", async () => {
    if (!mongoReachable) return;
    await seedAsset({
      stage: "geocode",
      deadLetterAt: "2026-05-01T00:00:00.000Z",
      lastError: "err a",
      attempts: 5,
    });
    await seedAsset({
      stage: "geocode",
      deadLetterAt: "2026-05-02T00:00:00.000Z",
      lastError: "err b",
      attempts: 5,
    });
    const r = await post("/api/enrichment/dead-letter/reset", {
      stage: "geocode",
    });
    expect(r.status).toBe(200);
    expect((r.body as { resetCount: number }).resetCount).toBe(2);
  });

  it("rejects unknown stage with 400", async () => {
    if (!mongoReachable) return;
    const r = await post("/api/enrichment/dead-letter/reset", {
      stage: "bogus",
    });
    expect(r.status).toBe(400);
  });
});

/**
 * Tests for GET /api/search/facets — aggregation buckets for FE dropdowns.
 *
 * Bare-Elysia `app.handle` style; mirrors `tests/auth/enforcement.test.ts`.
 * Skip-passes if MongoDB is unreachable.
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
} from "bun:test";
import { Elysia } from "elysia";
import { MongoClient, ObjectId } from "mongodb";
import { baseSeeds, fmtAuth, seedFolders, tryConnect } from "./_setup.ts";

const TEST_DB = `maple_test_search_facets_${process.pid}`;
const PRIOR_MONGO_DB = process.env.MAPLE_MONGO_DB;
process.env.MAPLE_MONGO_DB = TEST_DB;

let mongo: MongoClient | null = null;
let mongoReachable = false;
const folderA = new ObjectId();
const folderB = new ObjectId();

beforeAll(async () => {
  mongo = await tryConnect();
  mongoReachable = mongo !== null;
  if (!mongoReachable) {
    console.log("[search/facets.test] skipping: MongoDB unreachable");
    return;
  }
  const db = mongo!.db(TEST_DB);
  await db.dropDatabase();
  await seedFolders(db, folderA, folderB);
  await db.collection("assets").insertMany(baseSeeds(folderA, folderB));

  const { closeDb } = await import("../../src/db/client.ts");
  await closeDb();
});

afterAll(async () => {
  if (mongo && mongoReachable) {
    try {
      await mongo.db(TEST_DB).dropDatabase();
    } catch {}
    try {
      await mongo.close();
    } catch {}
  }
  try {
    const { closeDb } = await import("../../src/db/client.ts");
    await closeDb();
  } catch {}
  if (PRIOR_MONGO_DB === undefined) delete process.env.MAPLE_MONGO_DB;
  else process.env.MAPLE_MONGO_DB = PRIOR_MONGO_DB;
});

describe("/api/search/facets", () => {
  it("aggregates camera + lens + ext + iso + capture range", async () => {
    if (!mongoReachable) return;
    const { searchRoutes } = await import("../../src/routes/search.ts");
    const { requireAuth } = await import("../../src/auth/middleware.ts");
    const app = new Elysia().use(requireAuth).use(searchRoutes);

    const r = await app.handle(
      new Request("http://localhost/api/search/facets", { headers: fmtAuth() }),
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      total: number;
      cameras: Array<{
        make: string | null;
        model: string | null;
        count: number;
      }>;
      lenses: Array<{ value: string | null; count: number }>;
      extensions: Array<{ value: string; count: number }>;
      iso_range: { min: number; max: number } | null;
      capture_range: { from: string; to: string } | null;
    };
    expect(body.total).toBe(4);
    // Three cameras with EXIF + one null group for the JPG without EXIF.
    expect(body.cameras.length).toBeGreaterThanOrEqual(3);
    const makes = new Set(body.cameras.map((c) => c.make));
    expect(makes.has("Hasselblad")).toBe(true);
    expect(makes.has("Canon")).toBe(true);
    expect(makes.has("Sony")).toBe(true);
    // Lens facets.
    const lensValues = new Set(body.lenses.map((l) => l.value));
    expect(lensValues.has("Hasselblad 24mm f/1.5")).toBe(true);
    // Extensions cover dng/cr3/arw/jpg.
    const exts = new Set(body.extensions.map((e) => e.value));
    expect(exts.has("dng")).toBe(true);
    expect(exts.has("cr3")).toBe(true);
    expect(exts.has("arw")).toBe(true);
    expect(exts.has("jpg")).toBe(true);
    // ISO range spans 100..1600.
    expect(body.iso_range!.min).toBe(100);
    expect(body.iso_range!.max).toBe(1600);
    // Capture range covers the seeded ISO 8601 strings.
    expect(body.capture_range!.from <= body.capture_range!.to).toBe(true);
  });

  it("respects libraryId scope", async () => {
    if (!mongoReachable) return;
    const { searchRoutes } = await import("../../src/routes/search.ts");
    const { requireAuth } = await import("../../src/auth/middleware.ts");
    const app = new Elysia().use(requireAuth).use(searchRoutes);

    const r = await app.handle(
      new Request(
        `http://localhost/api/search/facets?libraryId=${folderA.toHexString()}`,
        { headers: fmtAuth() },
      ),
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as { total: number; cameras: unknown[] };
    expect(body.total).toBe(2);
  });
});

/**
 * Tests for /api/search and /api/search/facets.
 *
 * Mirrors `tests/auth/enforcement.test.ts`'s bare-Elysia-`app.handle` style.
 * Skip-passes if MongoDB is unreachable.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Elysia } from "elysia";
import { MongoClient, ObjectId } from "mongodb";
import { signAccessToken } from "../src/auth/tokens.ts";

// JWT bootstrap MUST run before any module that touches `requireAuth`.
process.env.MAPLE_JWT_SECRET = "x".repeat(32);

const SECRET = process.env.MAPLE_JWT_SECRET!;
const BEARER = "Bearer " + signAccessToken(
  { sub: "00000000000000000000000a", email: "tester@maple.local", role: "owner" },
  SECRET
);

// Each test run uses a unique DB so concurrent dev work / CI shards don't collide.
const TEST_DB = `maple_test_search_${process.pid}`;
process.env.MAPLE_MONGO_DB = TEST_DB;

const MONGO_URI = process.env.MAPLE_MONGO_URI ?? "mongodb://localhost:27017";

interface Seed {
  abs_path: string;
  filename: string;
  size: number;
  mtime: number;
  rating: number;
  flag: -1 | 0 | 1;
  color_label: string;
  indexed_at: string;
  folder_id: ObjectId;
  exif?: {
    captured_at: string | null;
    camera_make: string | null;
    camera_model: string | null;
    lens: string | null;
    iso: number | null;
    aperture: number | null;
    shutter: string | null;
    focal_length: number | null;
    gps: { lat: number; lng: number } | null;
  } | null;
  deleted_at?: string | null;
}

function fmtAuth(): Record<string, string> {
  return { Authorization: BEARER };
}

let mongo: MongoClient | null = null;
let mongoReachable = false;
const folderA = new ObjectId();
const folderB = new ObjectId();

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
    console.log("[search-route.test] skipping: MongoDB unreachable at", MONGO_URI);
    return;
  }
  const db = mongo!.db(TEST_DB);
  // Wipe any prior state from a previous incomplete run.
  await db.dropDatabase();

  const seeds: Seed[] = [
    {
      folder_id: folderA,
      abs_path: "/lib-a/dji-mavic3pro-100mp.dng",
      filename: "dji-mavic3pro-100mp.dng",
      size: 1024,
      mtime: Date.now(),
      rating: 5,
      flag: 1,
      color_label: "red",
      indexed_at: new Date().toISOString(),
      exif: {
        captured_at: "2024-06-01T12:00:00.000Z",
        camera_make: "Hasselblad",
        camera_model: "L3D-100c",
        lens: "Hasselblad 24mm f/1.5",
        iso: 100,
        aperture: 2.8,
        shutter: "1/250",
        focal_length: 24,
        gps: { lat: 52.5, lng: 13.4 },
      },
    },
    {
      folder_id: folderA,
      abs_path: "/lib-a/sunset.cr3",
      filename: "sunset.cr3",
      size: 2048,
      mtime: Date.now() - 1000,
      rating: 3,
      flag: 0,
      color_label: "",
      indexed_at: new Date().toISOString(),
      exif: {
        captured_at: "2023-12-25T18:30:00.000Z",
        camera_make: "Canon",
        camera_model: "EOS R5",
        lens: "RF 24-70mm f/2.8L IS USM",
        iso: 800,
        aperture: 5.6,
        shutter: "1/60",
        focal_length: 50,
        gps: null,
      },
    },
    {
      folder_id: folderB,
      abs_path: "/lib-b/sony.arw",
      filename: "sony.arw",
      size: 4096,
      mtime: Date.now() - 2000,
      rating: 4,
      flag: 1,
      color_label: "green",
      indexed_at: new Date().toISOString(),
      exif: {
        captured_at: "2024-01-15T09:15:00.000Z",
        camera_make: "Sony",
        camera_model: "A7R V",
        lens: "FE 70-200mm f/2.8 GM",
        iso: 1600,
        aperture: 4.0,
        shutter: "1/1000",
        focal_length: 200,
        gps: null,
      },
    },
    {
      folder_id: folderB,
      abs_path: "/lib-b/no-exif.jpg",
      filename: "no-exif.jpg",
      size: 512,
      mtime: Date.now() - 3000,
      rating: 0,
      flag: 0,
      color_label: "",
      indexed_at: new Date().toISOString(),
      exif: null,
    },
    {
      // Soft-deleted row — must NOT appear in search results.
      folder_id: folderB,
      abs_path: "/lib-b/deleted.dng",
      filename: "deleted.dng",
      size: 256,
      mtime: Date.now() - 4000,
      rating: 0,
      flag: 0,
      color_label: "",
      indexed_at: new Date().toISOString(),
      exif: null,
      deleted_at: new Date().toISOString(),
    },
  ];
  await db.collection("assets").insertMany(seeds);
});

afterAll(async () => {
  if (mongo && mongoReachable) {
    try { await mongo.db(TEST_DB).dropDatabase(); } catch {}
    try { await mongo.close(); } catch {}
  }
});

describe("/api/search", () => {
  it("requires a bearer", async () => {
    if (!mongoReachable) return;
    const { searchRoutes } = await import("../src/routes/search.ts");
    const { requireAuth } = await import("../src/auth/middleware.ts");
    const app = new Elysia().use(requireAuth).use(searchRoutes);
    const r = await app.handle(new Request("http://localhost/api/search"));
    expect(r.status).toBe(401);
  });

  it("returns all live assets (4) when no filters", async () => {
    if (!mongoReachable) return;
    const { searchRoutes } = await import("../src/routes/search.ts");
    const { requireAuth } = await import("../src/auth/middleware.ts");
    const app = new Elysia().use(requireAuth).use(searchRoutes);

    const r = await app.handle(
      new Request("http://localhost/api/search", { headers: fmtAuth() })
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as { total: number; results: unknown[] };
    expect(body.total).toBe(4);
    expect(body.results.length).toBe(4);
  });

  it("filters by free-text q against filename", async () => {
    if (!mongoReachable) return;
    const { searchRoutes } = await import("../src/routes/search.ts");
    const { requireAuth } = await import("../src/auth/middleware.ts");
    const app = new Elysia().use(requireAuth).use(searchRoutes);

    const r = await app.handle(
      new Request("http://localhost/api/search?q=sunset", { headers: fmtAuth() })
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as { total: number; results: Array<{ filename: string; id: string }> };
    expect(body.total).toBe(1);
    expect(body.results[0]!.filename).toBe("sunset.cr3");
    expect(body.results[0]!.id).toBe("fs:/lib-a/sunset.cr3");
  });

  it("filters by camera (substring on make + model)", async () => {
    if (!mongoReachable) return;
    const { searchRoutes } = await import("../src/routes/search.ts");
    const { requireAuth } = await import("../src/auth/middleware.ts");
    const app = new Elysia().use(requireAuth).use(searchRoutes);

    const r = await app.handle(
      new Request("http://localhost/api/search?camera=Hasselblad", { headers: fmtAuth() })
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as { total: number; results: Array<{ filename: string }> };
    expect(body.total).toBe(1);
    expect(body.results[0]!.filename).toBe("dji-mavic3pro-100mp.dng");
  });

  it("filters by date range", async () => {
    if (!mongoReachable) return;
    const { searchRoutes } = await import("../src/routes/search.ts");
    const { requireAuth } = await import("../src/auth/middleware.ts");
    const app = new Elysia().use(requireAuth).use(searchRoutes);

    const r = await app.handle(
      new Request(
        "http://localhost/api/search?from=2024-01-01&to=2024-12-31",
        { headers: fmtAuth() }
      )
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as { total: number; results: Array<{ filename: string }> };
    // Hasselblad (2024-06-01) + Sony (2024-01-15) = 2
    expect(body.total).toBe(2);
  });

  it("filters by rating threshold", async () => {
    if (!mongoReachable) return;
    const { searchRoutes } = await import("../src/routes/search.ts");
    const { requireAuth } = await import("../src/auth/middleware.ts");
    const app = new Elysia().use(requireAuth).use(searchRoutes);

    const r = await app.handle(
      new Request("http://localhost/api/search?rating=4", { headers: fmtAuth() })
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as { total: number };
    // Hasselblad (5) + Sony (4) = 2
    expect(body.total).toBe(2);
  });

  it("scopes by libraryId", async () => {
    if (!mongoReachable) return;
    const { searchRoutes } = await import("../src/routes/search.ts");
    const { requireAuth } = await import("../src/auth/middleware.ts");
    const app = new Elysia().use(requireAuth).use(searchRoutes);

    const r = await app.handle(
      new Request(
        `http://localhost/api/search?libraryId=${folderA.toHexString()}`,
        { headers: fmtAuth() }
      )
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as { total: number; results: Array<{ folder_id: string }> };
    expect(body.total).toBe(2);
    for (const row of body.results) {
      expect(row.folder_id).toBe(folderA.toHexString());
    }
  });

  it("filters by ext", async () => {
    if (!mongoReachable) return;
    const { searchRoutes } = await import("../src/routes/search.ts");
    const { requireAuth } = await import("../src/auth/middleware.ts");
    const app = new Elysia().use(requireAuth).use(searchRoutes);

    const r = await app.handle(
      new Request("http://localhost/api/search?ext=dng,cr3", { headers: fmtAuth() })
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as { total: number; results: Array<{ filename: string }> };
    expect(body.total).toBe(2);
    const names = body.results.map((r) => r.filename).sort();
    expect(names).toEqual(["dji-mavic3pro-100mp.dng", "sunset.cr3"]);
  });

  it("rejects invalid ext", async () => {
    if (!mongoReachable) return;
    const { searchRoutes } = await import("../src/routes/search.ts");
    const { requireAuth } = await import("../src/auth/middleware.ts");
    const app = new Elysia().use(requireAuth).use(searchRoutes);

    const r = await app.handle(
      new Request("http://localhost/api/search?ext=dng;cr3", { headers: fmtAuth() })
    );
    expect(r.status).toBe(400);
  });

  it("returns no matches for nonsense q", async () => {
    if (!mongoReachable) return;
    const { searchRoutes } = await import("../src/routes/search.ts");
    const { requireAuth } = await import("../src/auth/middleware.ts");
    const app = new Elysia().use(requireAuth).use(searchRoutes);

    const r = await app.handle(
      new Request(
        "http://localhost/api/search?q=notarealfilename_xyzpdq",
        { headers: fmtAuth() }
      )
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as { total: number; results: unknown[] };
    expect(body.total).toBe(0);
    expect(body.results.length).toBe(0);
  });

  it("paginates with limit + page", async () => {
    if (!mongoReachable) return;
    const { searchRoutes } = await import("../src/routes/search.ts");
    const { requireAuth } = await import("../src/auth/middleware.ts");
    const app = new Elysia().use(requireAuth).use(searchRoutes);

    const r1 = await app.handle(
      new Request("http://localhost/api/search?limit=2&page=0", { headers: fmtAuth() })
    );
    const r2 = await app.handle(
      new Request("http://localhost/api/search?limit=2&page=1", { headers: fmtAuth() })
    );
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    const b1 = (await r1.json()) as { total: number; results: Array<{ _id: string }> };
    const b2 = (await r2.json()) as { total: number; results: Array<{ _id: string }> };
    expect(b1.total).toBe(4);
    expect(b1.results.length).toBe(2);
    expect(b2.results.length).toBe(2);
    // Pages don't overlap.
    const ids1 = new Set(b1.results.map((r) => r._id));
    const ids2 = new Set(b2.results.map((r) => r._id));
    for (const id of ids2) expect(ids1.has(id)).toBe(false);
  });

  it("excludes soft-deleted rows", async () => {
    if (!mongoReachable) return;
    const { searchRoutes } = await import("../src/routes/search.ts");
    const { requireAuth } = await import("../src/auth/middleware.ts");
    const app = new Elysia().use(requireAuth).use(searchRoutes);

    const r = await app.handle(
      new Request(
        "http://localhost/api/search?q=deleted",
        { headers: fmtAuth() }
      )
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as { total: number };
    expect(body.total).toBe(0);
  });
});

describe("/api/search/facets", () => {
  it("aggregates camera + lens + ext + iso + capture range", async () => {
    if (!mongoReachable) return;
    const { searchRoutes } = await import("../src/routes/search.ts");
    const { requireAuth } = await import("../src/auth/middleware.ts");
    const app = new Elysia().use(requireAuth).use(searchRoutes);

    const r = await app.handle(
      new Request("http://localhost/api/search/facets", { headers: fmtAuth() })
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      total: number;
      cameras: Array<{ make: string | null; model: string | null; count: number }>;
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
    const { searchRoutes } = await import("../src/routes/search.ts");
    const { requireAuth } = await import("../src/auth/middleware.ts");
    const app = new Elysia().use(requireAuth).use(searchRoutes);

    const r = await app.handle(
      new Request(
        `http://localhost/api/search/facets?libraryId=${folderA.toHexString()}`,
        { headers: fmtAuth() }
      )
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as { total: number; cameras: unknown[] };
    expect(body.total).toBe(2);
  });
});

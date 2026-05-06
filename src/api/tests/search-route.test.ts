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

// Timeline-related endpoints (`pathPrefix`, `hasCapturedAt`, `/buckets`).
//
// We add an isolated set of fixtures inside this describe block so the
// existing `total: 4` assertions in the prior describes still hold — the
// new rows are inserted in this block's `beforeAll` and removed in its
// `afterAll`. Bun runs `describe` blocks sequentially within a file, so
// the prior tests have already finished by the time this `beforeAll`
// fires.
const folderC = new ObjectId();
// Marker prefix on filenames so we can scope this describe's cleanup
// without disturbing the file-level seed. Using a UUID-ish stem instead
// of the abs_path keeps `pathPrefix` tests independent of the marker.
const TL_MARK = `tl_${process.pid}`;
describe("/api/search timeline filters + buckets", () => {
  beforeAll(async () => {
    if (!mongoReachable) return;
    const db = mongo!.db(TEST_DB);
    const seeds: Seed[] = [
      // pathPrefix fixtures: /A/1.dng, /A/B/2.dng, /C/3.dng. Plus a regex-
      // special path /A (1)/photo.dng to exercise escapeRegex.
      {
        folder_id: folderC,
        abs_path: "/A/1.dng",
        filename: `${TL_MARK}_pp1.tlraw`,
        size: 1024,
        mtime: 1,
        rating: 0,
        flag: 0,
        color_label: "",
        indexed_at: new Date().toISOString(),
        exif: {
          captured_at: "2025-03-10T12:00:00.000Z",
          camera_make: "Nikon",
          camera_model: "Z9",
          lens: null,
          iso: 200,
          aperture: 4.0,
          shutter: "1/500",
          focal_length: 85,
          gps: null,
        },
      },
      {
        folder_id: folderC,
        abs_path: "/A/B/2.dng",
        filename: `${TL_MARK}_pp2.tlraw`,
        size: 1024,
        mtime: 2,
        rating: 0,
        flag: 0,
        color_label: "",
        indexed_at: new Date().toISOString(),
        exif: {
          captured_at: "2025-03-15T12:00:00.000Z",
          camera_make: "Nikon",
          camera_model: "Z9",
          lens: null,
          iso: 200,
          aperture: 4.0,
          shutter: "1/500",
          focal_length: 85,
          gps: null,
        },
      },
      {
        folder_id: folderC,
        abs_path: "/C/3.dng",
        filename: `${TL_MARK}_pp3.tlraw`,
        size: 1024,
        mtime: 3,
        rating: 0,
        flag: 0,
        color_label: "",
        indexed_at: new Date().toISOString(),
        exif: {
          captured_at: "2025-04-10T12:00:00.000Z",
          camera_make: "Nikon",
          camera_model: "Z9",
          lens: null,
          iso: 200,
          aperture: 4.0,
          shutter: "1/500",
          focal_length: 85,
          gps: null,
        },
      },
      // Path with regex specials — verifies `escapeRegex` is wired.
      {
        folder_id: folderC,
        abs_path: "/A (1)/photo.dng",
        filename: `${TL_MARK}_pp4.tlraw`,
        size: 1024,
        mtime: 4,
        rating: 0,
        flag: 0,
        color_label: "",
        indexed_at: new Date().toISOString(),
        exif: {
          captured_at: "2025-05-10T12:00:00.000Z",
          camera_make: "Nikon",
          camera_model: "Z9",
          lens: null,
          iso: 200,
          aperture: 4.0,
          shutter: "1/500",
          focal_length: 85,
          gps: null,
        },
      },
      // pathPrefix + camera composition fixture: a row that matches /A/
      // but is NOT a Nikon — used to confirm AND-ing.
      {
        folder_id: folderC,
        abs_path: "/A/canon.dng",
        filename: `${TL_MARK}_pp5.tlraw`,
        size: 1024,
        mtime: 5,
        rating: 0,
        flag: 0,
        color_label: "",
        indexed_at: new Date().toISOString(),
        exif: {
          captured_at: "2025-06-10T12:00:00.000Z",
          camera_make: "CanonTL",
          camera_model: "EOS-TL",
          lens: null,
          iso: 200,
          aperture: 4.0,
          shutter: "1/500",
          focal_length: 85,
          gps: null,
        },
      },
      // Buckets fixture: assets across 2 years × 3 months for /buckets shape.
      // Counts: 2026/05=2, 2026/04=1, 2025/12=3 — so the sort is across years
      // and months and we can assert ordering deterministically.
      ...[
        { date: "2026-05-01T12:00:00.000Z", n: 2 },
        { date: "2026-04-01T12:00:00.000Z", n: 1 },
        { date: "2025-12-01T12:00:00.000Z", n: 3 },
      ].flatMap((b, gi) =>
        Array.from({ length: b.n }, (_, i) => ({
          folder_id: folderC,
          abs_path: `/buckets/${gi}-${i}.dng`,
          filename: `${TL_MARK}_b${gi}_${i}.tlraw`,
          size: 1024,
          mtime: 100 + gi * 10 + i,
          rating: 0,
          flag: 0 as -1 | 0 | 1,
          color_label: "",
          indexed_at: new Date().toISOString(),
          exif: {
            captured_at: b.date,
            camera_make: "BucketCam",
            camera_model: "BC-1",
            lens: null,
            iso: 200,
            aperture: 4.0,
            shutter: "1/500",
            focal_length: 85,
            gps: null,
          },
        } as Seed))
      ),
      // Untimed rows — explicit null AND missing-field — to test the
      // (b)-branch missing-exif handling in /buckets.
      {
        folder_id: folderC,
        abs_path: "/buckets/untimed-null.dng",
        filename: `${TL_MARK}_un_null.tlraw`,
        size: 1024,
        mtime: 200,
        rating: 0,
        flag: 0,
        color_label: "",
        indexed_at: new Date().toISOString(),
        exif: {
          captured_at: null,
          camera_make: null,
          camera_model: null,
          lens: null,
          iso: null,
          aperture: null,
          shutter: null,
          focal_length: null,
          gps: null,
        },
      },
      // No `exif` key at all — Mongo stores this as a missing field.
      {
        folder_id: folderC,
        abs_path: "/buckets/untimed-missing.dng",
        filename: `${TL_MARK}_un_missing.tlraw`,
        size: 1024,
        mtime: 201,
        rating: 0,
        flag: 0,
        color_label: "",
        indexed_at: new Date().toISOString(),
        // exif intentionally omitted
      },
      // Soft-deleted under /A/ — must NOT appear in pathPrefix or buckets.
      {
        folder_id: folderC,
        abs_path: "/A/deleted-tl.dng",
        filename: `${TL_MARK}_del.tlraw`,
        size: 1024,
        mtime: 300,
        rating: 0,
        flag: 0,
        color_label: "",
        indexed_at: new Date().toISOString(),
        exif: {
          captured_at: "2025-03-20T12:00:00.000Z",
          camera_make: "Nikon",
          camera_model: "Z9",
          lens: null,
          iso: 200,
          aperture: 4.0,
          shutter: "1/500",
          focal_length: 85,
          gps: null,
        },
        deleted_at: new Date().toISOString(),
      },
    ];
    await db.collection("assets").insertMany(seeds);
  });

  afterAll(async () => {
    if (!mongoReachable) return;
    const db = mongo!.db(TEST_DB);
    await db.collection("assets").deleteMany({ folder_id: folderC });
  });

  it("pathPrefix=/A/ returns rows under /A/ but not /C/", async () => {
    if (!mongoReachable) return;
    const { searchRoutes } = await import("../src/routes/search.ts");
    const { requireAuth } = await import("../src/auth/middleware.ts");
    const app = new Elysia().use(requireAuth).use(searchRoutes);

    const r = await app.handle(
      new Request(
        `http://localhost/api/search?pathPrefix=/A/&libraryId=${folderC.toHexString()}`,
        { headers: fmtAuth() }
      )
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      total: number;
      results: Array<{ abs_path: string }>;
    };
    // /A/1.dng + /A/B/2.dng + /A/canon.dng. The /A (1)/photo.dng does NOT
    // start with the literal "/A/" so it's excluded. /C/3.dng is excluded.
    // Soft-deleted /A/deleted-tl.dng is excluded.
    const paths = new Set(body.results.map((r) => r.abs_path));
    expect(paths.has("/A/1.dng")).toBe(true);
    expect(paths.has("/A/B/2.dng")).toBe(true);
    expect(paths.has("/A/canon.dng")).toBe(true);
    expect(paths.has("/C/3.dng")).toBe(false);
    expect(paths.has("/A/deleted-tl.dng")).toBe(false);
    expect(body.total).toBe(3);
  });

  it("pathPrefix escapes regex specials (parentheses)", async () => {
    if (!mongoReachable) return;
    const { searchRoutes } = await import("../src/routes/search.ts");
    const { requireAuth } = await import("../src/auth/middleware.ts");
    const app = new Elysia().use(requireAuth).use(searchRoutes);

    const r = await app.handle(
      new Request(
        // /A (1)/ contains regex specials; without escapeRegex the regex
        // would be illegal or match unintended paths.
        `http://localhost/api/search?pathPrefix=${encodeURIComponent("/A (1)/")}&libraryId=${folderC.toHexString()}`,
        { headers: fmtAuth() }
      )
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      total: number;
      results: Array<{ abs_path: string }>;
    };
    expect(body.total).toBe(1);
    expect(body.results[0]!.abs_path).toBe("/A (1)/photo.dng");
  });

  it("pathPrefix composes (AND) with q free-text", async () => {
    if (!mongoReachable) return;
    const { searchRoutes } = await import("../src/routes/search.ts");
    const { requireAuth } = await import("../src/auth/middleware.ts");
    const app = new Elysia().use(requireAuth).use(searchRoutes);

    // q matches both `${TL_MARK}_pp1.tlraw` (under /A/) and would match
    // `${TL_MARK}_pp3.tlraw` (under /C/) — adding pathPrefix=/A/ trims
    // it to just the row under /A/.
    const r = await app.handle(
      new Request(
        `http://localhost/api/search?q=${encodeURIComponent(TL_MARK)}&pathPrefix=/A/&libraryId=${folderC.toHexString()}`,
        { headers: fmtAuth() }
      )
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as { total: number; results: Array<{ abs_path: string }> };
    expect(body.total).toBe(3);
    for (const row of body.results) {
      expect(row.abs_path.startsWith("/A/")).toBe(true);
    }
  });

  it("pathPrefix composes (AND) with camera (exercises $or → $and switch)", async () => {
    if (!mongoReachable) return;
    const { searchRoutes } = await import("../src/routes/search.ts");
    const { requireAuth } = await import("../src/auth/middleware.ts");
    const app = new Elysia().use(requireAuth).use(searchRoutes);

    // camera builds a $or; with q ALSO set, the existing code switches
    // those into a $and-of-$ors. pathPrefix is a top-level abs_path field
    // that must AND with that.
    const r = await app.handle(
      new Request(
        `http://localhost/api/search?camera=CanonTL&pathPrefix=/A/&libraryId=${folderC.toHexString()}`,
        { headers: fmtAuth() }
      )
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as { total: number; results: Array<{ abs_path: string }> };
    expect(body.total).toBe(1);
    expect(body.results[0]!.abs_path).toBe("/A/canon.dng");

    // And the same query with q + camera + pathPrefix — exercises the
    // explicit $and lift in buildFilter.
    const r2 = await app.handle(
      new Request(
        `http://localhost/api/search?q=${encodeURIComponent(TL_MARK)}&camera=CanonTL&pathPrefix=/A/&libraryId=${folderC.toHexString()}`,
        { headers: fmtAuth() }
      )
    );
    expect(r2.status).toBe(200);
    const body2 = (await r2.json()) as { total: number };
    expect(body2.total).toBe(1);
  });

  it("hasCapturedAt=true excludes null AND missing-exif rows", async () => {
    if (!mongoReachable) return;
    const { searchRoutes } = await import("../src/routes/search.ts");
    const { requireAuth } = await import("../src/auth/middleware.ts");
    const app = new Elysia().use(requireAuth).use(searchRoutes);

    const r = await app.handle(
      new Request(
        // pathPrefix=/buckets/ scopes to the buckets fixture so we know the
        // exact composition: 2+1+3 timed + 2 untimed (one null, one missing).
        `http://localhost/api/search?pathPrefix=/buckets/&hasCapturedAt=true&libraryId=${folderC.toHexString()}&limit=200`,
        { headers: fmtAuth() }
      )
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      total: number;
      results: Array<{ captured_at: string | null }>;
    };
    expect(body.total).toBe(6);
    for (const row of body.results) {
      expect(row.captured_at).not.toBeNull();
    }
  });

  it("hasCapturedAt=true composes with from/to without losing constraints", async () => {
    if (!mongoReachable) return;
    const { searchRoutes } = await import("../src/routes/search.ts");
    const { requireAuth } = await import("../src/auth/middleware.ts");
    const app = new Elysia().use(requireAuth).use(searchRoutes);

    // 2026 only — should match the 2 + 1 = 3 buckets fixture rows.
    const r = await app.handle(
      new Request(
        `http://localhost/api/search?pathPrefix=/buckets/&hasCapturedAt=true&from=2026-01-01&to=2026-12-31&libraryId=${folderC.toHexString()}&limit=200`,
        { headers: fmtAuth() }
      )
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as { total: number };
    expect(body.total).toBe(3);
  });

  it("/buckets returns expected shape, sorted year/month desc", async () => {
    if (!mongoReachable) return;
    const { searchRoutes } = await import("../src/routes/search.ts");
    const { requireAuth } = await import("../src/auth/middleware.ts");
    const app = new Elysia().use(requireAuth).use(searchRoutes);

    const r = await app.handle(
      new Request(
        `http://localhost/api/search/buckets?pathPrefix=/buckets/&libraryId=${folderC.toHexString()}`,
        { headers: fmtAuth() }
      )
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      total: number;
      buckets: Array<{ year: number; month: number; count: number }>;
      untimed_count: number;
    };
    expect(body.buckets).toEqual([
      { year: 2026, month: 5, count: 2 },
      { year: 2026, month: 4, count: 1 },
      { year: 2025, month: 12, count: 3 },
    ]);
    expect(body.total).toBe(6);
    expect(body.untimed_count).toBe(2);
  });

  it("/buckets untimed_count counts both null captured_at and missing exif", async () => {
    if (!mongoReachable) return;
    const { searchRoutes } = await import("../src/routes/search.ts");
    const { requireAuth } = await import("../src/auth/middleware.ts");
    const app = new Elysia().use(requireAuth).use(searchRoutes);

    const r = await app.handle(
      new Request(
        `http://localhost/api/search/buckets?pathPrefix=/buckets/&libraryId=${folderC.toHexString()}`,
        { headers: fmtAuth() }
      )
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as { untimed_count: number };
    // Two seeded under /buckets/: one with `exif.captured_at: null`,
    // one with no `exif` field at all. Both must count.
    expect(body.untimed_count).toBe(2);
  });

  it("/buckets honours pathPrefix and excludes soft-deleted rows", async () => {
    if (!mongoReachable) return;
    const { searchRoutes } = await import("../src/routes/search.ts");
    const { requireAuth } = await import("../src/auth/middleware.ts");
    const app = new Elysia().use(requireAuth).use(searchRoutes);

    // pathPrefix=/A/ has /A/1.dng (2025-03), /A/B/2.dng (2025-03),
    // /A/canon.dng (2025-06). The soft-deleted /A/deleted-tl.dng must NOT
    // appear in either timed or untimed counts.
    const r = await app.handle(
      new Request(
        `http://localhost/api/search/buckets?pathPrefix=/A/&libraryId=${folderC.toHexString()}`,
        { headers: fmtAuth() }
      )
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      total: number;
      buckets: Array<{ year: number; month: number; count: number }>;
      untimed_count: number;
    };
    expect(body.total).toBe(3);
    expect(body.untimed_count).toBe(0);
    expect(body.buckets).toEqual([
      { year: 2025, month: 6, count: 1 },
      { year: 2025, month: 3, count: 2 },
    ]);
  });

  it("/buckets with empty result returns total: 0 + status 200", async () => {
    if (!mongoReachable) return;
    const { searchRoutes } = await import("../src/routes/search.ts");
    const { requireAuth } = await import("../src/auth/middleware.ts");
    const app = new Elysia().use(requireAuth).use(searchRoutes);

    const r = await app.handle(
      new Request(
        `http://localhost/api/search/buckets?pathPrefix=/does-not-exist/&libraryId=${folderC.toHexString()}`,
        { headers: fmtAuth() }
      )
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      total: number;
      buckets: unknown[];
      untimed_count: number;
    };
    expect(body.total).toBe(0);
    expect(body.buckets).toEqual([]);
    expect(body.untimed_count).toBe(0);
  });

  it("rejects pathPrefix > 1024 chars", async () => {
    if (!mongoReachable) return;
    const { searchRoutes } = await import("../src/routes/search.ts");
    const { requireAuth } = await import("../src/auth/middleware.ts");
    const app = new Elysia().use(requireAuth).use(searchRoutes);

    const longPrefix = "/" + "x".repeat(1024);
    const r = await app.handle(
      new Request(
        `http://localhost/api/search?pathPrefix=${encodeURIComponent(longPrefix)}`,
        { headers: fmtAuth() }
      )
    );
    expect(r.status).toBe(400);
  });

  it("ensureIndexes creates abs_path_1 index (idempotent)", async () => {
    if (!mongoReachable) return;
    const { ensureIndexes } = await import("../src/db/client.ts");
    // Pre-create the auxiliary collections that ensureIndexes touches —
    // some Mongo operations (e.g. dropIndex on a fresh namespace) raise
    // NamespaceNotFound rather than IndexNotFound, which the production
    // code path doesn't need to handle because real deploys always have
    // these collections populated by the time ensureIndexes runs.
    const db = mongo!.db(TEST_DB);
    for (const name of ["users", "credentials", "invites", "refresh_tokens", "challenges", "folders"]) {
      try { await db.createCollection(name); } catch {}
    }
    // Idempotent: call twice, second call must not throw.
    await ensureIndexes();
    await ensureIndexes();
    const indexes = await db.collection("assets").indexes();
    const names = new Set(indexes.map((i) => i.name as string));
    expect(names.has("abs_path_1")).toBe(true);
  });
});

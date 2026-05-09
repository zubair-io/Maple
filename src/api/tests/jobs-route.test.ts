/**
 * /api/jobs HTTP round-trip tests via `app.handle`.
 *
 * Mirrors `tests/search-route.test.ts` — bare-Elysia construction, real
 * Mongo, skip-pass when MongoDB is unreachable.
 *
 * Coverage:
 *   - bearer required (401 without)
 *   - POST /api/jobs validates kind, returns id
 *   - GET /api/jobs/:id returns the doc
 *   - POST /api/jobs/:id/cancel flips cancel_requested
 *   - GET /api/jobs?status= filters
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
import { MongoClient } from "mongodb";
import { signAccessToken } from "../src/auth/tokens.ts";

// JWT bootstrap MUST run before any module that touches `requireAuth`.
process.env.MAPLE_JWT_SECRET = "x".repeat(32);

const SECRET = process.env.MAPLE_JWT_SECRET!;
const BEARER =
  "Bearer " +
  signAccessToken(
    {
      sub: "00000000000000000000000a",
      email: "tester@maple.local",
      role: "owner",
    },
    SECRET,
  );

const TEST_DB = `maple_test_jobs_route_${process.pid}`;
const PRIOR_MONGO_DB = process.env.MAPLE_MONGO_DB;
process.env.MAPLE_MONGO_DB = TEST_DB;
const MONGO_URI = process.env.MAPLE_MONGO_URI ?? "mongodb://localhost:27017";

let mongo: MongoClient | null = null;
let mongoReachable = false;

function fmtAuth(): Record<string, string> {
  return { Authorization: BEARER, "Content-Type": "application/json" };
}

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
      "[jobs-route.test] skipping: MongoDB unreachable at",
      MONGO_URI,
    );
    return;
  }
  await mongo!.db(TEST_DB).dropDatabase();
  const { closeDb } = await import("../src/db/client.ts");
  await closeDb();
});

beforeEach(async () => {
  if (!mongoReachable) return;
  await mongo!.db(TEST_DB).collection("jobs").deleteMany({});
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
    const { closeDb } = await import("../src/db/client.ts");
    await closeDb();
  } catch {}
  if (PRIOR_MONGO_DB === undefined) delete process.env.MAPLE_MONGO_DB;
  else process.env.MAPLE_MONGO_DB = PRIOR_MONGO_DB;
});

describe("/api/jobs", () => {
  it("requires a bearer", async () => {
    if (!mongoReachable) return;
    const { jobsRoutes } = await import("../src/routes/jobs.ts");
    const { requireAuth } = await import("../src/auth/middleware.ts");
    const app = new Elysia().use(requireAuth).use(jobsRoutes);
    const r = await app.handle(new Request("http://localhost/api/jobs"));
    expect(r.status).toBe(401);
  });

  it("POST /api/jobs creates a queued job and returns id", async () => {
    if (!mongoReachable) return;
    const { jobsRoutes } = await import("../src/routes/jobs.ts");
    const { requireAuth } = await import("../src/auth/middleware.ts");
    const app = new Elysia().use(requireAuth).use(jobsRoutes);

    const r = await app.handle(
      new Request("http://localhost/api/jobs", {
        method: "POST",
        headers: fmtAuth(),
        body: JSON.stringify({
          kind: "batch_jpeg_export",
          payload: { assetIds: [], outputDir: "/tmp", quality: 82 },
        }),
      }),
    );
    expect(r.status).toBe(201);
    const body = (await r.json()) as { id: string };
    expect(typeof body.id).toBe("string");
    expect(body.id.length).toBe(24);
  });

  it("POST /api/jobs rejects unknown kinds", async () => {
    if (!mongoReachable) return;
    const { jobsRoutes } = await import("../src/routes/jobs.ts");
    const { requireAuth } = await import("../src/auth/middleware.ts");
    const app = new Elysia().use(requireAuth).use(jobsRoutes);

    const r = await app.handle(
      new Request("http://localhost/api/jobs", {
        method: "POST",
        headers: fmtAuth(),
        body: JSON.stringify({ kind: "no_such_kind", payload: {} }),
      }),
    );
    expect(r.status).toBe(400);
  });

  it("GET /api/jobs/:id returns the doc; 404 on unknown", async () => {
    if (!mongoReachable) return;
    const { jobsRoutes } = await import("../src/routes/jobs.ts");
    const { requireAuth } = await import("../src/auth/middleware.ts");
    const app = new Elysia().use(requireAuth).use(jobsRoutes);

    const post = await app.handle(
      new Request("http://localhost/api/jobs", {
        method: "POST",
        headers: fmtAuth(),
        body: JSON.stringify({
          kind: "batch_jpeg_export",
          payload: { assetIds: [], outputDir: "/tmp", quality: 82 },
        }),
      }),
    );
    const { id } = (await post.json()) as { id: string };

    const get = await app.handle(
      new Request(`http://localhost/api/jobs/${id}`, { headers: fmtAuth() }),
    );
    expect(get.status).toBe(200);
    const body = (await get.json()) as {
      id: string;
      status: string;
      cancel_requested: boolean;
      progress: { current: number; total: number };
    };
    expect(body.id).toBe(id);
    expect(body.status).toBe("queued");
    expect(body.cancel_requested).toBe(false);
    expect(body.progress).toEqual({ current: 0, total: 0 });

    const miss = await app.handle(
      new Request("http://localhost/api/jobs/000000000000000000000000", {
        headers: fmtAuth(),
      }),
    );
    expect(miss.status).toBe(404);
  });

  it("POST /api/jobs/:id/cancel flips cancel_requested", async () => {
    if (!mongoReachable) return;
    const { jobsRoutes } = await import("../src/routes/jobs.ts");
    const { requireAuth } = await import("../src/auth/middleware.ts");
    const app = new Elysia().use(requireAuth).use(jobsRoutes);

    const post = await app.handle(
      new Request("http://localhost/api/jobs", {
        method: "POST",
        headers: fmtAuth(),
        body: JSON.stringify({
          kind: "batch_jpeg_export",
          payload: { assetIds: [], outputDir: "/tmp", quality: 82 },
        }),
      }),
    );
    const { id } = (await post.json()) as { id: string };

    const cancel = await app.handle(
      new Request(`http://localhost/api/jobs/${id}/cancel`, {
        method: "POST",
        headers: fmtAuth(),
      }),
    );
    expect(cancel.status).toBe(200);
    const after = await app.handle(
      new Request(`http://localhost/api/jobs/${id}`, { headers: fmtAuth() }),
    );
    const body = (await after.json()) as { cancel_requested: boolean };
    expect(body.cancel_requested).toBe(true);
  });

  it("GET /api/jobs?status= filters by status", async () => {
    if (!mongoReachable) return;
    const { jobsRoutes } = await import("../src/routes/jobs.ts");
    const { requireAuth } = await import("../src/auth/middleware.ts");
    const app = new Elysia().use(requireAuth).use(jobsRoutes);

    // Create three queued jobs.
    for (let i = 0; i < 3; i++) {
      await app.handle(
        new Request("http://localhost/api/jobs", {
          method: "POST",
          headers: fmtAuth(),
          body: JSON.stringify({
            kind: "batch_jpeg_export",
            payload: { assetIds: [], outputDir: "/tmp", quality: 82 },
          }),
        }),
      );
    }

    const list = await app.handle(
      new Request(
        "http://localhost/api/jobs?status=queued&kind=batch_jpeg_export&limit=10",
        { headers: fmtAuth() },
      ),
    );
    expect(list.status).toBe(200);
    const body = (await list.json()) as { jobs: unknown[] };
    expect(body.jobs.length).toBe(3);

    const empty = await app.handle(
      new Request("http://localhost/api/jobs?status=done", {
        headers: fmtAuth(),
      }),
    );
    const e = (await empty.json()) as { jobs: unknown[] };
    expect(e.jobs.length).toBe(0);
  });
});

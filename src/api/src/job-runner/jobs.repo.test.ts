/**
 * jobs.repo integration tests. Real Mongo (skip-pass when unreachable).
 *
 * Covers:
 *   - create → claim → progress → complete round-trip
 *   - double-claim collision (only one of two concurrent claims wins)
 *   - lease expiry: a stale lock is reclaimable on the next pass
 *   - cancel: requestCancel flips the flag; isCancelRequested observes it
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

const TEST_DB = `maple_test_jobs_repo_${process.pid}`;
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
    console.log("[jobs.repo.test] skipping: MongoDB unreachable");
    return;
  }
  db = mongo!.db(TEST_DB);
  await db.dropDatabase();
  const { closeDb } = await import("../db/client.ts");
  await closeDb();
});

beforeEach(async () => {
  if (!mongoReachable) return;
  await db!.collection("jobs").deleteMany({});
});

afterAll(async () => {
  if (mongo) {
    try {
      await mongo.db(TEST_DB).dropDatabase();
    } catch {}
    try {
      await mongo.close();
    } catch {}
  }
  const { closeDb } = await import("../db/client.ts");
  await closeDb();
});

describe("jobs.repo", () => {
  it("create → claim → updateProgress → complete", async () => {
    if (!mongoReachable) return;
    const repo = await import("./jobs.repo.ts");

    const created = await repo.createJob({
      kind: "batch_jpeg_export",
      payload: { assetIds: ["a"], outputDir: "/tmp", quality: 80 },
    });
    expect(created._id).toBeDefined();
    expect(created.status).toBe("queued");
    expect(created.progress).toEqual({ current: 0, total: 0 });

    const claim = await repo.claimJob("worker-1", 60_000);
    expect(claim).not.toBeNull();
    expect(claim!.kind).toBe("batch_jpeg_export");
    const after = await repo.getJob(claim!._id);
    expect(after!.status).toBe("running");
    expect(after!.locked_by).toBe("worker-1");

    await repo.updateProgress(claim!._id, { current: 1, total: 5 }, 60_000);
    const mid = await repo.getJob(claim!._id);
    expect(mid!.progress).toEqual({ current: 1, total: 5 });

    await repo.completeJob(claim!._id, { successCount: 5 });
    const done = await repo.getJob(claim!._id);
    expect(done!.status).toBe("done");
    expect(done!.locked_by).toBeNull();
    expect(done!.lease_expires_at).toBeNull();
    expect(done!.result).toEqual({ successCount: 5 });
  });

  it("double-claim collision: only one of two concurrent claims wins", async () => {
    if (!mongoReachable) return;
    const repo = await import("./jobs.repo.ts");

    await repo.createJob({
      kind: "batch_jpeg_export",
      payload: { assetIds: [], outputDir: "/tmp", quality: 80 },
    });

    const [a, b] = await Promise.all([
      repo.claimJob("worker-A", 60_000),
      repo.claimJob("worker-B", 60_000),
    ]);
    const wins = [a, b].filter((c) => c !== null);
    expect(wins.length).toBe(1);
  });

  it("lease expiry: a stale lock is reclaimable", async () => {
    if (!mongoReachable) return;
    const repo = await import("./jobs.repo.ts");

    const created = await repo.createJob({
      kind: "batch_jpeg_export",
      payload: { assetIds: [], outputDir: "/tmp", quality: 80 },
    });

    // Claim with a 10ms lease, simulate worker death by leaving lock in place.
    const t0 = new Date("2026-01-01T00:00:00.000Z");
    const c1 = await repo.claimJob("dead-worker", 10, () => t0);
    expect(c1).not.toBeNull();

    // 1 second later — lease should be expired, second worker can reclaim.
    const t1 = new Date("2026-01-01T00:00:01.000Z");
    const c2 = await repo.claimJob("live-worker", 60_000, () => t1);
    expect(c2).not.toBeNull();
    expect(c2!._id.toHexString()).toBe(created._id.toHexString());

    const after = await repo.getJob(created._id);
    expect(after!.locked_by).toBe("live-worker");
  });

  it("cancel: requestCancel + isCancelRequested + markCancelled", async () => {
    if (!mongoReachable) return;
    const repo = await import("./jobs.repo.ts");

    const created = await repo.createJob({
      kind: "batch_jpeg_export",
      payload: { assetIds: [], outputDir: "/tmp", quality: 80 },
    });

    expect(await repo.isCancelRequested(created._id)).toBe(false);
    const ok = await repo.requestCancel(created._id);
    expect(ok).toBe(true);
    expect(await repo.isCancelRequested(created._id)).toBe(true);

    // Simulate the runner observing the flag and ending the job.
    await repo.claimJob("worker-1", 60_000);
    await repo.markCancelled(created._id);
    const done = await repo.getJob(created._id);
    expect(done!.status).toBe("cancelled");
    expect(done!.locked_by).toBeNull();
  });

  it("listJobs filters by status and kind", async () => {
    if (!mongoReachable) return;
    const repo = await import("./jobs.repo.ts");

    const a = await repo.createJob({
      kind: "batch_jpeg_export",
      payload: { assetIds: [], outputDir: "/tmp", quality: 80 },
    });
    const b = await repo.createJob({
      kind: "batch_jpeg_export",
      payload: { assetIds: [], outputDir: "/tmp", quality: 80 },
    });
    await repo.claimJob("w", 60_000); // bumps one to running
    await repo.completeJob(a._id, {});

    const queued = await repo.listJobs({ status: "queued" });
    expect(queued.map((j) => j._id.toHexString())).toEqual([
      b._id.toHexString(),
    ]);
    const done = await repo.listJobs({ status: "done" });
    expect(done.map((j) => j._id.toHexString())).toEqual([
      a._id.toHexString(),
    ]);
  });
});

/**
 * JobRunner unit tests. Real Mongo (skip-pass when unreachable). The handler
 * is stubbed so we don't depend on the FFI pool — the behaviour we care
 * about here is the runner's claim/dispatch/complete loop, not the work.
 *
 * Covers:
 *   - queued job is picked up and completed
 *   - progress is reported through ctx.reportProgress
 *   - cancellation observed mid-run flips status to "cancelled"
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
import type { JobHandler, JobHandlerContext } from "./handlers/index.ts";

const TEST_DB = `maple_test_job_runner_${process.pid}`;
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
    console.log("[runner.test] skipping: MongoDB unreachable");
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

describe("JobRunner", () => {
  it("picks up a queued job and completes it", async () => {
    if (!mongoReachable) return;
    const { JobRunner } = await import("./runner.ts");
    const repo = await import("./jobs.repo.ts");

    const stub: JobHandler = {
      async run() {
        return { kind: "done", result: { ok: true } };
      },
    };
    const runner = new JobRunner({
      handlers: { batch_jpeg_export: stub },
      pollMs: 5,
    });

    const job = await repo.createJob({
      kind: "batch_jpeg_export",
      payload: { assetIds: [], outputDir: "/tmp", quality: 80 },
    });

    const tick = await runner.tick();
    expect(tick.kind).toBe("completed");

    const after = await repo.getJob(job._id);
    expect(after!.status).toBe("done");
    expect(after!.result).toEqual({ ok: true });
    expect(after!.locked_by).toBeNull();
  });

  it("reports progress through ctx.reportProgress", async () => {
    if (!mongoReachable) return;
    const { JobRunner } = await import("./runner.ts");
    const repo = await import("./jobs.repo.ts");

    let observedDuringRun = { current: -1, total: -1 };
    const stub: JobHandler = {
      async run(_payload, ctx: JobHandlerContext) {
        await ctx.reportProgress(0, 3);
        await ctx.reportProgress(1, 3);
        await ctx.reportProgress(2, 3);
        const mid = await (await import("./jobs.repo.ts")).getJob(ctx.jobId);
        observedDuringRun = mid!.progress;
        await ctx.reportProgress(3, 3);
        return { kind: "done", result: { count: 3 } };
      },
    };
    const runner = new JobRunner({
      handlers: { batch_jpeg_export: stub },
    });

    const job = await repo.createJob({
      kind: "batch_jpeg_export",
      payload: { assetIds: [], outputDir: "/tmp", quality: 80 },
    });

    await runner.tick();
    expect(observedDuringRun).toEqual({ current: 2, total: 3 });

    const after = await repo.getJob(job._id);
    expect(after!.progress).toEqual({ current: 3, total: 3 });
    expect(after!.status).toBe("done");
  });

  it("cancellation observed mid-run flips status to cancelled", async () => {
    if (!mongoReachable) return;
    const { JobRunner } = await import("./runner.ts");
    const repo = await import("./jobs.repo.ts");

    const job = await repo.createJob({
      kind: "batch_jpeg_export",
      payload: { assetIds: [], outputDir: "/tmp", quality: 80 },
    });

    const stub: JobHandler = {
      async run(_payload, ctx: JobHandlerContext) {
        // Simulate batch loop: report progress, observe cancel between steps.
        await ctx.reportProgress(0, 5);
        await repo.requestCancel(ctx.jobId);
        if (await ctx.shouldCancel()) {
          return {
            kind: "cancelled",
            result: { partial: true },
          };
        }
        return { kind: "done", result: {} };
      },
    };
    const runner = new JobRunner({
      handlers: { batch_jpeg_export: stub },
    });

    const tick = await runner.tick();
    expect(tick.kind).toBe("cancelled");

    const after = await repo.getJob(job._id);
    expect(after!.status).toBe("cancelled");
    expect(after!.result).toEqual({ partial: true });
    expect(after!.locked_by).toBeNull();
  });

  it("returns no-claim when there is nothing queued", async () => {
    if (!mongoReachable) return;
    const { JobRunner } = await import("./runner.ts");
    const runner = new JobRunner({ handlers: {} });
    const tick = await runner.tick();
    expect(tick.kind).toBe("no-claim");
  });

  it("fails the job when handler throws", async () => {
    if (!mongoReachable) return;
    const { JobRunner } = await import("./runner.ts");
    const repo = await import("./jobs.repo.ts");

    const stub: JobHandler = {
      async run() {
        throw new Error("boom");
      },
    };
    const runner = new JobRunner({
      handlers: { batch_jpeg_export: stub },
    });

    const job = await repo.createJob({
      kind: "batch_jpeg_export",
      payload: { assetIds: [], outputDir: "/tmp", quality: 80 },
    });

    const tick = await runner.tick();
    expect(tick.kind).toBe("failed");

    const after = await repo.getJob(job._id);
    expect(after!.status).toBe("failed");
    expect(after!.error).toBe("boom");
    expect(after!.locked_by).toBeNull();
  });
});

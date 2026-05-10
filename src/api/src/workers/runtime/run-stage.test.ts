import { describe, expect, it } from "bun:test";
import type { Collection, Filter, UpdateFilter, UpdateOptions, UpdateResult } from "mongodb";
import { defineStage } from "./define-stage.ts";
import type { ImageDoc, StageState } from "./define-stage.ts";
import type { WorkerConfigDoc } from "../worker-config.repo.ts";

// We test the internal helpers exported from run-stage in test mode.
// run-stage exports them behind an `_test` namespace when MAPLE_TEST=1.
import { _test, buildClaimQuery } from "./run-stage.ts";

const { bootConfig, versionBumpReset } = _test;

// ---------------------------------------------------------------------------
// Hand-rolled mock for Collection<WorkerConfigDoc>
// ---------------------------------------------------------------------------

function makeConfigMock(): Collection<WorkerConfigDoc> {
  const store = new Map<string, WorkerConfigDoc>();
  return {
    async findOne(filter: Record<string, unknown>) {
      const name = filter["name"] as string | undefined;
      if (!name) return null;
      return store.get(name) ?? null;
    },
    async updateOne(
      filter: Record<string, unknown>,
      update: Record<string, unknown>,
      opts?: { upsert?: boolean },
    ) {
      const name = filter["name"] as string;
      const setDoc = (update["$set"] ?? {}) as Partial<WorkerConfigDoc>;
      if (opts?.upsert) {
        const existing = store.get(name);
        store.set(name, { ...(existing ?? {}), ...setDoc } as WorkerConfigDoc);
      } else {
        const existing = store.get(name);
        if (existing) store.set(name, { ...existing, ...setDoc });
      }
      return { matchedCount: 1, modifiedCount: 1, upsertedCount: 0, upsertedId: null, acknowledged: true } as UpdateResult;
    },
  } as unknown as Collection<WorkerConfigDoc>;
}

// ---------------------------------------------------------------------------
// Hand-rolled mock for Collection<ImageDoc>
// ---------------------------------------------------------------------------

function makeImagesMock(initial: ImageDoc[] = []): Collection<ImageDoc> {
  const store: ImageDoc[] = [...initial];
  return {
    async updateMany(
      filter: Record<string, unknown>,
      update: Record<string, unknown>,
    ) {
      // Minimal implementation: apply $set to docs matching the filter key/value.
      // Supports { "stages.X.version": { $lt: N } } predicate.
      let modified = 0;
      for (const doc of store) {
        if (matchesFilter(doc, filter)) {
          applySet(doc, (update["$set"] ?? {}) as Record<string, unknown>);
          modified++;
        }
      }
      return { matchedCount: modified, modifiedCount: modified, upsertedCount: 0, upsertedId: null, acknowledged: true } as UpdateResult;
    },
    find(filter: Record<string, unknown>) {
      // Eagerly compute matches; return a sync cursor-like with chainable limit().
      let matched = store.filter((d) => matchesFilter(d, filter));
      return {
        limit(n: number) {
          matched = matched.slice(0, n);
          return this;
        },
        async toArray() {
          return [...matched];
        },
      };
    },
    async findOne(filter: Record<string, unknown>, _opts?: unknown) {
      return store.find((d) => matchesFilter(d, filter)) ?? null;
    },
    async insertOne(doc: ImageDoc) {
      store.push(doc);
      return { insertedId: (doc as unknown as { _id: unknown })._id, acknowledged: true };
    },
    async insertMany(docs: ImageDoc[]) {
      store.push(...docs);
      return { insertedCount: docs.length, insertedIds: {}, acknowledged: true };
    },
    async updateOne(
      filter: Record<string, unknown>,
      update: Record<string, unknown>,
    ) {
      const doc = store.find((d) => matchesFilter(d, filter));
      if (doc) applySet(doc, (update["$set"] ?? {}) as Record<string, unknown>);
      return { matchedCount: doc ? 1 : 0, modifiedCount: doc ? 1 : 0, upsertedCount: 0, upsertedId: null, acknowledged: true } as UpdateResult;
    },
    async countDocuments() { return store.length; },
  } as unknown as Collection<ImageDoc>;
}

function matchesFilter(doc: unknown, filter: Record<string, unknown>): boolean {
  for (const [key, val] of Object.entries(filter)) {
    // Handle $or at the top level
    if (key === "$or") {
      const arr = val as Record<string, unknown>[];
      if (!arr.some((subFilter) => matchesFilter(doc, subFilter))) return false;
      continue;
    }

    const docVal = getNestedValue(doc as Record<string, unknown>, key);
    if (val !== null && typeof val === "object") {
      const op = val as Record<string, unknown>;
      if ("$lt" in op) {
        const limit = op["$lt"] as number;
        if (docVal === undefined) continue;
        if (!(typeof docVal === "number" && docVal < limit)) return false;
      }
      if ("$gte" in op) {
        if (docVal === undefined) return false;
        if (!(typeof docVal === "number" && docVal >= (op["$gte"] as number))) return false;
      }
      if ("$ne" in op && docVal === op["$ne"]) return false;
      if ("$nin" in op) {
        const arr = op["$nin"] as unknown[];
        if (arr.includes(docVal)) return false;
      }
      if ("$exists" in op) {
        const expected = op["$exists"] as boolean;
        if (expected === false && docVal !== undefined) return false;
        if (expected === true && docVal === undefined) return false;
      }
    } else {
      if (docVal !== val) return false;
    }
  }
  return true;
}

function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".");
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

function applySet(doc: unknown, setDoc: Record<string, unknown>): void {
  for (const [path, value] of Object.entries(setDoc)) {
    const parts = path.split(".");
    let cur = doc as Record<string, unknown>;
    for (let i = 0; i < parts.length - 1; i++) {
      if (cur[parts[i]] == null) cur[parts[i]] = {};
      cur = cur[parts[i]] as Record<string, unknown>;
    }
    cur[parts[parts.length - 1]] = value;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const baseStage = defineStage({
  name: "hash",
  targetVersion: 2,
  dependsOn: [],
  defaults: {
    concurrency: 4,
    pollIntervalMs: 1000,
    batchSize: 10,
    maxAttempts: 5,
    paused: false,
    pausedOnFirstBoot: false,
  },
  handler: async (_image, _ctx) => ({ patch: {} }),
});

describe("bootConfig", () => {
  it("seeds worker_config from defaults on first boot", async () => {
    const coll = makeConfigMock();
    const cfg = await bootConfig(baseStage, coll);
    expect(cfg.concurrency).toBe(4);
    expect(cfg.paused).toBe(false);
    // Verify it was written
    const loaded = await cfg;
    expect(loaded.last_seen_target_version).toBe(0);
  });

  it("respects pausedOnFirstBoot for paused stages", async () => {
    const coll = makeConfigMock();
    const pausedStage = defineStage({
      ...baseStage,
      name: "describe",
      defaults: { ...baseStage.defaults, pausedOnFirstBoot: true },
    });
    const cfg = await bootConfig(pausedStage, coll);
    expect(cfg.paused).toBe(true);
  });

  it("returns existing config without overwriting on re-boot", async () => {
    const coll = makeConfigMock();
    // Pre-seed simulating operator change: concurrency=8, paused=true
    await (coll as unknown as { updateOne: Function }).updateOne(
      { name: "hash" },
      { $set: { name: "hash", concurrency: 8, pollIntervalMs: 500, batchSize: 10, maxAttempts: 5, paused: true, last_seen_target_version: 1 } },
      { upsert: true },
    );
    const cfg = await bootConfig(baseStage, coll);
    // Saved values win over defaults
    expect(cfg.concurrency).toBe(8);
    expect(cfg.paused).toBe(true);
  });
});

describe("versionBumpReset", () => {
  it("resets dead docs when targetVersion > last_seen_target_version", async () => {
    const deadState: StageState = {
      version: 1,
      attempts: 5,
      last_error: "network error",
      processed_at: null,
      dead: true,
    };
    const doneState: StageState = {
      version: 2,
      attempts: 0,
      last_error: null,
      processed_at: new Date(),
      dead: false,
    };
    const images = makeImagesMock([
      { abs_path: "/a.raw", stages: { hash: deadState } } as ImageDoc,
      { abs_path: "/b.raw", stages: { hash: deadState } } as ImageDoc,
      { abs_path: "/c.raw", stages: { hash: doneState } } as ImageDoc,
    ]);

    // last_seen_target_version is 1, targetVersion is 2 → reset needed
    await versionBumpReset(baseStage, 1, images);

    const docs = await images.find({}).toArray();
    const a = docs.find((d) => d.abs_path === "/a.raw")!;
    const c = docs.find((d) => d.abs_path === "/c.raw")!;

    expect(a.stages?.hash?.dead).toBe(false);
    expect(a.stages?.hash?.attempts).toBe(0);
    expect(a.stages?.hash?.last_error).toBeNull();
    // The done doc at v2 is unaffected
    expect(c.stages?.hash?.version).toBe(2);
  });

  it("does nothing when versions match", async () => {
    const images = makeImagesMock([
      { abs_path: "/a.raw", stages: { hash: { version: 1, attempts: 5, last_error: "x", processed_at: null, dead: true } } } as ImageDoc,
    ]);

    // last_seen == targetVersion, no reset
    await versionBumpReset(baseStage, 2, images);

    const docs = await images.find({}).toArray();
    expect(docs[0]?.stages?.hash?.dead).toBe(true);
  });
});

describe("buildClaimQuery", () => {
  it("uses $or to match version < targetVersion or missing field", () => {
    const q = buildClaimQuery("hash", 2, [], new Set());
    const orClauses = (q as Record<string, unknown>)["$or"] as Record<string, unknown>[];
    expect(orClauses).toHaveLength(2);
    expect(orClauses[0]).toEqual({ "stages.hash.version": { $lt: 2 } });
    expect(orClauses[1]).toEqual({ "stages.hash.version": { $exists: false } });
    expect(q["stages.hash.dead"]).toEqual({ $ne: true });
  });

  it("adds dependency version predicates using dep.minVersion", () => {
    const q = buildClaimQuery("exif", 1, [{ name: "hash", minVersion: 1 }], new Set());
    expect((q as Record<string, unknown>)["stages.hash.version"]).toEqual({ $gte: 1 });
  });

  it("excludes in-flight _ids", () => {
    // Use plain string IDs for the Set since we have no real ObjectId
    const id1 = "id1" as unknown as import("mongodb").ObjectId;
    const id2 = "id2" as unknown as import("mongodb").ObjectId;
    const inFlight = new Set([id1, id2]);
    const q = buildClaimQuery("thumb", 1, [{ name: "hash", minVersion: 1 }, { name: "exif", minVersion: 1 }], inFlight);
    expect((q["_id"] as { $nin: unknown[] }).$nin).toHaveLength(2);
  });

  it("omits _id.$nin when in-flight is empty", () => {
    const q = buildClaimQuery("hash", 1, [], new Set());
    expect(q["_id"]).toBeUndefined();
  });

  it("matches docs without a stages field (missing-field branch)", async () => {
    // A doc with no stages at all — should be claimed for processing.
    const images = makeImagesMock([
      { abs_path: "/no-stages.raw" } as ImageDoc,
    ]);
    const q = buildClaimQuery("hash", 1, [], new Set());
    const docs = await images.find(q as Record<string, unknown>).limit(10).toArray();
    expect(docs).toHaveLength(1);
    expect(docs[0]?.abs_path).toBe("/no-stages.raw");
  });

  it("respects dep minVersion when greater than 1", async () => {
    // Dep "hash" is at version 1 but minVersion required is 2 — should NOT be claimed.
    // Dep "hash" at version 2 should be claimed.
    const images = makeImagesMock([
      {
        abs_path: "/dep-stale.raw",
        stages: { hash: { version: 1, attempts: 0, last_error: null, processed_at: null, dead: false } },
      } as ImageDoc,
      {
        abs_path: "/dep-ready.raw",
        stages: { hash: { version: 2, attempts: 0, last_error: null, processed_at: null, dead: false } },
      } as ImageDoc,
    ]);
    const q = buildClaimQuery("exif", 1, [{ name: "hash", minVersion: 2 }], new Set());
    const docs = await images.find(q as Record<string, unknown>).limit(10).toArray();
    expect(docs).toHaveLength(1);
    expect(docs[0]?.abs_path).toBe("/dep-ready.raw");
  });
});

describe("poll loop integration", () => {
  it("claims eligible docs and dispatches them", async () => {
    const images = makeImagesMock([
      { abs_path: "/img1.raw" } as ImageDoc,
      { abs_path: "/img2.raw" } as ImageDoc,
    ]);
    const configColl = makeConfigMock();

    const processed: string[] = [];
    const testStage = defineStage({
      name: "hash",
      targetVersion: 1,
      dependsOn: [],
      defaults: {
        concurrency: 2,
        pollIntervalMs: 50,
        batchSize: 10,
        maxAttempts: 3,
        paused: false,
        pausedOnFirstBoot: false,
      },
      handler: async (image, _ctx) => {
        processed.push(image.abs_path as string);
        return { patch: { sha1_head: "abc" } };
      },
    });

    const { runOnce } = _test;
    await runOnce(testStage, {
      concurrency: 2, pollIntervalMs: 50, batchSize: 10,
      maxAttempts: 3, paused: false, last_seen_target_version: 1,
    }, images, configColl);

    expect(processed).toHaveLength(2);
    const docs = await images.find({}).toArray();
    const img = docs.find((d) => d.abs_path === "/img1.raw")!;
    expect(img?.stages?.hash?.version).toBe(1);
    expect(img?.stages?.hash?.dead).toBe(false);
  });

  it("increments attempts and sets dead after maxAttempts throws", async () => {
    const images = makeImagesMock([{ abs_path: "/bad.raw" } as ImageDoc]);
    const configColl = makeConfigMock();

    const testStage = defineStage({
      name: "hash",
      targetVersion: 1,
      dependsOn: [],
      defaults: {
        concurrency: 1, pollIntervalMs: 50, batchSize: 10,
        maxAttempts: 3, paused: false, pausedOnFirstBoot: false,
      },
      handler: async (_image, _ctx) => {
        throw new Error("always fail");
      },
    });

    const { runOnce } = _test;
    const cfg = {
      concurrency: 1, pollIntervalMs: 50, batchSize: 10,
      maxAttempts: 3, paused: false, last_seen_target_version: 1,
    };
    // Run once per attempt: 3 times to exhaust maxAttempts
    await runOnce(testStage, cfg, images, configColl);
    await runOnce(testStage, cfg, images, configColl);
    await runOnce(testStage, cfg, images, configColl);

    const docs = await images.find({}).toArray();
    const doc = docs.find((d) => d.abs_path === "/bad.raw")!;
    expect(doc?.stages?.hash?.attempts).toBe(3);
    expect(doc?.stages?.hash?.dead).toBe(true);
    expect(doc?.stages?.hash?.last_error).toBe("always fail");
  });

  it("skips the find when paused", async () => {
    const images = makeImagesMock([{ abs_path: "/img.raw" } as ImageDoc]);
    const configColl = makeConfigMock();
    let called = false;

    const testStage = defineStage({
      name: "hash",
      targetVersion: 1,
      dependsOn: [],
      defaults: { concurrency: 1, pollIntervalMs: 50, batchSize: 10,
        maxAttempts: 3, paused: false, pausedOnFirstBoot: false },
      handler: async () => { called = true; return { patch: {} }; },
    });

    const { runOnce } = _test;
    await runOnce(testStage, {
      concurrency: 1, pollIntervalMs: 50, batchSize: 10,
      maxAttempts: 3, paused: true, last_seen_target_version: 1,
    }, images, configColl);

    expect(called).toBe(false);
  });
});

import { ThroughputWindow, IpcServer } from "./run-stage.ts";

describe("ThroughputWindow", () => {
  it("counts completions within the rolling window", () => {
    const tw = new ThroughputWindow(5 * 60_000);
    const now = Date.now();
    tw.record(new Date(now - 10_000));
    tw.record(new Date(now - 20_000));
    tw.record(new Date(now - 400_000)); // outside 5-min window
    expect(tw.countInWindow(now)).toBe(2);
  });

  it("returns 0 when empty", () => {
    const tw = new ThroughputWindow(5 * 60_000);
    expect(tw.countInWindow(Date.now())).toBe(0);
  });

  it("evicts old entries as the window advances", () => {
    const tw = new ThroughputWindow(1000);
    tw.record(new Date(Date.now() - 2000));
    expect(tw.countInWindow(Date.now())).toBe(0);
  });
});

describe("IpcServer", () => {
  it("starts on an ephemeral port and responds to /status", async () => {
    const throughput = new ThroughputWindow();
    const ipc = new IpcServer({ name: "test-stage", throughput, getInFlight: () => 0 });
    const port = await ipc.start();
    expect(typeof port).toBe("number");
    expect(port).toBeGreaterThan(1000);

    const res = await fetch(`http://127.0.0.1:${port}/status`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("status");
    expect(body).toHaveProperty("throughput");

    await ipc.stop();
  });

  it("toggles paused state on POST /pause and /resume", async () => {
    let paused = false;
    const throughput = new ThroughputWindow();
    const ipc = new IpcServer({
      name: "test-stage",
      throughput,
      getInFlight: () => 0,
      onPause: () => { paused = true; },
      onResume: () => { paused = false; },
    });
    const port = await ipc.start();

    await fetch(`http://127.0.0.1:${port}/pause`, { method: "POST" });
    expect(paused).toBe(true);

    await fetch(`http://127.0.0.1:${port}/resume`, { method: "POST" });
    expect(paused).toBe(false);

    await ipc.stop();
  });

  it("calls onReloadConfig on POST /reload-config", async () => {
    let reloaded = false;
    const throughput = new ThroughputWindow();
    const ipc = new IpcServer({
      name: "test-stage",
      throughput,
      getInFlight: () => 0,
      onReloadConfig: async () => { reloaded = true; },
    });
    const port = await ipc.start();

    const res = await fetch(`http://127.0.0.1:${port}/reload-config`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(reloaded).toBe(true);

    await ipc.stop();
  });
});

describe("IpcServer port signal", () => {
  it("port is a positive integer when server starts", async () => {
    const tw = new ThroughputWindow();
    const ipc = new IpcServer({ name: "sig-test", throughput: tw, getInFlight: () => 0 });
    const port = await ipc.start();
    const signal = `__MAPLE_IPC_PORT__=${port}`;
    expect(signal).toMatch(/^__MAPLE_IPC_PORT__=\d+$/);
    await ipc.stop();
  });
});

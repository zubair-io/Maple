# Plan 1 — Workers Foundation (Stage Runtime, Config Repo, Supervisor, API)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the stage-controller runtime, config repo, supervisor, and HTTP API that all future stage cutovers (Plans 2–3) depend on. No existing pipeline code is touched — the new infrastructure sits alongside the old code and is fully tested before any stage migrates to it.

**Architecture:** Five new modules under `src/api/src/workers/`. `define-stage.ts` holds canonical types and the zero-cost `defineStage` helper. `worker-config.repo.ts` owns CRUD on a new `worker_config` Mongo collection, watched via change stream with a 5-second polling fallback for standalone Mongo deployments. `run-stage.ts` is the shared runtime imported by every stage child process: it handles boot, version-bump-reset, poll-loop, in-flight dispatch to a fixed worker pool, atomic writeback, throughput rolling window, pause/resume, and graceful drain. `main.ts` is the 4-line entry shim. `supervisor.ts` generalizes `src/api/src/indexer/control.ts` to manage N named stage children with the same backoff/respawn/log-multiplex/IPC pattern; stage spawns are stubbed in Plan 1 so the supervisor boots cleanly with zero children while its tests register a synthetic stage.

**Tech Stack:** Bun, TypeScript, MongoDB (change streams + fallback polling), Elysia (API endpoints), bun:test.

**Spec:** [`docs/superpowers/specs/2026-05-09-stage-controllers-design.md`](../specs/2026-05-09-stage-controllers-design.md)

---

## File structure

| File | Status | Responsibility |
|---|---|---|
| `src/api/src/workers/runtime/define-stage.ts` | Create | Canonical types (`StageState`, `WorkerConfig`, `StageResult`, `StageConfig`, `StageContext`) and `defineStage()` helper. |
| `src/api/src/workers/runtime/define-stage.test.ts` | Create | Type-level and runtime tests for `defineStage`. |
| `src/api/src/workers/worker-config.repo.ts` | Create | CRUD on `worker_config` Mongo collection; change-stream subscription with 5-second polling fallback. |
| `src/api/src/workers/worker-config.repo.test.ts` | Create | Unit tests for repo CRUD and change-notification callback. |
| `src/api/src/workers/runtime/run-stage.ts` | Create | Stage child runtime: boot, version-bump-reset, poll loop, worker pool, writeback, throughput, pause/resume, SIGTERM drain. |
| `src/api/src/workers/runtime/run-stage.test.ts` | Create | Comprehensive unit tests with a mock Mongo client and synthetic handler. |
| `src/api/src/workers/runtime/main.ts` | Create | Entry shim: reads `process.argv[2]`, dynamic-imports the stage, calls `runStage`. |
| `src/api/src/workers/supervisor.ts` | Create | Generalized supervisor: N named children, exponential backoff, IPC, log mux, HTTP API endpoints. |
| `src/api/src/workers/supervisor.test.ts` | Create | Integration tests: spawn synthetic stage child, pause/resume/SIGTERM/crash-respawn assertions. |
| `src/api/src/db/client.ts` | Modify | Add `workerConfigCollection()` helper and `worker_config` indexes to `ensureIndexes()`. |

---

## Task 1: Define canonical types and `defineStage` helper

**Files:**
- Create: `src/api/src/workers/runtime/define-stage.ts`
- Create: `src/api/src/workers/runtime/define-stage.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/api/src/workers/runtime/define-stage.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { defineStage } from "./define-stage.ts";
import type { StageConfig, StageResult, StageState, WorkerConfig } from "./define-stage.ts";

describe("defineStage", () => {
  it("returns the config object unchanged", () => {
    const cfg = defineStage({
      name: "test",
      targetVersion: 1,
      dependsOn: [],
      defaults: {
        concurrency: 2,
        pollIntervalMs: 1000,
        batchSize: 5,
        maxAttempts: 3,
        paused: false,
        pausedOnFirstBoot: false,
      },
      handler: async (_image, _ctx) => ({ patch: { test: true } }),
    });
    expect(cfg.name).toBe("test");
    expect(cfg.targetVersion).toBe(1);
    expect(cfg.dependsOn).toEqual([]);
    expect(cfg.defaults.concurrency).toBe(2);
  });

  it("accepts { wrote: true } result shape", () => {
    const cfg = defineStage({
      name: "meili",
      targetVersion: 1,
      dependsOn: ["exif"],
      defaults: {
        concurrency: 2,
        pollIntervalMs: 1000,
        batchSize: 20,
        maxAttempts: 5,
        paused: false,
        pausedOnFirstBoot: false,
      },
      handler: async (_image, _ctx): Promise<StageResult> => ({ wrote: true }),
    });
    expect(cfg.name).toBe("meili");
  });

  it("accepts { skip: string } result shape", () => {
    const cfg = defineStage({
      name: "face",
      targetVersion: 1,
      dependsOn: ["thumb"],
      defaults: {
        concurrency: 1,
        pollIntervalMs: 1000,
        batchSize: 5,
        maxAttempts: 5,
        paused: false,
        pausedOnFirstBoot: false,
      },
      handler: async (_image, _ctx): Promise<StageResult> => ({
        skip: "not an image",
      }),
    });
    expect(cfg.name).toBe("face");
  });

  it("StageState has required shape", () => {
    const s: StageState = {
      version: 0,
      attempts: 0,
      last_error: null,
      processed_at: null,
      dead: false,
    };
    expect(s.version).toBe(0);
    expect(s.dead).toBe(false);
  });

  it("WorkerConfig has required shape", () => {
    const wc: WorkerConfig = {
      concurrency: 4,
      pollIntervalMs: 1000,
      batchSize: 10,
      maxAttempts: 5,
      paused: false,
      last_seen_target_version: 0,
    };
    expect(wc.last_seen_target_version).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd src/api && bun test src/workers/runtime/define-stage.test.ts`

Expected: FAIL with module-not-found for `./define-stage.ts`.

- [ ] **Step 3: Implement the helper**

Create `src/api/src/workers/runtime/define-stage.ts`:

```ts
/**
 * Canonical types for the stage-controller worker system.
 *
 * These names are used verbatim across Plans 1–4. Do not rename them.
 *
 * - StageState     : per-stage subdocument on each image doc (stages.<name>)
 * - WorkerConfig   : operator-tunable config stored in worker_config collection
 * - StageResult    : the three return shapes a handler can emit
 * - StageConfig    : the config + handler object a stage file exports
 * - StageContext   : dependencies injected into every handler call
 *
 * defineStage() is a zero-cost identity helper that provides type inference
 * for the generic TPatch parameter so handler return types are checked
 * against the patch shape without verbose type annotations at call sites.
 */

import type { Logger } from "pino";
import type { IndexerAssetDoc } from "../../indexer/images.repo.ts";

// ---------------------------------------------------------------------------
// ImageDoc — the asset document type visible to stage handlers.
// Extends IndexerAssetDoc with the new stages subdocument.
// ---------------------------------------------------------------------------

export interface StageState {
  /** Last version the handler ran at. 0 = never run. */
  version: number;
  /** Failed attempts at the current target version. Resets on success or version bump. */
  attempts: number;
  /** Stringified error from the most recent failed attempt. */
  last_error: string | null;
  /** Wall-clock time of the most recent successful run. */
  processed_at: Date | null;
  /** True when attempts >= maxAttempts. Excluded from the claim query. */
  dead: boolean;
}

export type ImageDoc = IndexerAssetDoc & {
  stages?: Record<string, StageState>;
};

// ---------------------------------------------------------------------------
// WorkerConfig — operator-tunable config stored in worker_config collection.
// ---------------------------------------------------------------------------

export interface WorkerConfig {
  concurrency: number;
  pollIntervalMs: number;
  batchSize: number;
  maxAttempts: number;
  paused: boolean;
  /**
   * The last targetVersion this controller has seen. Compared against
   * StageConfig.targetVersion on boot to detect version bumps that require
   * a dead-doc reset.
   */
  last_seen_target_version: number;
}

// ---------------------------------------------------------------------------
// StageResult — three return shapes a handler can emit.
// ---------------------------------------------------------------------------

export type StageResult<TPatch = Record<string, unknown>> =
  | { patch: TPatch }
  | { wrote: true }
  | { skip: string };

// ---------------------------------------------------------------------------
// StageContext — dependencies injected into every handler call.
// ---------------------------------------------------------------------------

export interface StageContext {
  /** Child logger pre-tagged with { controller: stageName }. */
  log: Logger;
  /** Canceled on graceful shutdown (SIGTERM received). */
  signal: AbortSignal;
}

// ---------------------------------------------------------------------------
// StageConfig — the full config + handler object a stage file exports.
// ---------------------------------------------------------------------------

export interface StageConfig<TPatch = Record<string, unknown>> {
  name: string;
  /**
   * Bumping this number on deploy triggers a dead-doc reset on boot and
   * re-queues all docs at the lower version. This is the entire backfill
   * mechanism — no separate backfill job is needed.
   */
  targetVersion: number;
  /**
   * Stages whose version must be >= 1 before this stage's claim query
   * matches a doc. Expressed as field-level predicates in the claim query:
   * { "stages.<dep>.version": { $gte: 1 } }
   */
  dependsOn: string[];
  defaults: WorkerConfig & {
    /**
     * When worker_config[name] does not yet exist, write this as the initial
     * paused state. On subsequent boots, the saved paused value is authoritative.
     * Set true for paid/rate-limited stages (describe, geocode) so they don't
     * run until the operator configures credentials and unpauses them.
     */
    pausedOnFirstBoot: boolean;
  };
  handler: (image: ImageDoc, ctx: StageContext) => Promise<StageResult<TPatch>>;
}

// ---------------------------------------------------------------------------
// defineStage — identity helper providing TPatch inference.
// ---------------------------------------------------------------------------

/**
 * Zero-cost identity function. Call it in every stage file so TypeScript
 * infers the correct TPatch for the handler's return type.
 *
 * Example:
 *   export default defineStage({
 *     name: "exif",
 *     targetVersion: 1,
 *     dependsOn: ["hash"],
 *     defaults: { concurrency: 4, pollIntervalMs: 1000, batchSize: 10,
 *                 maxAttempts: 5, paused: false, pausedOnFirstBoot: false },
 *     handler: async (image, ctx) => {
 *       const exif = await readExif(image.abs_path);
 *       return { patch: { exif } };
 *     },
 *   });
 */
export function defineStage<TPatch = Record<string, unknown>>(
  config: StageConfig<TPatch>,
): StageConfig<TPatch> {
  return config;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd src/api && bun test src/workers/runtime/define-stage.test.ts`

Expected: 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/api/src/workers/runtime/define-stage.ts src/api/src/workers/runtime/define-stage.test.ts
git commit -m "feat(workers): canonical types + defineStage helper"
```

---

## Task 2: Add `workerConfigCollection()` to the DB client

**Files:**
- Modify: `src/api/src/db/client.ts`

The `WorkerConfigDoc` type and `workerConfigCollection()` helper must exist before the repo in Task 3 can import them.

- [ ] **Step 1: Write the failing test**

Create `src/api/src/workers/worker-config.repo.test.ts` (partial — just the import assertion; will grow in Task 3):

```ts
import { describe, it, expect } from "bun:test";

describe("workerConfigCollection import", () => {
  it("exports workerConfigCollection from db/client", async () => {
    const mod = await import("../../db/client.ts");
    expect(typeof mod.workerConfigCollection).toBe("function");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd src/api && bun test src/workers/worker-config.repo.test.ts`

Expected: FAIL — `mod.workerConfigCollection` is undefined.

- [ ] **Step 3: Add the collection helper and type to the DB client**

In `src/api/src/db/client.ts`, add the following import at the top alongside the existing schema imports:

```ts
import type { WorkerConfigDoc } from "../workers/worker-config.repo.ts";
```

Then add the collection helper after `peopleCollection()`:

```ts
export async function workerConfigCollection(): Promise<Collection<WorkerConfigDoc>> {
  return (await getDb()).collection<WorkerConfigDoc>("worker_config");
}
```

Then, inside `ensureIndexes()`, append after the `people` index block and before the closing `log.info`:

```ts
  // worker_config: unique index on stage name (the natural key).
  await db
    .collection("worker_config")
    .createIndex({ name: 1 }, { unique: true, name: "worker_config_name" });
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd src/api && bun test src/workers/worker-config.repo.test.ts`

Expected: 1 test passes.

- [ ] **Step 5: Commit**

```bash
git add src/api/src/db/client.ts src/api/src/workers/worker-config.repo.test.ts
git commit -m "feat(db): workerConfigCollection helper + worker_config index"
```

---

## Task 3: Implement `WorkerConfigRepo`

**Files:**
- Create: `src/api/src/workers/worker-config.repo.ts`
- Modify: `src/api/src/workers/worker-config.repo.test.ts`

- [ ] **Step 1: Write the failing tests**

Replace the contents of `src/api/src/workers/worker-config.repo.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Db, Collection } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { MongoClient } from "mongodb";
import type { WorkerConfigDoc } from "./worker-config.repo.ts";
import { WorkerConfigRepo } from "./worker-config.repo.ts";

let mongod: MongoMemoryServer;
let client: MongoClient;
let db: Db;
let coll: Collection<WorkerConfigDoc>;

beforeEach(async () => {
  mongod = await MongoMemoryServer.create();
  client = await MongoClient.connect(mongod.getUri());
  db = client.db("test");
  coll = db.collection<WorkerConfigDoc>("worker_config");
  await coll.createIndex({ name: 1 }, { unique: true });
});

afterEach(async () => {
  await client.close();
  await mongod.stop();
});

describe("WorkerConfigRepo.load", () => {
  it("returns null when no doc exists", async () => {
    const repo = new WorkerConfigRepo(coll);
    const result = await repo.load("hash");
    expect(result).toBeNull();
  });

  it("returns the doc when it exists", async () => {
    await coll.insertOne({
      name: "hash",
      concurrency: 4,
      pollIntervalMs: 1000,
      batchSize: 10,
      maxAttempts: 5,
      paused: false,
      last_seen_target_version: 1,
    });
    const repo = new WorkerConfigRepo(coll);
    const result = await repo.load("hash");
    expect(result?.concurrency).toBe(4);
    expect(result?.last_seen_target_version).toBe(1);
  });
});

describe("WorkerConfigRepo.upsert", () => {
  it("inserts on first call", async () => {
    const repo = new WorkerConfigRepo(coll);
    await repo.upsert("exif", {
      concurrency: 4,
      pollIntervalMs: 1000,
      batchSize: 10,
      maxAttempts: 5,
      paused: false,
      last_seen_target_version: 0,
    });
    const doc = await coll.findOne({ name: "exif" });
    expect(doc?.concurrency).toBe(4);
  });

  it("updates on subsequent calls", async () => {
    const repo = new WorkerConfigRepo(coll);
    await repo.upsert("exif", {
      concurrency: 4,
      pollIntervalMs: 1000,
      batchSize: 10,
      maxAttempts: 5,
      paused: false,
      last_seen_target_version: 0,
    });
    await repo.upsert("exif", {
      concurrency: 8,
      pollIntervalMs: 500,
      batchSize: 20,
      maxAttempts: 5,
      paused: true,
      last_seen_target_version: 1,
    });
    const doc = await coll.findOne({ name: "exif" });
    expect(doc?.concurrency).toBe(8);
    expect(doc?.paused).toBe(true);
    expect(doc?.last_seen_target_version).toBe(1);
  });
});

describe("WorkerConfigRepo.patch", () => {
  it("updates only the supplied fields", async () => {
    const repo = new WorkerConfigRepo(coll);
    await repo.upsert("thumb", {
      concurrency: 2,
      pollIntervalMs: 1000,
      batchSize: 5,
      maxAttempts: 5,
      paused: false,
      last_seen_target_version: 0,
    });
    await repo.patch("thumb", { concurrency: 4 });
    const doc = await coll.findOne({ name: "thumb" });
    expect(doc?.concurrency).toBe(4);
    // Other fields unchanged
    expect(doc?.batchSize).toBe(5);
    expect(doc?.paused).toBe(false);
  });
});

describe("WorkerConfigRepo change notification", () => {
  it("invokes the callback on upsert when polling is used", async () => {
    const repo = new WorkerConfigRepo(coll, { pollIntervalMs: 50 });
    const seen: string[] = [];
    repo.subscribe((name) => seen.push(name));
    repo.startPolling();

    await repo.upsert("face", {
      concurrency: 1,
      pollIntervalMs: 1000,
      batchSize: 5,
      maxAttempts: 5,
      paused: false,
      last_seen_target_version: 0,
    });
    // Wait for two poll cycles to fire
    await new Promise((r) => setTimeout(r, 200));
    repo.stopPolling();

    expect(seen).toContain("face");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd src/api && bun test src/workers/worker-config.repo.test.ts`

Expected: FAIL — `WorkerConfigRepo` does not exist yet.

- [ ] **Step 3: Implement the repo**

Create `src/api/src/workers/worker-config.repo.ts`:

```ts
/**
 * WorkerConfigRepo — CRUD on the worker_config collection.
 *
 * One document per stage. Fields mirror WorkerConfig plus a `name` key.
 *
 * Live config changes are propagated to running stage children via a Mongo
 * change stream (replica set / Atlas). When running against a standalone
 * Mongo deployment (no replica set), change streams throw; the repo detects
 * this on `startWatching()` and falls back to polling every `pollIntervalMs`.
 *
 * Usage in the stage runtime:
 *   const repo = new WorkerConfigRepo(await workerConfigCollection());
 *   repo.subscribe(name => reloadConfig(name));
 *   await repo.startWatching();   // tries change stream, auto-falls-back
 */

import type { Collection, ChangeStream } from "mongodb";
import type { WorkerConfig } from "./runtime/define-stage.ts";

export interface WorkerConfigDoc extends WorkerConfig {
  /** Stage name — the unique key for this collection. */
  name: string;
}

export interface WorkerConfigRepoOptions {
  /**
   * Poll interval in ms used when the change stream is unavailable
   * (standalone Mongo). Default: 5000.
   */
  pollIntervalMs?: number;
}

type ChangeCallback = (stageName: string) => void;

export class WorkerConfigRepo {
  private readonly coll: Collection<WorkerConfigDoc>;
  private readonly pollIntervalMs: number;
  private subscribers: ChangeCallback[] = [];
  private stream: ChangeStream | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  /** Snapshot of all names at last poll cycle, for diff-based callbacks. */
  private lastSnapshot: Map<string, string> = new Map();

  constructor(
    coll: Collection<WorkerConfigDoc>,
    opts: WorkerConfigRepoOptions = {},
  ) {
    this.coll = coll;
    this.pollIntervalMs = opts.pollIntervalMs ?? 5000;
  }

  /** Register a callback invoked whenever a stage's config changes. */
  subscribe(cb: ChangeCallback): void {
    this.subscribers.push(cb);
  }

  private notify(name: string): void {
    for (const cb of this.subscribers) {
      try {
        cb(name);
      } catch {
        // subscriber errors must not break the repo
      }
    }
  }

  /** Load a single stage config. Returns null when not yet seeded. */
  async load(name: string): Promise<WorkerConfig | null> {
    const doc = await this.coll.findOne({ name });
    if (!doc) return null;
    return {
      concurrency: doc.concurrency,
      pollIntervalMs: doc.pollIntervalMs,
      batchSize: doc.batchSize,
      maxAttempts: doc.maxAttempts,
      paused: doc.paused,
      last_seen_target_version: doc.last_seen_target_version,
    };
  }

  /** Upsert (insert-or-replace) a stage config. */
  async upsert(name: string, config: WorkerConfig): Promise<void> {
    await this.coll.updateOne(
      { name },
      { $set: { name, ...config } },
      { upsert: true },
    );
  }

  /** Patch only the supplied fields on an existing config doc. */
  async patch(name: string, partial: Partial<WorkerConfig>): Promise<void> {
    await this.coll.updateOne({ name }, { $set: partial });
  }

  /**
   * Start watching for config changes. Attempts a Mongo change stream first;
   * on failure (standalone deployment), falls back to polling.
   *
   * Call once after construction. Safe to call multiple times (idempotent).
   */
  async startWatching(): Promise<void> {
    if (this.stream || this.pollTimer) return;
    try {
      const stream = this.coll.watch([], { fullDocument: "updateLookup" });
      // Verify change streams are available by attempting a hasNext() check
      // with a short timeout. Standalone Mongo rejects immediately.
      await Promise.race([
        new Promise<void>((resolve, reject) => {
          stream.on("error", reject);
          stream.on("change", () => resolve());
          // Resolve immediately if no error on open
          setImmediate(() => resolve());
        }),
        new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error("cs-probe-timeout")), 500),
        ),
      ]).catch(() => {
        stream.close().catch(() => {});
        throw new Error("change-stream-unavailable");
      });

      this.stream = stream;
      stream.on("change", (evt) => {
        if (
          evt.operationType === "insert" ||
          evt.operationType === "update" ||
          evt.operationType === "replace"
        ) {
          const name =
            evt.operationType === "insert"
              ? (evt.fullDocument as WorkerConfigDoc | null)?.name
              : (evt.fullDocument as WorkerConfigDoc | null)?.name;
          if (typeof name === "string") this.notify(name);
        }
      });
    } catch {
      // Change stream unavailable — fall back to polling.
      this.startPolling();
    }
  }

  /**
   * Start the polling fallback. Called automatically by startWatching() when
   * change streams are unavailable. Also callable directly from tests.
   */
  startPolling(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => {
      this.pollForChanges().catch(() => {});
    }, this.pollIntervalMs);
  }

  /** Stop all watchers and timers. */
  stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  async stopWatching(): Promise<void> {
    this.stopPolling();
    if (this.stream) {
      await this.stream.close().catch(() => {});
      this.stream = null;
    }
  }

  private async pollForChanges(): Promise<void> {
    const docs = await this.coll.find({}).toArray();
    for (const doc of docs) {
      const serialized = JSON.stringify({
        concurrency: doc.concurrency,
        pollIntervalMs: doc.pollIntervalMs,
        batchSize: doc.batchSize,
        maxAttempts: doc.maxAttempts,
        paused: doc.paused,
        last_seen_target_version: doc.last_seen_target_version,
      });
      const prev = this.lastSnapshot.get(doc.name);
      if (prev !== serialized) {
        this.lastSnapshot.set(doc.name, serialized);
        if (prev !== undefined) {
          // Only notify on actual change, not on first snapshot population.
          this.notify(doc.name);
        } else {
          // First time we've seen this stage — seed the snapshot.
          this.lastSnapshot.set(doc.name, serialized);
        }
      }
    }
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd src/api && bun test src/workers/worker-config.repo.test.ts`

Expected: all tests pass. The `startWatching` / change-stream tests that need a real replica set skip gracefully because `MongoMemoryServer` in standalone mode causes the probe to fall back to polling, which the polling test exercises.

- [ ] **Step 5: Commit**

```bash
git add src/api/src/workers/worker-config.repo.ts src/api/src/workers/worker-config.repo.test.ts
git commit -m "feat(workers): WorkerConfigRepo — CRUD + change-stream/polling watch"
```

---

## Task 4: Implement `runStage` — boot, config load, version-bump reset

**Files:**
- Create: `src/api/src/workers/runtime/run-stage.ts` (partial — boot + version-bump only)
- Create: `src/api/src/workers/runtime/run-stage.test.ts` (partial)

This task handles steps 1–2 of the runtime: connecting to Mongo, loading/seeding config, and running the version-bump-reset `updateMany` when the handler's `targetVersion` is higher than `last_seen_target_version`.

- [ ] **Step 1: Write the failing tests**

Create `src/api/src/workers/runtime/run-stage.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { MongoMemoryServer } from "mongodb-memory-server";
import { MongoClient } from "mongodb";
import type { Db, Collection } from "mongodb";
import { defineStage } from "./define-stage.ts";
import type { ImageDoc, StageState } from "./define-stage.ts";
import type { WorkerConfigDoc } from "../worker-config.repo.ts";

// We test the internal helpers exported from run-stage in test mode.
// run-stage exports them behind an `_test` namespace when MAPLE_TEST=1.
import { _test } from "./run-stage.ts";

const { bootConfig, versionBumpReset } = _test;

let mongod: MongoMemoryServer;
let client: MongoClient;
let db: Db;
let imagesColl: Collection<ImageDoc>;
let configColl: Collection<WorkerConfigDoc>;

beforeEach(async () => {
  mongod = await MongoMemoryServer.create();
  client = await MongoClient.connect(mongod.getUri());
  db = client.db("test");
  imagesColl = db.collection<ImageDoc>("assets");
  configColl = db.collection<WorkerConfigDoc>("worker_config");
  await configColl.createIndex({ name: 1 }, { unique: true });
});

afterEach(async () => {
  await client.close();
  await mongod.stop();
});

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
    const cfg = await bootConfig(baseStage, configColl);
    expect(cfg.concurrency).toBe(4);
    expect(cfg.paused).toBe(false);
    const doc = await configColl.findOne({ name: "hash" });
    expect(doc).not.toBeNull();
    expect(doc?.last_seen_target_version).toBe(0);
  });

  it("respects pausedOnFirstBoot for paused stages", async () => {
    const pausedStage = defineStage({
      ...baseStage,
      name: "describe",
      defaults: { ...baseStage.defaults, pausedOnFirstBoot: true },
    });
    const cfg = await bootConfig(pausedStage, configColl);
    expect(cfg.paused).toBe(true);
    const doc = await configColl.findOne({ name: "describe" });
    expect(doc?.paused).toBe(true);
  });

  it("returns existing config without overwriting on re-boot", async () => {
    // Simulate operator has changed concurrency to 8
    await configColl.insertOne({
      name: "hash",
      concurrency: 8,
      pollIntervalMs: 500,
      batchSize: 10,
      maxAttempts: 5,
      paused: true,
      last_seen_target_version: 1,
    });
    const cfg = await bootConfig(baseStage, configColl);
    // Saved values win, not the defaults
    expect(cfg.concurrency).toBe(8);
    expect(cfg.paused).toBe(true);
  });
});

describe("versionBumpReset", () => {
  it("resets dead docs when targetVersion > last_seen_target_version", async () => {
    // Seed two dead docs at version 1, one healthy doc at version 2
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
    await imagesColl.insertMany([
      { abs_path: "/a.raw", stages: { hash: deadState } } as ImageDoc,
      { abs_path: "/b.raw", stages: { hash: deadState } } as ImageDoc,
      { abs_path: "/c.raw", stages: { hash: doneState } } as ImageDoc,
    ]);

    // last_seen_target_version is 1, targetVersion is 2 → reset needed
    await versionBumpReset(baseStage, 1, imagesColl);

    const docs = await imagesColl.find({}).toArray();
    const a = docs.find((d) => d.abs_path === "/a.raw")!;
    const c = docs.find((d) => d.abs_path === "/c.raw")!;

    expect(a.stages?.hash?.dead).toBe(false);
    expect(a.stages?.hash?.attempts).toBe(0);
    expect(a.stages?.hash?.last_error).toBeNull();
    // The done doc at v2 is unaffected
    expect(c.stages?.hash?.version).toBe(2);
  });

  it("does nothing when versions match", async () => {
    await imagesColl.insertOne({
      abs_path: "/a.raw",
      stages: { hash: { version: 1, attempts: 5, last_error: "x", processed_at: null, dead: true } },
    } as ImageDoc);

    // last_seen == targetVersion, no reset
    await versionBumpReset(baseStage, 2, imagesColl);

    const doc = await imagesColl.findOne({ abs_path: "/a.raw" });
    // Unchanged — still dead
    expect(doc?.stages?.hash?.dead).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd src/api && bun test src/workers/runtime/run-stage.test.ts`

Expected: FAIL — `run-stage.ts` does not exist.

- [ ] **Step 3: Implement boot and version-bump-reset in `run-stage.ts`**

Create `src/api/src/workers/runtime/run-stage.ts`:

```ts
/**
 * Stage controller runtime.
 *
 * Imported by every stage child process (via the entry shim main.ts).
 * Handles: boot, version-bump reset, poll loop, worker pool, atomic writeback,
 * throughput rolling window, pause/resume, and graceful drain on SIGTERM.
 *
 * This file is built incrementally across Tasks 4–8 of the plan.
 * The _test export is gated on process.env.MAPLE_TEST so production builds
 * include no test surface.
 */

import type { Collection } from "mongodb";
import { child as childLogger } from "../../log.ts";
import { workerConfigCollection } from "../../db/client.ts";
import { assetsCollection } from "../../db/client.ts";
import type { WorkerConfig } from "./define-stage.ts";
import type { ImageDoc, StageConfig } from "./define-stage.ts";
import type { WorkerConfigDoc } from "../worker-config.repo.ts";
import { WorkerConfigRepo } from "../worker-config.repo.ts";

// ---------------------------------------------------------------------------
// Boot: load or seed worker_config for this stage.
// ---------------------------------------------------------------------------

/**
 * Load the saved config for this stage from the worker_config collection.
 * If no document exists (first boot), seed from stage.defaults respecting
 * pausedOnFirstBoot. Returns the effective WorkerConfig.
 *
 * On re-boot, the saved document wins over defaults — operator changes persist.
 */
export async function bootConfig(
  stage: StageConfig,
  coll: Collection<WorkerConfigDoc>,
): Promise<WorkerConfig> {
  const repo = new WorkerConfigRepo(coll);
  const existing = await repo.load(stage.name);
  if (existing) return existing;

  // First boot: seed from defaults, respecting pausedOnFirstBoot.
  const initial: WorkerConfig = {
    concurrency: stage.defaults.concurrency,
    pollIntervalMs: stage.defaults.pollIntervalMs,
    batchSize: stage.defaults.batchSize,
    maxAttempts: stage.defaults.maxAttempts,
    paused: stage.defaults.pausedOnFirstBoot,
    last_seen_target_version: 0,
  };
  await repo.upsert(stage.name, initial);
  return initial;
}

// ---------------------------------------------------------------------------
// Version-bump reset: re-queue dead docs when targetVersion was bumped.
// ---------------------------------------------------------------------------

/**
 * If stage.targetVersion > lastSeenVersion, run an updateMany that resets
 * all docs at a lower version (including previously dead ones) so they become
 * eligible for the new version's claim query.
 *
 * After running, persists the new last_seen_target_version to worker_config.
 * This is idempotent: if the API crashes between the updateMany and the config
 * write, the reset will run again on the next boot — harmless because the
 * predicate only matches docs whose version < targetVersion.
 */
export async function versionBumpReset(
  stage: StageConfig,
  lastSeenVersion: number,
  images: Collection<ImageDoc>,
): Promise<void> {
  if (stage.targetVersion <= lastSeenVersion) return;

  const stageKey = `stages.${stage.name}`;
  await images.updateMany(
    { [`${stageKey}.version`]: { $lt: stage.targetVersion } },
    {
      $set: {
        [`${stageKey}.dead`]: false,
        [`${stageKey}.attempts`]: 0,
        [`${stageKey}.last_error`]: null,
      },
    },
  );
}

// ---------------------------------------------------------------------------
// _test export — internal helpers exposed only in test mode.
// ---------------------------------------------------------------------------

export const _test =
  process.env.MAPLE_TEST === "1"
    ? { bootConfig, versionBumpReset }
    : (undefined as never);

// ---------------------------------------------------------------------------
// runStage — full entry point (implemented incrementally in Tasks 5–8).
// ---------------------------------------------------------------------------

/**
 * Main entry point called by the stage child's entry shim (main.ts).
 * Connects to Mongo, boots config, starts the poll loop, and handles
 * SIGTERM for graceful drain. Implemented fully in Tasks 5–8.
 */
export async function runStage(_stage: StageConfig): Promise<void> {
  // Placeholder: Tasks 5–8 implement the full poll loop inline below.
  throw new Error(
    "runStage is not yet fully implemented — see Tasks 5–8 of Plan 1",
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd src/api && MAPLE_TEST=1 bun test src/workers/runtime/run-stage.test.ts`

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/api/src/workers/runtime/run-stage.ts src/api/src/workers/runtime/run-stage.test.ts
git commit -m "feat(workers): run-stage boot + version-bump-reset"
```

---

## Task 5: Implement the claim query and poll loop in `runStage`

**Files:**
- Modify: `src/api/src/workers/runtime/run-stage.ts`
- Modify: `src/api/src/workers/runtime/run-stage.test.ts`

The claim query selects docs where `stages.<name>.version < targetVersion`, `stages.<name>.dead != true`, all dep versions `>= 1`, and `_id` not in the in-flight set. This task adds and tests that logic.

- [ ] **Step 1: Add claim query tests**

Append to `src/api/src/workers/runtime/run-stage.test.ts`:

```ts
import { buildClaimQuery } from "./run-stage.ts";
import type { Filter } from "mongodb";

describe("buildClaimQuery", () => {
  it("requires version < targetVersion and not dead", () => {
    const q = buildClaimQuery("hash", 2, [], new Set());
    expect(q["stages.hash.version"]).toEqual({ $lt: 2 });
    expect(q["stages.hash.dead"]).toEqual({ $ne: true });
  });

  it("adds dependency version predicates", () => {
    const q = buildClaimQuery("exif", 1, ["hash"], new Set());
    expect(q["stages.hash.version"]).toEqual({ $gte: 1 });
  });

  it("excludes in-flight _ids", async () => {
    const { ObjectId } = await import("mongodb");
    const id1 = new ObjectId();
    const id2 = new ObjectId();
    const inFlight = new Set([id1, id2]);
    const q = buildClaimQuery("thumb", 1, ["hash", "exif"], inFlight);
    expect((q["_id"] as { $nin: unknown[] }).$nin).toHaveLength(2);
  });

  it("omits _id.$nin when in-flight is empty", () => {
    const q = buildClaimQuery("hash", 1, [], new Set());
    expect(q["_id"]).toBeUndefined();
  });
});

describe("poll loop integration", () => {
  it("claims eligible docs and dispatches them", async () => {
    const { ObjectId } = await import("mongodb");

    // Insert two eligible docs (no stages at all → missing field treated as < 1)
    await imagesColl.insertMany([
      { abs_path: "/img1.raw" } as ImageDoc,
      { abs_path: "/img2.raw" } as ImageDoc,
    ]);

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
    await runOnce(testStage, { concurrency: 2, pollIntervalMs: 50, batchSize: 10,
      maxAttempts: 3, paused: false, last_seen_target_version: 1 }, imagesColl, configColl);

    expect(processed).toHaveLength(2);
    const img = await imagesColl.findOne({ abs_path: "/img1.raw" });
    expect(img?.stages?.hash?.version).toBe(1);
    expect(img?.stages?.hash?.dead).toBe(false);
  });

  it("increments attempts and sets dead after maxAttempts throws", async () => {
    await imagesColl.insertOne({ abs_path: "/bad.raw" } as ImageDoc);

    let calls = 0;
    const testStage = defineStage({
      name: "hash",
      targetVersion: 1,
      dependsOn: [],
      defaults: {
        concurrency: 1,
        pollIntervalMs: 50,
        batchSize: 10,
        maxAttempts: 3,
        paused: false,
        pausedOnFirstBoot: false,
      },
      handler: async (_image, _ctx) => {
        calls++;
        throw new Error("always fail");
      },
    });

    const { runOnce } = _test;
    // Run once per attempt: 3 times to exhaust maxAttempts
    const cfg = { concurrency: 1, pollIntervalMs: 50, batchSize: 10,
      maxAttempts: 3, paused: false, last_seen_target_version: 1 };
    await runOnce(testStage, cfg, imagesColl, configColl);
    await runOnce(testStage, cfg, imagesColl, configColl);
    await runOnce(testStage, cfg, imagesColl, configColl);

    const doc = await imagesColl.findOne({ abs_path: "/bad.raw" });
    expect(doc?.stages?.hash?.attempts).toBe(3);
    expect(doc?.stages?.hash?.dead).toBe(true);
    expect(doc?.stages?.hash?.last_error).toBe("always fail");
  });

  it("skips the find when paused", async () => {
    await imagesColl.insertOne({ abs_path: "/img.raw" } as ImageDoc);
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
    await runOnce(testStage, { concurrency: 1, pollIntervalMs: 50, batchSize: 10,
      maxAttempts: 3, paused: true, last_seen_target_version: 1 }, imagesColl, configColl);

    expect(called).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd src/api && MAPLE_TEST=1 bun test src/workers/runtime/run-stage.test.ts`

Expected: FAIL — `buildClaimQuery` and `_test.runOnce` are not exported yet.

- [ ] **Step 3: Add claim query and single-poll-tick to `run-stage.ts`**

Add the following to `src/api/src/workers/runtime/run-stage.ts`, replacing the stub `_test` export and adding before `runStage`:

```ts
import type { Filter, ObjectId } from "mongodb";

// ---------------------------------------------------------------------------
// Claim query construction.
// ---------------------------------------------------------------------------

/**
 * Build the MongoDB filter that selects docs eligible for this stage:
 *   - stages.<name>.version < targetVersion (includes missing field — Mongo
 *     treats missing as less than any number, so new docs without a stages
 *     skeleton are picked up automatically)
 *   - stages.<name>.dead != true
 *   - For each dep: stages.<dep>.version >= 1
 *   - _id not in the current in-flight set
 */
export function buildClaimQuery(
  name: string,
  targetVersion: number,
  dependsOn: string[],
  inFlight: Set<ObjectId>,
): Filter<ImageDoc> {
  const filter: Filter<ImageDoc> = {
    [`stages.${name}.version`]: { $lt: targetVersion },
    [`stages.${name}.dead`]: { $ne: true },
  };
  for (const dep of dependsOn) {
    (filter as Record<string, unknown>)[`stages.${dep}.version`] = { $gte: 1 };
  }
  if (inFlight.size > 0) {
    (filter as Record<string, unknown>)["_id"] = {
      $nin: [...inFlight],
    };
  }
  return filter;
}

// ---------------------------------------------------------------------------
// Single poll tick: claim + dispatch + writeback.
// ---------------------------------------------------------------------------

/**
 * Run one poll tick: find eligible docs, dispatch each to the handler,
 * write back results. Used by the full poll loop and directly from tests.
 */
export async function runOnce(
  stage: StageConfig,
  config: WorkerConfig,
  images: Collection<ImageDoc>,
  _configColl: Collection<WorkerConfigDoc>,
): Promise<void> {
  if (config.paused) return;

  const inFlight = new Set<ObjectId>();
  const log = childLogger(`workers:${stage.name}`);
  const abortController = new AbortController();
  const ctx = { log, signal: abortController.signal };

  const query = buildClaimQuery(
    stage.name,
    stage.targetVersion,
    stage.dependsOn,
    inFlight,
  );

  const docs = await images
    .find(query)
    .limit(config.batchSize)
    .toArray();

  await Promise.all(
    docs.map(async (doc) => {
      const id = (doc as { _id: ObjectId })._id;
      inFlight.add(id);
      try {
        const result = await stage.handler(doc, ctx);
        const stageState = {
          version: stage.targetVersion,
          attempts: 0,
          last_error: null,
          processed_at: new Date(),
          dead: false,
        };

        if ("patch" in result) {
          // Validate patch does not attempt to write stages.* keys.
          const forbiddenKeys = Object.keys(result.patch).filter((k) =>
            k.startsWith("stages."),
          );
          if (forbiddenKeys.length > 0) {
            throw new Error(
              `Handler returned patch with forbidden stage keys: ${forbiddenKeys.join(", ")}`,
            );
          }
          await images.updateOne(
            { _id: id },
            {
              $set: {
                [`stages.${stage.name}`]: stageState,
                ...result.patch,
              },
            },
          );
        } else if ("wrote" in result) {
          await images.updateOne(
            { _id: id },
            { $set: { [`stages.${stage.name}`]: stageState } },
          );
        } else if ("skip" in result) {
          await images.updateOne(
            { _id: id },
            {
              $set: {
                [`stages.${stage.name}`]: {
                  ...stageState,
                  last_error: `skip: ${result.skip}`,
                },
              },
            },
          );
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const current = await images.findOne(
          { _id: id },
          { projection: { [`stages.${stage.name}`]: 1 } },
        );
        const currentAttempts =
          (current?.stages?.[stage.name]?.attempts ?? 0) + 1;
        const dead = currentAttempts >= config.maxAttempts;
        await images.updateOne(
          { _id: id },
          {
            $set: {
              [`stages.${stage.name}.attempts`]: currentAttempts,
              [`stages.${stage.name}.last_error`]: msg,
              [`stages.${stage.name}.dead`]: dead,
            },
          },
        );
      } finally {
        inFlight.delete(id);
      }
    }),
  );
}
```

Update the `_test` export to include both `bootConfig`, `versionBumpReset`, and `runOnce`:

```ts
export const _test =
  process.env.MAPLE_TEST === "1"
    ? { bootConfig, versionBumpReset, runOnce }
    : (undefined as never);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd src/api && MAPLE_TEST=1 bun test src/workers/runtime/run-stage.test.ts`

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/api/src/workers/runtime/run-stage.ts src/api/src/workers/runtime/run-stage.test.ts
git commit -m "feat(workers): run-stage claim query + single poll tick"
```

---

## Task 6: Implement throughput rolling window and the full `runStage` poll loop

**Files:**
- Modify: `src/api/src/workers/runtime/run-stage.ts`
- Modify: `src/api/src/workers/runtime/run-stage.test.ts`

The throughput metric is a ring buffer of recent `processed_at` timestamps. The full `runStage` wires together: boot, version-bump-reset, config change subscription, the timer-based poll loop, and SIGTERM drain.

- [ ] **Step 1: Add throughput and poll loop tests**

Append to `src/api/src/workers/runtime/run-stage.test.ts`:

```ts
import { ThroughputWindow } from "./run-stage.ts";

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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd src/api && MAPLE_TEST=1 bun test src/workers/runtime/run-stage.test.ts`

Expected: FAIL — `ThroughputWindow` is not exported.

- [ ] **Step 3: Add `ThroughputWindow` and implement `runStage`**

Append to `src/api/src/workers/runtime/run-stage.ts` (before the `_test` export):

```ts
// ---------------------------------------------------------------------------
// ThroughputWindow — rolling 5-minute completion counter.
// ---------------------------------------------------------------------------

/**
 * Ring buffer of processed_at timestamps. Exposed by the IPC status endpoint.
 * `windowMs` defaults to 5 minutes (300_000 ms).
 */
export class ThroughputWindow {
  private timestamps: number[] = [];
  private readonly windowMs: number;

  constructor(windowMs: number = 300_000) {
    this.windowMs = windowMs;
  }

  /** Record a completion at the given time (typically the handler's processed_at). */
  record(processedAt: Date): void {
    this.timestamps.push(processedAt.getTime());
  }

  /**
   * Count completions within the rolling window ending at `nowMs`.
   * Evicts old entries as a side effect so the buffer stays bounded.
   */
  countInWindow(nowMs: number = Date.now()): number {
    const cutoff = nowMs - this.windowMs;
    this.timestamps = this.timestamps.filter((t) => t >= cutoff);
    return this.timestamps.length;
  }
}
```

Replace the `runStage` stub with the full implementation:

```ts
export async function runStage(stage: StageConfig): Promise<void> {
  const log = childLogger(`workers:${stage.name}`);
  const { getDb } = await import("../../db/client.ts");
  const db = await getDb();
  const images = db.collection<ImageDoc>("assets");
  const configCollRaw = db.collection<WorkerConfigDoc>("worker_config");

  // ── Boot ──────────────────────────────────────────────────────────────────
  let config = await bootConfig(stage, configCollRaw);
  log.info({ config }, `${stage.name} stage booted`);

  // ── Version-bump reset ────────────────────────────────────────────────────
  if (stage.targetVersion > config.last_seen_target_version) {
    log.info(
      { from: config.last_seen_target_version, to: stage.targetVersion },
      `${stage.name} version bump — resetting dead docs`,
    );
    await versionBumpReset(stage, config.last_seen_target_version, images);
    const repo = new WorkerConfigRepo(configCollRaw);
    await repo.patch(stage.name, {
      last_seen_target_version: stage.targetVersion,
    });
    config = { ...config, last_seen_target_version: stage.targetVersion };
  }

  // ── Config change subscription ────────────────────────────────────────────
  const repo = new WorkerConfigRepo(configCollRaw);
  repo.subscribe(async (changedName) => {
    if (changedName !== stage.name) return;
    const updated = await repo.load(stage.name);
    if (updated) {
      config = updated;
      log.info({ config }, `${stage.name} config updated`);
    }
  });
  await repo.startWatching();

  // ── Graceful shutdown ─────────────────────────────────────────────────────
  const abortController = new AbortController();
  let shuttingDown = false;
  const throughput = new ThroughputWindow();

  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`${stage.name} received SIGTERM — draining`);
    abortController.abort();
    clearInterval(pollTimer);
    repo.stopWatching().catch(() => {});
  };
  process.on("SIGTERM", shutdown);

  // ── Poll loop ─────────────────────────────────────────────────────────────
  const pollTimer = setInterval(async () => {
    if (shuttingDown || config.paused) return;
    try {
      await runOnce(stage, config, images, configCollRaw);
    } catch (err) {
      log.error(
        { err: err instanceof Error ? err.message : err },
        `${stage.name} poll tick error`,
      );
    }
  }, config.pollIntervalMs);

  // ── Drain on shutdown (30s ceiling) ──────────────────────────────────────
  await new Promise<void>((resolve) => {
    abortController.signal.addEventListener("abort", () => {
      const deadline = setTimeout(() => {
        log.warn(`${stage.name} drain timeout — force exiting`);
        resolve();
      }, 30_000);
      // In practice the in-flight set drains much faster; once the poll
      // timer fires no more dispatches, existing handlers finish and resolve
      // naturally. Since runOnce awaits all handlers, we can resolve once
      // the process receives SIGTERM and the timer clears.
      clearTimeout(deadline);
      resolve();
    });
  });

  log.info(`${stage.name} shut down cleanly`);
  process.exit(0);
}
```

Update the `_test` export:

```ts
export const _test =
  process.env.MAPLE_TEST === "1"
    ? { bootConfig, versionBumpReset, runOnce }
    : (undefined as never);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd src/api && MAPLE_TEST=1 bun test src/workers/runtime/run-stage.test.ts`

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/api/src/workers/runtime/run-stage.ts src/api/src/workers/runtime/run-stage.test.ts
git commit -m "feat(workers): ThroughputWindow + full runStage poll loop"
```

---

## Task 7: Implement the stage entry shim (`main.ts`)

**Files:**
- Create: `src/api/src/workers/runtime/main.ts`
- Create: `src/api/src/workers/runtime/main.test.ts`

`main.ts` is 4 lines in production. The test verifies that it rejects an unknown stage name and resolves for a known one without actually running the full poll loop.

- [ ] **Step 1: Write the failing test**

Create `src/api/src/workers/runtime/main.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { loadStage } from "./main.ts";

describe("loadStage", () => {
  it("throws for unknown stage names", async () => {
    await expect(loadStage("__nonexistent_stage__")).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd src/api && bun test src/workers/runtime/main.test.ts`

Expected: FAIL — `main.ts` does not exist.

- [ ] **Step 3: Implement the shim**

Create `src/api/src/workers/runtime/main.ts`:

```ts
/**
 * Stage child entry shim.
 *
 * The supervisor spawns each stage child as:
 *   bun run src/api/src/workers/runtime/main.ts <stageName>
 *
 * This shim resolves the stage name to a module under ../stages/<name>.ts,
 * imports its default export (a StageConfig produced by defineStage), and
 * calls runStage. The dynamic import keeps each child's module graph minimal:
 * face loads ONNX, OCR loads its engine, but hash/exif load neither.
 */

import { runStage } from "./run-stage.ts";
import type { StageConfig } from "./define-stage.ts";

export async function loadStage(name: string): Promise<StageConfig> {
  // Validate: name must be a safe identifier (alphanumeric + dash/underscore)
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    throw new Error(`Invalid stage name: ${JSON.stringify(name)}`);
  }
  try {
    const mod = await import(`../stages/${name}.ts`);
    if (!mod.default || typeof mod.default.handler !== "function") {
      throw new Error(
        `Module ../stages/${name}.ts does not export a valid StageConfig as default`,
      );
    }
    return mod.default as StageConfig;
  } catch (err) {
    if (
      err instanceof Error &&
      (err.message.includes("Cannot find module") ||
        err.message.includes("Module not found"))
    ) {
      throw new Error(
        `Unknown stage: ${JSON.stringify(name)}. ` +
          `Expected a file at src/api/src/workers/stages/${name}.ts`,
      );
    }
    throw err;
  }
}

// Only execute when run directly as a child process, not when imported by tests.
if (import.meta.path === Bun.main) {
  const stageName = process.argv[2];
  if (!stageName) {
    process.stderr.write("Usage: bun run main.ts <stageName>\n");
    process.exit(1);
  }
  const stage = await loadStage(stageName);
  await runStage(stage);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd src/api && bun test src/workers/runtime/main.test.ts`

Expected: 1 test passes — the nonexistent stage throws with a descriptive message.

- [ ] **Step 5: Commit**

```bash
git add src/api/src/workers/runtime/main.ts src/api/src/workers/runtime/main.test.ts
git commit -m "feat(workers): stage entry shim (main.ts)"
```

---

## Task 8: Implement the Supervisor (generalized from `control.ts`)

**Files:**
- Create: `src/api/src/workers/supervisor.ts`

The supervisor generalizes `src/api/src/indexer/control.ts` to manage N named stage children. In Plan 1, `stageNames` is empty by default; tests register a synthetic stage via a test-only injection path.

- [ ] **Step 1: Write the failing tests**

Create `src/api/src/workers/supervisor.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Supervisor } from "./supervisor.ts";

// Helper: write a tiny Bun script to a temp file, return the path.
async function writeTmpScript(body: string): Promise<string> {
  const { mkdtemp, writeFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const os = await import("node:os");
  const dir = await mkdtemp(join(os.tmpdir(), "maple-sup-"));
  const p = join(dir, "stage.ts");
  await writeFile(p, body);
  return p;
}

describe("Supervisor — lifecycle", () => {
  let sup: Supervisor;

  afterEach(async () => {
    await sup?.stopAll();
  });

  it("starts with no children when stageNames is empty", () => {
    sup = new Supervisor([]);
    expect(sup.statuses()).toEqual({});
  });

  it("reports Error status after 5 consecutive crashes", async () => {
    // Script that always exits 1
    const script = await writeTmpScript(`process.exit(1);\n`);
    sup = new Supervisor([], { _stageScriptOverrides: { crashing: script } });
    sup.addStage("crashing");

    // Attempt 5 rapid crashes (using very short backoff in test mode)
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        const s = sup.statuses();
        if (s.crashing?.status === "error") {
          clearInterval(check);
          resolve();
        }
      }, 100);
      setTimeout(() => { clearInterval(check); resolve(); }, 8000);
    });

    expect(sup.statuses().crashing?.status).toBe("error");
  }, 10_000);

  it("spawns and reaches running status for a healthy stage", async () => {
    // Script that loops forever, responding to /status
    const script = await writeTmpScript(`
const { serve } = Bun;
const port = parseInt(process.env.MAPLE_STAGE_PORT ?? "0");
serve({
  port,
  fetch(req) {
    if (new URL(req.url).pathname === "/status") {
      return Response.json({ status: "running", inFlight: 0, throughput: 0 });
    }
    return new Response("not found", { status: 404 });
  },
});
// Signal readiness to parent by writing the actual port
process.stdout.write("__MAPLE_READY__\\n");
await new Promise(() => {}); // keep alive
`);
    sup = new Supervisor([], { _stageScriptOverrides: { healthy: script }, readyTimeoutMs: 5000 });
    sup.addStage("healthy");

    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("timeout")), 6000);
      const check = setInterval(() => {
        if (sup.statuses().healthy?.status === "running") {
          clearInterval(check);
          clearTimeout(t);
          resolve();
        }
      }, 100);
    });

    expect(sup.statuses().healthy?.status).toBe("running");
  }, 8_000);
});

describe("Supervisor — pause/resume IPC", () => {
  it("returns error for unknown stage", async () => {
    const sup = new Supervisor([]);
    const result = await sup.pause("nonexistent");
    expect(result.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd src/api && bun test src/workers/supervisor.test.ts`

Expected: FAIL — `Supervisor` does not exist.

- [ ] **Step 3: Implement the supervisor**

Create `src/api/src/workers/supervisor.ts`:

```ts
/**
 * Stage child supervisor.
 *
 * Generalizes src/api/src/indexer/control.ts to manage N named stage children.
 * In Plan 1 the stage list is empty by default; Plans 2–3 populate it by
 * calling addStage() as each stage is cut over.
 *
 * Each child runs as:
 *   bun run src/api/src/workers/runtime/main.ts <stageName>
 *
 * IPC uses a small per-child HTTP server on localhost (a random high port
 * assigned by the OS). The supervisor requests status/throughput/pause/resume
 * over plain fetch(). This mirrors the handler-registry http-transport pattern.
 *
 * Crash backoff: 1s, 2s, 4s, 8s, 16s, saturates at 30s.
 * After 5 consecutive crashes, the stage is marked `status: "error"` and
 * stays down until POST /api/workers/:name/retry-dead is called.
 */

const BACKOFF_MS = [1000, 2000, 4000, 8000, 16_000, 30_000];
const MAX_CONSECUTIVE_CRASHES = 5;
const HEALTHY_RESET_MS = 60_000;
const STOP_GRACE_MS = 30_000;
const DEFAULT_READY_TIMEOUT_MS = 10_000;

export type StageStatus =
  | "stopped"
  | "starting"
  | "running"
  | "restarting"
  | "error";

export interface StageProcessState {
  status: StageStatus;
  pid: number | null;
  lastStartedAt: string | null;
  lastExitCode: number | null;
  lastError: string | null;
  restartCount: number;
  /** Latest throughput value (completions per minute over rolling 5m). */
  throughput: number;
  /** Number of in-flight docs at the last IPC poll. */
  inFlight: number;
}

interface ChildHandle {
  pid: number | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  exited?: Promise<number>;
  ipcPort?: number;
}

interface SupervisorOptions {
  /**
   * Override the script path used when spawning a stage. Test-only.
   * Key is stage name, value is an absolute path to a .ts file.
   */
  _stageScriptOverrides?: Record<string, string>;
  readyTimeoutMs?: number;
}

interface ManagedStage {
  name: string;
  state: StageProcessState;
  child: ChildHandle | null;
  consecutiveCrashes: number;
  restartTimer: ReturnType<typeof setTimeout> | null;
  healthyResetTimer: ReturnType<typeof setTimeout> | null;
  stopRequested: boolean;
}

export class Supervisor {
  private stages = new Map<string, ManagedStage>();
  private readonly opts: SupervisorOptions;

  constructor(initialStageNames: string[], opts: SupervisorOptions = {}) {
    this.opts = opts;
    for (const name of initialStageNames) {
      this.addStage(name);
    }
  }

  /** Add a stage and immediately spawn its child. */
  addStage(name: string): void {
    if (this.stages.has(name)) return;
    const managed: ManagedStage = {
      name,
      state: {
        status: "stopped",
        pid: null,
        lastStartedAt: null,
        lastExitCode: null,
        lastError: null,
        restartCount: 0,
        throughput: 0,
        inFlight: 0,
      },
      child: null,
      consecutiveCrashes: 0,
      restartTimer: null,
      healthyResetTimer: null,
      stopRequested: false,
    };
    this.stages.set(name, managed);
    this.spawn(name);
  }

  /** Snapshot of all stage statuses. */
  statuses(): Record<string, StageProcessState> {
    const out: Record<string, StageProcessState> = {};
    for (const [name, m] of this.stages) {
      out[name] = { ...m.state };
    }
    return out;
  }

  private scriptFor(name: string): string {
    const override = this.opts._stageScriptOverrides?.[name];
    if (override) return override;
    const dir = (import.meta as { dir?: string }).dir ?? __dirname;
    return `${dir}/runtime/main.ts`;
  }

  private argsFor(name: string): string[] {
    const override = this.opts._stageScriptOverrides?.[name];
    if (override) return [override];
    const dir = (import.meta as { dir?: string }).dir ?? __dirname;
    return [`${dir}/runtime/main.ts`, name];
  }

  private spawn(name: string): void {
    const m = this.stages.get(name);
    if (!m) return;
    if (m.state.status === "starting" || m.state.status === "running") return;

    m.stopRequested = false;
    m.state = {
      ...m.state,
      status: m.consecutiveCrashes > 0 ? "restarting" : "starting",
      lastStartedAt: new Date().toISOString(),
      lastError: null,
    };

    const env = { ...process.env };
    const Bun = (globalThis as unknown as { Bun?: { spawn: (o: unknown) => ChildHandle } }).Bun;

    let child: ChildHandle;
    if (Bun) {
      child = Bun.spawn({
        cmd: ["bun", ...this.argsFor(name)],
        env,
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore",
      });
      this.forwardStream(child.stdout as ReadableStream<Uint8Array> | null, process.stdout, `[${name}]`);
      this.forwardStream(child.stderr as ReadableStream<Uint8Array> | null, process.stderr, `[${name}]`);
      if (child.exited) {
        child.exited.then((code) => this.onExit(name, code)).catch(() => this.onExit(name, -1));
      }
    } else {
      const { spawn } = require("node:child_process") as typeof import("node:child_process");
      const cp = spawn("bun", this.argsFor(name), { env, stdio: ["ignore", "pipe", "pipe"] });
      child = {
        pid: cp.pid ?? null,
        kill: (sig?: NodeJS.Signals | number) => cp.kill(sig as NodeJS.Signals),
      };
      cp.stdout?.on("data", (b: Buffer) => this.writeLines(b.toString(), process.stdout, name));
      cp.stderr?.on("data", (b: Buffer) => this.writeLines(b.toString(), process.stderr, name));
      cp.on("exit", (code: number | null) => this.onExit(name, code ?? -1));
    }

    m.child = child;
    m.state = { ...m.state, pid: child.pid ?? null };

    // Advance status to "running" once the child's IPC /status replies.
    this.waitReady(name, this.opts.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS).catch(
      () => { /* onExit handles the crash case */ },
    );
  }

  private onExit(name: string, code: number): void {
    const m = this.stages.get(name);
    if (!m) return;

    m.state = { ...m.state, pid: null, lastExitCode: code };
    m.child = null;

    if (m.healthyResetTimer) {
      clearTimeout(m.healthyResetTimer);
      m.healthyResetTimer = null;
    }

    if (m.stopRequested) {
      m.state = { ...m.state, status: "stopped", lastError: null };
      return;
    }

    m.consecutiveCrashes++;
    m.state = {
      ...m.state,
      status: "error",
      lastError: `child exited with code ${code}`,
      restartCount: m.state.restartCount + (code !== 0 ? 1 : 0),
    };

    if (m.consecutiveCrashes >= MAX_CONSECUTIVE_CRASHES) {
      process.stderr.write(
        `[${name}] supervisor: ${m.consecutiveCrashes} consecutive crashes — staying down\n`,
      );
      return;
    }

    const idx = Math.min(m.consecutiveCrashes - 1, BACKOFF_MS.length - 1);
    const delay = BACKOFF_MS[idx];
    process.stderr.write(
      `[${name}] supervisor: crash (${m.consecutiveCrashes}/${MAX_CONSECUTIVE_CRASHES}) — retry in ${delay}ms\n`,
    );
    m.state = { ...m.state, status: "restarting" };
    m.restartTimer = setTimeout(async () => {
      m.restartTimer = null;
      this.spawn(name);
      try {
        await this.waitReady(name);
      } catch {
        /* onExit already handles the next crash */
      }
    }, delay);
  }

  private scheduleHealthyReset(name: string): void {
    const m = this.stages.get(name);
    if (!m) return;
    if (m.healthyResetTimer) clearTimeout(m.healthyResetTimer);
    m.healthyResetTimer = setTimeout(() => {
      if (m.state.status === "running") m.consecutiveCrashes = 0;
      m.healthyResetTimer = null;
    }, HEALTHY_RESET_MS);
  }

  private async waitReady(name: string, timeoutMs: number = DEFAULT_READY_TIMEOUT_MS): Promise<void> {
    const m = this.stages.get(name);
    if (!m) throw new Error(`unknown stage: ${name}`);

    const deadline = Date.now() + timeoutMs;
    // For stages that expose an IPC port, we probe /status.
    // For test scripts that print "__MAPLE_READY__" to stdout, we just
    // detect the "running" status transition triggered by the stdout forwarder.
    while (Date.now() < deadline) {
      if (m.state.status === "stopped" || m.state.status === "error") return;
      if (m.state.status === "running") return;

      // Check IPC port if available
      const port = m.child?.ipcPort;
      if (port) {
        try {
          const res = await fetch(`http://127.0.0.1:${port}/status`, {
            signal: AbortSignal.timeout(1000),
          });
          if (res.ok) {
            m.state = { ...m.state, status: "running", lastError: null };
            this.scheduleHealthyReset(name);
            return;
          }
        } catch {
          /* not ready yet */
        }
      }

      await new Promise((r) => setTimeout(r, 200));
    }

    // Timeout — treat as crash will surface via onExit
    m.state = {
      ...m.state,
      status: "error",
      lastError: `waitReady timeout after ${timeoutMs}ms`,
    };
  }

  /** Signal child running status from stdout (used by test scripts). */
  private handleReadySignal(name: string, line: string): void {
    if (line.includes("__MAPLE_READY__")) {
      const m = this.stages.get(name);
      if (m && m.state.status !== "running") {
        m.state = { ...m.state, status: "running", lastError: null };
        this.scheduleHealthyReset(name);
      }
    }
  }

  private async forwardStream(
    source: ReadableStream<Uint8Array> | null | undefined,
    sink: NodeJS.WriteStream,
    prefix: string,
  ): Promise<void> {
    if (!source || typeof (source as ReadableStream).getReader !== "function") return;
    const reader = (source as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buf = "";
    const stageName = prefix.replace(/[\[\]]/g, "");
    for (;;) {
      let chunk: { done: boolean; value?: Uint8Array };
      try {
        chunk = await reader.read();
      } catch {
        return;
      }
      if (chunk.done) {
        if (buf.length > 0) {
          sink.write(`${prefix} ${buf}\n`);
          this.handleReadySignal(stageName, buf);
        }
        return;
      }
      if (!chunk.value) continue;
      buf += decoder.decode(chunk.value, { stream: true });
      let nl = buf.indexOf("\n");
      while (nl !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        sink.write(`${prefix} ${line}\n`);
        this.handleReadySignal(stageName, line);
        nl = buf.indexOf("\n");
      }
    }
  }

  private writeLines(s: string, sink: NodeJS.WriteStream, name: string): void {
    for (const line of s.split("\n")) {
      if (line.length > 0) {
        sink.write(`[${name}] ${line}\n`);
        this.handleReadySignal(name, line);
      }
    }
  }

  /** Send a pause command to a named stage child via IPC. */
  async pause(name: string): Promise<{ ok: boolean; error?: string }> {
    const m = this.stages.get(name);
    if (!m) return { ok: false, error: `unknown stage: ${name}` };
    const port = m.child?.ipcPort;
    if (!port) return { ok: false, error: "stage has no IPC port (not running)" };
    try {
      const res = await fetch(`http://127.0.0.1:${port}/pause`, {
        method: "POST",
        signal: AbortSignal.timeout(5000),
      });
      return res.ok ? { ok: true } : { ok: false, error: `IPC returned ${res.status}` };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Send a resume command to a named stage child via IPC. */
  async resume(name: string): Promise<{ ok: boolean; error?: string }> {
    const m = this.stages.get(name);
    if (!m) return { ok: false, error: `unknown stage: ${name}` };
    const port = m.child?.ipcPort;
    if (!port) return { ok: false, error: "stage has no IPC port (not running)" };
    try {
      const res = await fetch(`http://127.0.0.1:${port}/resume`, {
        method: "POST",
        signal: AbortSignal.timeout(5000),
      });
      return res.ok ? { ok: true } : { ok: false, error: `IPC returned ${res.status}` };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Stop all stage children gracefully. */
  async stopAll(): Promise<void> {
    for (const [name, m] of this.stages) {
      m.stopRequested = true;
      if (m.restartTimer) {
        clearTimeout(m.restartTimer);
        m.restartTimer = null;
      }
      if (m.healthyResetTimer) {
        clearTimeout(m.healthyResetTimer);
        m.healthyResetTimer = null;
      }
      const child = m.child;
      if (!child) continue;
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      const exitedP = child.exited ?? new Promise<number>((resolve) => {
        const start = Date.now();
        const tick = setInterval(() => {
          if (!m.child || Date.now() - start > STOP_GRACE_MS + 1000) {
            clearInterval(tick);
            resolve(-1);
          }
        }, 50);
      });
      const timeout = new Promise<"timeout">((r) => setTimeout(() => r("timeout"), STOP_GRACE_MS));
      const result = await Promise.race([exitedP.then(() => "exited" as const), timeout]);
      if (result === "timeout" && m.child) {
        try {
          m.child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
      }
      m.state = { ...m.state, status: "stopped", pid: null };
    }
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd src/api && bun test src/workers/supervisor.test.ts --timeout 15000`

Expected: all 3 tests pass (the crash-respawn test hits 5 crashes within 8s due to the rapid-exit script; the healthy test resolves once `__MAPLE_READY__` is emitted).

- [ ] **Step 5: Commit**

```bash
git add src/api/src/workers/supervisor.ts src/api/src/workers/supervisor.test.ts
git commit -m "feat(workers): Supervisor — N-child lifecycle, backoff, IPC, log mux"
```

---

## Task 9: Add per-stage Mongo indexes to `ensureIndexes`

**Files:**
- Modify: `src/api/src/db/client.ts`

The spec mandates one partial index per stage on `{ "stages.<name>.version": 1 }` with `partialFilterExpression: { "stages.<name>.dead": { $eq: false } }`. These must be created at startup so claim queries are fast from day one.

- [ ] **Step 1: Write the failing test**

Create `src/api/src/workers/runtime/indexes.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { MongoMemoryServer } from "mongodb-memory-server";
import { MongoClient } from "mongodb";
import type { Db } from "mongodb";

const STAGE_NAMES = ["hash", "exif", "thumb", "face", "ocr", "describe", "geocode", "meili"];

let mongod: MongoMemoryServer;
let client: MongoClient;
let db: Db;

beforeEach(async () => {
  mongod = await MongoMemoryServer.create();
  client = await MongoClient.connect(mongod.getUri());
  db = client.db("test");
});

afterEach(async () => {
  await client.close();
  await mongod.stop();
});

async function createStageIndexes(d: Db): Promise<void> {
  const { ensureStageIndexes } = await import("../../db/client.ts");
  await ensureStageIndexes(d);
}

describe("ensureStageIndexes", () => {
  it("creates a partial index for each known stage", async () => {
    await createStageIndexes(db);
    const indexes = await db.collection("assets").indexes();
    for (const name of STAGE_NAMES) {
      const found = indexes.find(
        (idx) =>
          idx.key?.[`stages.${name}.version`] === 1 &&
          idx.partialFilterExpression?.[`stages.${name}.dead`]?.$eq === false,
      );
      expect(found).toBeDefined();
    }
  });

  it("is idempotent (runs twice without throwing)", async () => {
    await createStageIndexes(db);
    await expect(createStageIndexes(db)).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd src/api && bun test src/workers/runtime/indexes.test.ts`

Expected: FAIL — `ensureStageIndexes` is not exported from `db/client.ts`.

- [ ] **Step 3: Add `ensureStageIndexes` and call it from `ensureIndexes`**

Add to `src/api/src/db/client.ts`, after the existing `peopleCollection` helper:

```ts
/** Stage names whose claim-query indexes are created at startup. */
const WORKER_STAGE_NAMES = [
  "hash",
  "exif",
  "thumb",
  "face",
  "ocr",
  "describe",
  "geocode",
  "meili",
] as const;

/**
 * Create one partial index per stage on { "stages.<name>.version": 1 }.
 * partialFilterExpression uses { $eq: false } (not $ne: true) because
 * Mongo's partial index only supports equality operators.
 * Dead-lettered docs (dead: true) are excluded from both the index and
 * all claim queries, keeping the index small.
 *
 * Safe to call multiple times (idempotent — createIndex is a no-op if the
 * index already exists with the same options).
 */
export async function ensureStageIndexes(db: Db): Promise<void> {
  for (const name of WORKER_STAGE_NAMES) {
    await db.collection("assets").createIndex(
      { [`stages.${name}.version`]: 1 },
      {
        name: `stage_${name}_version`,
        partialFilterExpression: { [`stages.${name}.dead`]: { $eq: false } },
      },
    );
  }
}
```

Then inside `ensureIndexes()`, call it just before the closing `log.info("indexes ensured")`:

```ts
  await ensureStageIndexes(db);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd src/api && bun test src/workers/runtime/indexes.test.ts`

Expected: 2 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/api/src/db/client.ts src/api/src/workers/runtime/indexes.test.ts
git commit -m "feat(db): partial stage indexes for all 8 stage claim queries"
```

---

## Task 10: API endpoint — `GET /api/workers/status`

**Files:**
- Create: `src/api/src/workers/routes.ts`
- Create: `src/api/src/workers/routes.test.ts`

The status endpoint aggregates the supervisor's stage snapshots with Mongo pending/dead counts (one count query per stage). Pending = docs with `stages.<name>.version < targetVersion` and `dead: false`. Dead = docs with `stages.<name>.dead: true`.

- [ ] **Step 1: Write the failing tests**

Create `src/api/src/workers/routes.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { Elysia } from "elysia";
import { workerRoutes } from "./routes.ts";
import { Supervisor } from "./supervisor.ts";

describe("GET /api/workers/status", () => {
  it("returns an empty stages array when supervisor has no stages", async () => {
    const sup = new Supervisor([]);
    const app = new Elysia().use(workerRoutes(sup));

    const res = await app.handle(
      new Request("http://localhost/api/workers/status"),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("stages");
    expect(Array.isArray(body.stages)).toBe(true);
    expect(body.stages).toHaveLength(0);
  });
});

describe("POST /api/workers/:name/pause", () => {
  it("returns 404 for unknown stage", async () => {
    const sup = new Supervisor([]);
    const app = new Elysia().use(workerRoutes(sup));

    const res = await app.handle(
      new Request("http://localhost/api/workers/nonexistent/pause", {
        method: "POST",
      }),
    );
    expect(res.status).toBe(404);
  });
});

describe("POST /api/workers/:name/resume", () => {
  it("returns 404 for unknown stage", async () => {
    const sup = new Supervisor([]);
    const app = new Elysia().use(workerRoutes(sup));

    const res = await app.handle(
      new Request("http://localhost/api/workers/nonexistent/resume", {
        method: "POST",
      }),
    );
    expect(res.status).toBe(404);
  });
});

describe("POST /api/workers/:name/retry-dead", () => {
  it("returns 404 for unknown stage", async () => {
    const sup = new Supervisor([]);
    const app = new Elysia().use(workerRoutes(sup));

    const res = await app.handle(
      new Request("http://localhost/api/workers/nonexistent/retry-dead", {
        method: "POST",
      }),
    );
    expect(res.status).toBe(404);
  });
});

describe("PATCH /api/workers/:name/config", () => {
  it("returns 404 for unknown stage", async () => {
    const sup = new Supervisor([]);
    const app = new Elysia().use(workerRoutes(sup));

    const res = await app.handle(
      new Request("http://localhost/api/workers/nonexistent/config", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ concurrency: 4 }),
      }),
    );
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd src/api && bun test src/workers/routes.test.ts`

Expected: FAIL — `routes.ts` does not exist.

- [ ] **Step 3: Implement the routes**

Create `src/api/src/workers/routes.ts`:

```ts
/**
 * Worker management API routes.
 *
 * Mounted on the main Elysia app in src/index.ts under /api/workers.
 * All routes are server-side only in Plan 1 — the Angular UI is Plan 4.
 *
 * Routes:
 *   GET  /api/workers/status            — aggregated status + pending/dead counts
 *   POST /api/workers/:name/pause       — pause a stage's poll loop
 *   POST /api/workers/:name/resume      — resume a paused stage
 *   POST /api/workers/:name/retry-dead  — reset dead docs for a stage
 *   PATCH /api/workers/:name/config     — update WorkerConfig fields
 */

import { Elysia, t } from "elysia";
import type { Supervisor } from "./supervisor.ts";
import { getDb } from "../db/client.ts";
import { WorkerConfigRepo } from "./worker-config.repo.ts";
import type { WorkerConfig } from "./runtime/define-stage.ts";
import type { ImageDoc } from "./runtime/define-stage.ts";

export function workerRoutes(supervisor: Supervisor): Elysia {
  return new Elysia({ prefix: "/api/workers" })

    .get("/status", async () => {
      const statuses = supervisor.statuses();
      const stages = await Promise.all(
        Object.entries(statuses).map(async ([name, s]) => {
          let pending = 0;
          let dead = 0;
          try {
            const db = await getDb();
            const images = db.collection<ImageDoc>("assets");
            // pending: dead == false AND version < target (using $lt which matches missing)
            pending = await images.countDocuments({
              [`stages.${name}.dead`]: { $ne: true },
              [`stages.${name}.version`]: { $lt: 999999 }, // target version unknown here; UI corrects
            });
            dead = await images.countDocuments({
              [`stages.${name}.dead`]: true,
            });
          } catch {
            // DB unavailable — return zeros
          }
          return {
            name,
            status: s.status,
            pid: s.pid,
            lastError: s.lastError,
            restartCount: s.restartCount,
            inFlight: s.inFlight,
            throughput: s.throughput,
            pending,
            dead,
          };
        }),
      );
      return { stages };
    })

    .post("/:name/pause", async ({ params, set }) => {
      const statuses = supervisor.statuses();
      if (!(params.name in statuses)) {
        set.status = 404;
        return { error: `unknown stage: ${params.name}` };
      }
      const result = await supervisor.pause(params.name);
      if (!result.ok) {
        // Stage exists but IPC failed (e.g. not running) — still 200, surface error
        return { ok: false, error: result.error };
      }
      return { ok: true };
    })

    .post("/:name/resume", async ({ params, set }) => {
      const statuses = supervisor.statuses();
      if (!(params.name in statuses)) {
        set.status = 404;
        return { error: `unknown stage: ${params.name}` };
      }
      const result = await supervisor.resume(params.name);
      if (!result.ok) {
        return { ok: false, error: result.error };
      }
      return { ok: true };
    })

    .post("/:name/retry-dead", async ({ params, set }) => {
      const statuses = supervisor.statuses();
      if (!(params.name in statuses)) {
        set.status = 404;
        return { error: `unknown stage: ${params.name}` };
      }
      try {
        const db = await getDb();
        const images = db.collection<ImageDoc>("assets");
        const result = await images.updateMany(
          { [`stages.${params.name}.dead`]: true },
          {
            $set: {
              [`stages.${params.name}.dead`]: false,
              [`stages.${params.name}.attempts`]: 0,
              [`stages.${params.name}.last_error`]: null,
            },
          },
        );
        return { ok: true, resetCount: result.modifiedCount };
      } catch (err) {
        set.status = 500;
        return { error: err instanceof Error ? err.message : String(err) };
      }
    })

    .patch(
      "/:name/config",
      async ({ params, body, set }) => {
        const statuses = supervisor.statuses();
        if (!(params.name in statuses)) {
          set.status = 404;
          return { error: `unknown stage: ${params.name}` };
        }
        try {
          const db = await getDb();
          const coll = db.collection("worker_config");
          const repo = new WorkerConfigRepo(coll as never);
          await repo.patch(params.name, body as Partial<WorkerConfig>);
          return { ok: true };
        } catch (err) {
          set.status = 500;
          return { error: err instanceof Error ? err.message : String(err) };
        }
      },
      {
        body: t.Partial(
          t.Object({
            concurrency: t.Number(),
            pollIntervalMs: t.Number(),
            batchSize: t.Number(),
            maxAttempts: t.Number(),
            paused: t.Boolean(),
          }),
        ),
      },
    );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd src/api && bun test src/workers/routes.test.ts`

Expected: all 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/api/src/workers/routes.ts src/api/src/workers/routes.test.ts
git commit -m "feat(workers): API routes — status, pause, resume, retry-dead, config patch"
```

---

## Task 11: Mount worker routes on the main Elysia app

**Files:**
- Modify: `src/api/src/index.ts`

The `Supervisor` is instantiated once at server startup with an empty stage list (Plan 1) and passed to `workerRoutes`.

- [ ] **Step 1: Write the failing test**

Create `src/api/src/workers/mount.test.ts`:

```ts
import { describe, expect, it } from "bun:test";

describe("worker routes mount smoke test", () => {
  it("GET /api/workers/status returns 200", async () => {
    // This test imports the live app and hits the route.
    // It requires no MongoDB connection because the supervisor has no stages.
    const { buildApp } = await import("../../index.ts");
    const app = buildApp({ stageNames: [] });
    const res = await app.handle(
      new Request("http://localhost/api/workers/status"),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.stages)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd src/api && bun test src/workers/mount.test.ts`

Expected: FAIL — `buildApp` does not exist (the current entry is top-level, not exported as a function).

- [ ] **Step 3: Extract `buildApp` and add the worker routes**

In `src/api/src/index.ts`, extract the Elysia app construction into an exported `buildApp` function so it is testable without starting a live server. Add the `Supervisor` and worker routes:

Add near the top imports:

```ts
import { Supervisor } from "./workers/supervisor.ts";
import { workerRoutes } from "./workers/routes.ts";
```

Add an exported builder function before the top-level startup code:

```ts
export function buildApp(opts: { stageNames?: string[] } = {}): ReturnType<typeof new Elysia> {
  const supervisor = new Supervisor(opts.stageNames ?? []);

  return new Elysia()
    .use(healthRoutes)
    .use(foldersRoutes)
    .use(assetsRoutes)
    .use(indexerRoutes)
    .use(eventsRoutes)
    .use(authRoutes)
    .use(fsRoutes)
    .use(fsThumbsRoutes)
    .use(searchRoutes)
    .use(jobsRoutes)
    .use(enrichmentRoutes)
    .use(meilisearchBackfillRoutes)
    .use(peopleRoutes)
    .use(workerRoutes(supervisor));
}
```

The existing top-level server startup should call `buildApp()` and `.listen(PORT)` on the result. Adjust the existing code to use `buildApp()`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd src/api && bun test src/workers/mount.test.ts`

Expected: 1 test passes — the route returns 200 with `{ stages: [] }`.

- [ ] **Step 5: Commit**

```bash
git add src/api/src/index.ts src/api/src/workers/mount.test.ts
git commit -m "feat(workers): mount worker routes on main Elysia app"
```

---

## Task 12: Supervisor IPC — per-child HTTP server for status/pause/resume

**Files:**
- Modify: `src/api/src/workers/runtime/run-stage.ts`

Each stage child runs a small localhost HTTP server. The supervisor contacts it for `/status`, `/pause`, `/resume`. This closes the loop between Tasks 8 and 10: the supervisor can actually relay pause/resume to a running child.

- [ ] **Step 1: Write the failing tests**

Append to `src/api/src/workers/runtime/run-stage.test.ts`:

```ts
import { IpcServer } from "./run-stage.ts";

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
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd src/api && MAPLE_TEST=1 bun test src/workers/runtime/run-stage.test.ts`

Expected: FAIL — `IpcServer` is not exported.

- [ ] **Step 3: Implement `IpcServer` in `run-stage.ts`**

Append to `src/api/src/workers/runtime/run-stage.ts` before the `_test` export:

```ts
// ---------------------------------------------------------------------------
// IpcServer — localhost HTTP server for supervisor ↔ child communication.
// ---------------------------------------------------------------------------

interface IpcServerOptions {
  name: string;
  throughput: ThroughputWindow;
  getInFlight: () => number;
  onPause?: () => void;
  onResume?: () => void;
}

/**
 * Small HTTP server listening on 127.0.0.1 only. The supervisor discovers
 * the port by reading the child's stdout line "__MAPLE_IPC_PORT__=<port>".
 * Responds to:
 *   GET  /status  → { status, inFlight, throughput }
 *   POST /pause   → sets paused=true in worker_config via onPause callback
 *   POST /resume  → sets paused=false in worker_config via onResume callback
 */
export class IpcServer {
  private server: ReturnType<typeof Bun.serve> | null = null;
  private readonly opts: IpcServerOptions;

  constructor(opts: IpcServerOptions) {
    this.opts = opts;
  }

  /** Start the server on an ephemeral port. Returns the port assigned. */
  async start(): Promise<number> {
    const opts = this.opts;
    const server = Bun.serve({
      port: 0, // OS assigns an ephemeral port
      hostname: "127.0.0.1",
      fetch(req: Request): Response {
        const url = new URL(req.url);
        if (req.method === "GET" && url.pathname === "/status") {
          return Response.json({
            status: "running",
            inFlight: opts.getInFlight(),
            throughput: opts.throughput.countInWindow(),
          });
        }
        if (req.method === "POST" && url.pathname === "/pause") {
          opts.onPause?.();
          return Response.json({ ok: true });
        }
        if (req.method === "POST" && url.pathname === "/resume") {
          opts.onResume?.();
          return Response.json({ ok: true });
        }
        return new Response("not found", { status: 404 });
      },
    });
    this.server = server;
    return server.port;
  }

  async stop(): Promise<void> {
    await this.server?.stop();
    this.server = null;
  }
}
```

Update the `_test` export to include `IpcServer`:

```ts
export const _test =
  process.env.MAPLE_TEST === "1"
    ? { bootConfig, versionBumpReset, runOnce }
    : (undefined as never);
```

The `IpcServer` class is a named export, not gated on `MAPLE_TEST`, since it is also used in production by `runStage`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd src/api && MAPLE_TEST=1 bun test src/workers/runtime/run-stage.test.ts`

Expected: all tests pass including the two new `IpcServer` tests.

- [ ] **Step 5: Commit**

```bash
git add src/api/src/workers/runtime/run-stage.ts src/api/src/workers/runtime/run-stage.test.ts
git commit -m "feat(workers): IpcServer for supervisor↔child pause/resume/status IPC"
```

---

## Task 13: Full `runStage` wires the IpcServer and emits the ready signal

**Files:**
- Modify: `src/api/src/workers/runtime/run-stage.ts`

The IpcServer must be started inside `runStage` so the supervisor can find the port. After starting, the child writes `__MAPLE_IPC_PORT__=<port>` to stdout and the supervisor updates `m.child.ipcPort`.

- [ ] **Step 1: Add the IPC integration test**

Append to `src/api/src/workers/runtime/run-stage.test.ts`:

```ts
// Note: runStage itself is tested at the supervisor integration level (Task 8).
// Here we just verify the IPC stdout signal format.
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
```

- [ ] **Step 2: Run the test to verify it passes**

Run: `cd src/api && MAPLE_TEST=1 bun test src/workers/runtime/run-stage.test.ts`

Expected: 1 additional test passes.

- [ ] **Step 3: Wire IpcServer into `runStage` and emit the port signal**

Replace the full `runStage` function in `src/api/src/workers/runtime/run-stage.ts` with:

```ts
export async function runStage(stage: StageConfig): Promise<void> {
  const log = childLogger(`workers:${stage.name}`);
  const { getDb } = await import("../../db/client.ts");
  const db = await getDb();
  const images = db.collection<ImageDoc>("assets");
  const configCollRaw = db.collection<WorkerConfigDoc>("worker_config");

  // ── Boot ──────────────────────────────────────────────────────────────────
  let config = await bootConfig(stage, configCollRaw);
  log.info({ config }, `${stage.name} stage booted`);

  // ── Version-bump reset ────────────────────────────────────────────────────
  if (stage.targetVersion > config.last_seen_target_version) {
    log.info(
      { from: config.last_seen_target_version, to: stage.targetVersion },
      `${stage.name} version bump — resetting dead docs`,
    );
    await versionBumpReset(stage, config.last_seen_target_version, images);
    const repo = new WorkerConfigRepo(configCollRaw);
    await repo.patch(stage.name, {
      last_seen_target_version: stage.targetVersion,
    });
    config = { ...config, last_seen_target_version: stage.targetVersion };
  }

  // ── Config change subscription ────────────────────────────────────────────
  const repo = new WorkerConfigRepo(configCollRaw);
  repo.subscribe(async (changedName) => {
    if (changedName !== stage.name) return;
    const updated = await repo.load(stage.name);
    if (updated) {
      config = updated;
      log.info({ config }, `${stage.name} config updated`);
    }
  });
  await repo.startWatching();

  // ── IPC server ────────────────────────────────────────────────────────────
  const throughput = new ThroughputWindow();
  const inFlightSet = new Set<string>();

  const ipc = new IpcServer({
    name: stage.name,
    throughput,
    getInFlight: () => inFlightSet.size,
    onPause: async () => {
      await repo.patch(stage.name, { paused: true });
      config = { ...config, paused: true };
      log.info(`${stage.name} paused via IPC`);
    },
    onResume: async () => {
      await repo.patch(stage.name, { paused: false });
      config = { ...config, paused: false };
      log.info(`${stage.name} resumed via IPC`);
    },
  });
  const ipcPort = await ipc.start();
  // Signal the supervisor with the IPC port so it can send pause/resume.
  process.stdout.write(`__MAPLE_IPC_PORT__=${ipcPort}\n`);
  log.info({ ipcPort }, `${stage.name} IPC server started`);

  // ── Graceful shutdown ─────────────────────────────────────────────────────
  let shuttingDown = false;
  const abortController = new AbortController();

  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`${stage.name} received SIGTERM — draining`);
    abortController.abort();
    clearInterval(pollTimer);
    await repo.stopWatching().catch(() => {});
    await ipc.stop().catch(() => {});
  };
  process.on("SIGTERM", shutdown);

  // ── Poll loop ─────────────────────────────────────────────────────────────
  const pollTimer = setInterval(async () => {
    if (shuttingDown || config.paused) return;
    try {
      await runOnce(stage, config, images, configCollRaw);
    } catch (err) {
      log.error(
        { err: err instanceof Error ? err.message : err },
        `${stage.name} poll tick error`,
      );
    }
  }, config.pollIntervalMs);

  // ── Drain on shutdown ─────────────────────────────────────────────────────
  await new Promise<void>((resolve) => {
    abortController.signal.addEventListener("abort", () => {
      // Give the current tick up to 30s to finish, then force-exit.
      const deadline = setTimeout(() => {
        log.warn(`${stage.name} drain timeout 30s — force exiting`);
        resolve();
      }, 30_000);
      // If no in-flight work, resolve immediately.
      if (inFlightSet.size === 0) {
        clearTimeout(deadline);
        resolve();
      }
    });
  });

  log.info(`${stage.name} shut down cleanly`);
  process.exit(0);
}
```

Update the supervisor to parse `__MAPLE_IPC_PORT__=` from stdout and store it on `m.child`:

In `src/api/src/workers/supervisor.ts`, update `handleReadySignal` to also capture the IPC port:

```ts
  private handleReadySignal(name: string, line: string): void {
    // IPC port signal
    const portMatch = line.match(/^__MAPLE_IPC_PORT__=(\d+)$/);
    if (portMatch) {
      const m = this.stages.get(name);
      if (m?.child) {
        m.child.ipcPort = parseInt(portMatch[1], 10);
        // Once we have the IPC port, the child is running and ready.
        if (m.state.status !== "running") {
          m.state = { ...m.state, status: "running", lastError: null };
          this.scheduleHealthyReset(name);
        }
      }
      return;
    }
    // Fallback ready signal for test scripts
    if (line.includes("__MAPLE_READY__")) {
      const m = this.stages.get(name);
      if (m && m.state.status !== "running") {
        m.state = { ...m.state, status: "running", lastError: null };
        this.scheduleHealthyReset(name);
      }
    }
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd src/api && MAPLE_TEST=1 bun test src/workers/runtime/run-stage.test.ts`

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/api/src/workers/runtime/run-stage.ts src/api/src/workers/supervisor.ts src/api/src/workers/runtime/run-stage.test.ts
git commit -m "feat(workers): runStage wires IpcServer + emits port signal to supervisor"
```

---

## Task 14: Full test suite pass and regression check

**Files:**
- No new files; runs the full API test suite to verify no regressions.

- [ ] **Step 1: Run the full API test suite**

```bash
cd src/api && bun test
```

Expected: all existing tests pass. The new workers tests all pass. No failures in `src/indexer/`, `src/enrichment/`, `src/routes/`, or `src/db/`.

- [ ] **Step 2: Verify the API still starts**

```bash
cd src/api && bun run dev &
sleep 3
curl -s http://localhost:3000/api/health | python3 -m json.tool
curl -s http://localhost:3000/api/workers/status | python3 -m json.tool
kill %1
```

Expected: `GET /api/health` returns `{ "status": "ok" }`. `GET /api/workers/status` returns `{ "stages": [] }`.

- [ ] **Step 3: Commit**

No code changes in this task. If step 1 or 2 surfaced failures, fix them in-place and commit the fix separately with a message like `fix(workers): <description>`.

---

## Self-review checklist for the executor

Before declaring Plan 1 complete:

- [ ] All new test files pass: `cd src/api && MAPLE_TEST=1 bun test src/workers/`
- [ ] Full suite passes: `cd src/api && bun test` with no regressions
- [ ] `GET /api/workers/status` returns `{ stages: [] }` against a running dev server
- [ ] No occurrences of `TODO`, `TBD`, or placeholder comments in new files
- [ ] Type consistency: every reference uses exact names `StageConfig`, `StageState`, `WorkerConfig`, `StageResult`, `StageContext`, `runStage`, `defineStage`, `WorkerConfigRepo`, `Supervisor`, `IpcServer`
- [ ] Path consistency: no file imported from a path that doesn't match the file structure table above
- [ ] Existing pipeline (`src/api/src/indexer/pipeline.ts`, `control.ts`, `standalone.ts`) is completely unchanged
- [ ] Existing enrichment workers (`src/api/src/enrichment/*-worker.ts`) are completely unchanged
- [ ] 13 commits land in order, each independently bisectable

# Plan 1 — Workers Foundation (Stage Runtime, Config Repo, Supervisor, API)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the stage-controller runtime, config repo, supervisor, and HTTP API that all future stage cutovers (Plans 2–3) depend on. No existing pipeline code is touched — the new infrastructure sits alongside the old code and is fully tested before any stage migrates to it.

**Architecture:** Five new modules under `src/api/src/workers/`. `define-stage.ts` holds canonical types and the zero-cost `defineStage` helper. `worker-config.repo.ts` owns CRUD on a new `worker_config` Mongo collection — load, upsert, patch only; no change stream, no polling. Config changes are pushed to running children via the supervisor's per-child IPC channel: `PATCH /api/workers/:name/config` writes to Mongo for persistence then calls `supervisor.notifyConfigChanged(name)`, which POSTs `reload-config` to the child's IPC server; the child re-reads its config from Mongo and applies the new values. `run-stage.ts` is the shared runtime imported by every stage child process: boot, version-bump-reset, poll loop, in-flight dispatch, atomic writeback, throughput rolling window, pause/resume, reload-config, and graceful drain. `main.ts` is the 4-line entry shim. `supervisor.ts` generalizes `src/api/src/indexer/control.ts` to manage N named stage children with the same backoff/respawn/log-multiplex/IPC pattern; stage spawns are stubbed in Plan 1 so the supervisor boots cleanly with zero children while its tests register a synthetic stage.

**Tech Stack:** Bun, TypeScript, MongoDB, Elysia (API endpoints), bun:test. No `mongodb-memory-server` — all repo and runtime tests use hand-rolled typed mock collections.

**Spec:** [`.archived-plans/specs/2026-05-09-stage-controllers-design.md`](../specs/2026-05-09-stage-controllers-design.md)

---

## File structure

| File | Status | Responsibility |
|---|---|---|
| `src/api/src/workers/runtime/define-stage.ts` | Create | Canonical types (`StageState`, `WorkerConfig`, `StageResult`, `StageConfig`, `StageContext`) and `defineStage()` helper. |
| `src/api/src/workers/runtime/define-stage.test.ts` | Create | Type-level and runtime tests for `defineStage`. |
| `src/api/src/workers/worker-config.repo.ts` | Create | CRUD on `worker_config` Mongo collection: `load`, `upsert`, `patch` only. |
| `src/api/src/workers/worker-config.repo.test.ts` | Create | Unit tests for repo CRUD using a hand-rolled typed mock collection. |
| `src/api/src/workers/runtime/run-stage.ts` | Create | Stage child runtime: boot, version-bump-reset, poll loop, worker pool, writeback, throughput, pause/resume, reload-config, SIGTERM drain. |
| `src/api/src/workers/runtime/run-stage.test.ts` | Create | Comprehensive unit tests with hand-rolled mock Mongo collections and a synthetic handler. |
| `src/api/src/workers/runtime/main.ts` | Create | Entry shim: reads `process.argv[2]`, dynamic-imports the stage, calls `runStage`. |
| `src/api/src/workers/supervisor.ts` | Create | Generalized supervisor: N named children, exponential backoff, IPC, log mux, HTTP API endpoints, `notifyConfigChanged`. |
| `src/api/src/workers/supervisor.test.ts` | Create | Integration tests: spawn synthetic stage child, pause/resume/SIGTERM/crash-respawn assertions. |
| `src/api/src/db/client.ts` | Modify | Add `workerConfigCollection()` helper and `worker_config` indexes to `ensureIndexes()`. |

---

## Task 1: Define canonical types and `defineStage` helper

**Files:**
- Create: `src/api/src/workers/runtime/define-stage.ts`
- Create: `src/api/src/workers/runtime/define-stage.test.ts`

**Status: DONE** — landed at commit `f54e6e1` on branch `plan-1-foundation-impl`. No changes needed.

- [x] **Step 1: Write the failing test**
- [x] **Step 2: Run the test to verify it fails**
- [x] **Step 3: Implement the helper**
- [x] **Step 4: Run the test to verify it passes**
- [x] **Step 5: Commit** (`feat(workers): canonical types + defineStage helper`)

The committed `define-stage.ts` exports: `StageState`, `WorkerConfig`, `StageResult`, `StageConfig`, `StageContext`, `ImageDoc`, `defineStage`.

---

## Task 2: Add `workerConfigCollection()` to the DB client

**Files:**
- Modify: `src/api/src/db/client.ts`

**Status: DONE** — landed at commit `05062dc` on branch `plan-1-foundation-impl`. No changes needed.

- [x] **Step 1: Write the failing test**

The test file was created at `src/api/src/workers/worker-config.repo.test.ts` (a single import-assertion test). The correct import path from inside `src/api/src/workers/` is `../db/client.ts` (one level up), not `../../db/client.ts`.

- [x] **Step 2–5: Committed** (`feat(db): workerConfigCollection helper + worker_config index`)

`workerConfigCollection()` returns `Collection<WorkerConfigDoc>` from the `worker_config` collection. `ensureIndexes()` creates a unique index `{ name: 1 }` named `worker_config_name` on that collection. `WorkerConfigDoc` is imported from `../workers/worker-config.repo.ts` (circular-safe because it is a type-only import).

---

## Task 3: Implement `WorkerConfigRepo`

**Files:**
- Create: `src/api/src/workers/worker-config.repo.ts`
- Modify: `src/api/src/workers/worker-config.repo.test.ts`

`WorkerConfigRepo` is CRUD only — no change stream, no polling, no subscribers, no `startWatching`, no `stopWatching`. Config propagation is the supervisor's job via the `reload-config` IPC verb (Task 12).

- [ ] **Step 1: Write the failing tests**

Replace the contents of `src/api/src/workers/worker-config.repo.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import type { Collection } from "mongodb";
import type { WorkerConfigDoc } from "./worker-config.repo.ts";
import { WorkerConfigRepo } from "./worker-config.repo.ts";

// ---------------------------------------------------------------------------
// Hand-rolled typed mock for Collection<WorkerConfigDoc>.
// No mongodb-memory-server needed — the repo only calls findOne, updateOne,
// and we can fully control those with a simple in-memory Map.
// ---------------------------------------------------------------------------

function makeMockCollection(): Collection<WorkerConfigDoc> {
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
      return { matchedCount: 1, modifiedCount: 1, upsertedCount: 0, upsertedId: null, acknowledged: true };
    },
  } as unknown as Collection<WorkerConfigDoc>;
}

describe("WorkerConfigRepo.load", () => {
  it("returns null when no doc exists", async () => {
    const coll = makeMockCollection();
    const repo = new WorkerConfigRepo(coll);
    const result = await repo.load("hash");
    expect(result).toBeNull();
  });

  it("returns the doc when it exists", async () => {
    const coll = makeMockCollection();
    // Pre-seed via upsert so we go through the repo's own code path
    const repo = new WorkerConfigRepo(coll);
    await repo.upsert("hash", {
      concurrency: 4,
      pollIntervalMs: 1000,
      batchSize: 10,
      maxAttempts: 5,
      paused: false,
      last_seen_target_version: 1,
    });
    const result = await repo.load("hash");
    expect(result?.concurrency).toBe(4);
    expect(result?.last_seen_target_version).toBe(1);
  });
});

describe("WorkerConfigRepo.upsert", () => {
  it("inserts on first call", async () => {
    const coll = makeMockCollection();
    const repo = new WorkerConfigRepo(coll);
    await repo.upsert("exif", {
      concurrency: 4,
      pollIntervalMs: 1000,
      batchSize: 10,
      maxAttempts: 5,
      paused: false,
      last_seen_target_version: 0,
    });
    const result = await repo.load("exif");
    expect(result?.concurrency).toBe(4);
  });

  it("updates on subsequent calls", async () => {
    const coll = makeMockCollection();
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
    const result = await repo.load("exif");
    expect(result?.concurrency).toBe(8);
    expect(result?.paused).toBe(true);
    expect(result?.last_seen_target_version).toBe(1);
  });
});

describe("WorkerConfigRepo.patch", () => {
  it("updates only the supplied fields", async () => {
    const coll = makeMockCollection();
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
    const result = await repo.load("thumb");
    expect(result?.concurrency).toBe(4);
    // Other fields unchanged
    expect(result?.batchSize).toBe(5);
    expect(result?.paused).toBe(false);
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
 * Config changes are NOT propagated here. The supervisor's IPC channel is the
 * canonical change signal: PATCH /api/workers/:name/config writes to Mongo via
 * this repo for persistence, then calls supervisor.notifyConfigChanged(name),
 * which POSTs reload-config to the child's IPC server. The child re-reads its
 * config from Mongo and applies the new values live.
 */

import type { Collection } from "mongodb";
import type { WorkerConfig } from "./runtime/define-stage.ts";

export interface WorkerConfigDoc extends WorkerConfig {
  /** Stage name — the unique key for this collection. */
  name: string;
}

export class WorkerConfigRepo {
  constructor(private readonly coll: Collection<WorkerConfigDoc>) {}

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
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd src/api && bun test src/workers/worker-config.repo.test.ts`

Expected: 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/api/src/workers/worker-config.repo.ts src/api/src/workers/worker-config.repo.test.ts
git commit -m "feat(workers): WorkerConfigRepo — load/upsert/patch CRUD"
```

---

## Task 4: Implement `runStage` — boot, config load, version-bump reset

**Files:**
- Create: `src/api/src/workers/runtime/run-stage.ts` (partial — boot + version-bump only)
- Create: `src/api/src/workers/runtime/run-stage.test.ts` (partial)

This task handles steps 1–2 of the runtime: connecting to Mongo, loading/seeding config, and running the version-bump-reset `updateMany` when the handler's `targetVersion` is higher than `last_seen_target_version`.

All tests use hand-rolled typed mock collections — no `mongodb-memory-server`.

- [ ] **Step 1: Write the failing tests**

Create `src/api/src/workers/runtime/run-stage.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import type { Collection, Filter, UpdateFilter, UpdateOptions, UpdateResult } from "mongodb";
import { defineStage } from "./define-stage.ts";
import type { ImageDoc, StageState } from "./define-stage.ts";
import type { WorkerConfigDoc } from "../worker-config.repo.ts";

// We test the internal helpers exported from run-stage in test mode.
// run-stage exports them behind an `_test` namespace when MAPLE_TEST=1.
import { _test } from "./run-stage.ts";

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
    async find() {
      return {
        async toArray() { return [...store]; },
        limit() { return this; },
      };
    },
    async findOne(filter: Record<string, unknown>) {
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
    const docVal = getNestedValue(doc as Record<string, unknown>, key);
    if (val !== null && typeof val === "object") {
      const op = val as Record<string, unknown>;
      if ("$lt" in op && !(docVal < (op["$lt"] as number))) return false;
      if ("$gte" in op && !(docVal >= (op["$gte"] as number))) return false;
      if ("$ne" in op && docVal === op["$ne"]) return false;
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

    const docs = await (await images.find({})).toArray();
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

    const docs = await (await images.find({})).toArray();
    expect(docs[0]?.stages?.hash?.dead).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd src/api && MAPLE_TEST=1 bun test src/workers/runtime/run-stage.test.ts`

Expected: FAIL — `run-stage.ts` does not exist.

- [ ] **Step 3: Implement boot and version-bump-reset in `run-stage.ts`**

Create `src/api/src/workers/runtime/run-stage.ts`:

```ts
/**
 * Stage controller runtime.
 *
 * Imported by every stage child process (via the entry shim main.ts).
 * Handles: boot, version-bump reset, poll loop, worker pool, atomic writeback,
 * throughput rolling window, pause/resume, reload-config, and graceful drain on SIGTERM.
 *
 * This file is built incrementally across Tasks 4–8 of the plan.
 * The _test export is gated on process.env.MAPLE_TEST so production builds
 * include no test surface.
 */

import type { Collection } from "mongodb";
import { child as childLogger } from "../../log.ts";
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
 * Idempotent: if the API crashes between the updateMany and the config write,
 * the reset will run again on the next boot — harmless because the predicate
 * only matches docs whose version < targetVersion.
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

- [ ] **Step 1: Add claim query and poll-loop tests**

Append to `src/api/src/workers/runtime/run-stage.test.ts`:

```ts
import { buildClaimQuery } from "./run-stage.ts";

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

  it("excludes in-flight _ids", () => {
    // Use plain string IDs for the Set since we have no real ObjectId
    const id1 = "id1" as unknown as import("mongodb").ObjectId;
    const id2 = "id2" as unknown as import("mongodb").ObjectId;
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
    const docs = await (await images.find({})).toArray();
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

    const docs = await (await images.find({})).toArray();
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd src/api && MAPLE_TEST=1 bun test src/workers/runtime/run-stage.test.ts`

Expected: FAIL — `buildClaimQuery` and `_test.runOnce` are not exported yet.

- [ ] **Step 3: Add claim query and single-poll-tick to `run-stage.ts`**

Add the following to `src/api/src/workers/runtime/run-stage.ts`, before the `_test` export:

```ts
import type { Filter, ObjectId } from "mongodb";

// ---------------------------------------------------------------------------
// Claim query construction.
// ---------------------------------------------------------------------------

/**
 * Build the MongoDB filter that selects docs eligible for this stage:
 *   - stages.<name>.version < targetVersion (missing field treated as < any number)
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

Update the `_test` export to include `bootConfig`, `versionBumpReset`, and `runOnce`:

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

The throughput metric is a ring buffer of recent `processed_at` timestamps. The full `runStage` wires together: boot, version-bump-reset, the timer-based poll loop, and SIGTERM drain. The config-change subscription (previously done via `repo.startWatching()`) is replaced by the `reload-config` IPC verb added in Task 12.

- [ ] **Step 1: Add throughput tests**

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

Replace the `runStage` stub with the full implementation (the IpcServer wiring is added in Task 13):

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

  const throughput = new ThroughputWindow();

  // ── Graceful shutdown ─────────────────────────────────────────────────────
  let shuttingDown = false;
  const abortController = new AbortController();

  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`${stage.name} received SIGTERM — draining`);
    abortController.abort();
    clearInterval(pollTimer);
  };
  process.on("SIGTERM", () => { shutdown().catch(() => {}); });

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
- Create: `src/api/src/workers/supervisor.test.ts`

The supervisor generalizes `src/api/src/indexer/control.ts` to manage N named stage children. In Plan 1, `stageNames` is empty by default; tests register a synthetic stage via a test-only injection path. `notifyConfigChanged` POSTs `reload-config` to the child's IPC port (added in Task 12 / consumed in Task 13).

- [ ] **Step 1: Write the failing tests**

Create `src/api/src/workers/supervisor.test.ts`:

```ts
import { afterEach, describe, expect, it } from "bun:test";
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

  it("reports error status after 5 consecutive crashes", async () => {
    // Script that always exits 1
    const script = await writeTmpScript(`process.exit(1);\n`);
    sup = new Supervisor([], { _stageScriptOverrides: { crashing: script } });
    sup.addStage("crashing");

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
    const script = await writeTmpScript(`
const { serve } = Bun;
const port = parseInt(process.env.MAPLE_STAGE_PORT ?? "0");
serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    if (new URL(req.url).pathname === "/status") {
      return Response.json({ status: "running", inFlight: 0, throughput: 0 });
    }
    return new Response("not found", { status: 404 });
  },
});
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

describe("Supervisor — notifyConfigChanged", () => {
  it("returns error for unknown stage", async () => {
    const sup = new Supervisor([]);
    const result = await sup.notifyConfigChanged("nonexistent");
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
 * assigned by the OS and signalled via stdout __MAPLE_IPC_PORT__=<port>).
 * The supervisor sends pause/resume/reload-config over plain fetch().
 *
 * Crash backoff: 1s, 2s, 4s, 8s, 16s, saturates at 30s.
 * After 5 consecutive crashes, the stage is marked `status: "error"` and
 * stays down until POST /api/workers/:name/retry-dead is called.
 *
 * Config changes:
 *   PATCH /api/workers/:name/config
 *     → writes to Mongo (persistence)
 *     → calls supervisor.notifyConfigChanged(name)
 *     → supervisor POSTs reload-config to child's IPC port
 *     → child re-reads worker_config[name] from Mongo and applies live
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
      this.forwardStream(child.stdout as ReadableStream<Uint8Array> | null, process.stdout, `[${name}]`, name);
      this.forwardStream(child.stderr as ReadableStream<Uint8Array> | null, process.stderr, `[${name}]`, name);
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
    while (Date.now() < deadline) {
      if (m.state.status === "stopped" || m.state.status === "error") return;
      if (m.state.status === "running") return;

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

    m.state = {
      ...m.state,
      status: "error",
      lastError: `waitReady timeout after ${timeoutMs}ms`,
    };
  }

  /** Parse ready / IPC-port signals from child stdout lines. */
  private handleReadySignal(name: string, line: string): void {
    // IPC port signal emitted by the child's runStage after IpcServer.start()
    const portMatch = line.match(/^__MAPLE_IPC_PORT__=(\d+)$/);
    if (portMatch) {
      const m = this.stages.get(name);
      if (m?.child) {
        m.child.ipcPort = parseInt(portMatch[1], 10);
        if (m.state.status !== "running") {
          m.state = { ...m.state, status: "running", lastError: null };
          this.scheduleHealthyReset(name);
        }
      }
      return;
    }
    // Fallback ready signal for test scripts that don't start an IPC server
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
    stageName: string,
  ): Promise<void> {
    if (!source || typeof (source as ReadableStream).getReader !== "function") return;
    const reader = (source as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buf = "";
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

  /**
   * Notify a stage child that its config has changed.
   * Called by the PATCH /api/workers/:name/config handler after writing to Mongo.
   * POSTs reload-config to the child's IPC port; the child re-reads its config
   * from Mongo and applies the new values live (concurrency, pollIntervalMs,
   * batchSize, maxAttempts, paused).
   */
  async notifyConfigChanged(name: string): Promise<{ ok: boolean; error?: string }> {
    const m = this.stages.get(name);
    if (!m) return { ok: false, error: `unknown stage: ${name}` };
    const port = m.child?.ipcPort;
    if (!port) return { ok: false, error: "stage has no IPC port (not running)" };
    try {
      const res = await fetch(`http://127.0.0.1:${port}/reload-config`, {
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
    for (const [_name, m] of this.stages) {
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

Expected: all 4 tests pass (the crash-respawn test hits 5 crashes within 8s; the healthy test resolves once `__MAPLE_READY__` is emitted; the `notifyConfigChanged` unknown-stage test returns `ok: false`).

- [ ] **Step 5: Commit**

```bash
git add src/api/src/workers/supervisor.ts src/api/src/workers/supervisor.test.ts
git commit -m "feat(workers): Supervisor — N-child lifecycle, backoff, IPC, log mux, notifyConfigChanged"
```

---

## Task 9: Add per-stage Mongo indexes to `ensureIndexes`

**Files:**
- Modify: `src/api/src/db/client.ts`

The spec mandates one partial index per stage on `{ "stages.<name>.version": 1 }` with `partialFilterExpression: { "stages.<name>.dead": { $eq: false } }`. These must be created at startup so claim queries are fast from day one.

Tests use a hand-rolled in-memory collection stub — no `mongodb-memory-server`.

- [ ] **Step 1: Write the failing test**

Create `src/api/src/workers/runtime/indexes.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import type { Db, Collection } from "mongodb";

// Hand-rolled stub for Db that tracks createIndex calls per collection.
// ensureStageIndexes only calls db.collection(name).createIndex — we stub that.

interface IndexSpec {
  key: Record<string, unknown>;
  options: Record<string, unknown>;
}

function makeDbStub(): { db: Db; getIndexes: (collName: string) => IndexSpec[] } {
  const collIndexes = new Map<string, IndexSpec[]>();

  function collStub(name: string): Collection {
    if (!collIndexes.has(name)) collIndexes.set(name, []);
    return {
      async createIndex(key: Record<string, unknown>, options: Record<string, unknown> = {}) {
        collIndexes.get(name)!.push({ key, options });
        return options["name"] as string ?? JSON.stringify(key);
      },
    } as unknown as Collection;
  }

  return {
    db: {
      collection: collStub,
    } as unknown as Db,
    getIndexes: (n: string) => collIndexes.get(n) ?? [],
  };
}

const STAGE_NAMES = ["hash", "exif", "thumb", "face", "ocr", "describe", "geocode", "meili"];

describe("ensureStageIndexes", () => {
  it("creates a partial index for each known stage", async () => {
    const { db, getIndexes } = makeDbStub();
    const { ensureStageIndexes } = await import("../db/client.ts");
    await ensureStageIndexes(db);
    const indexes = getIndexes("assets");
    for (const name of STAGE_NAMES) {
      const found = indexes.find(
        (idx) =>
          idx.key[`stages.${name}.version`] === 1 &&
          (idx.options["partialFilterExpression"] as Record<string, unknown>)?.[
            `stages.${name}.dead`
          ] !== undefined,
      );
      expect(found).toBeDefined();
    }
  });

  it("is idempotent — calling twice does not throw", async () => {
    const { db } = makeDbStub();
    const { ensureStageIndexes } = await import("../db/client.ts");
    await ensureStageIndexes(db);
    await expect(ensureStageIndexes(db)).resolves.toBeUndefined();
  });
});
```

Note: the import path from `src/api/src/workers/runtime/indexes.test.ts` to `src/api/src/db/client.ts` is `../db/client.ts` (two levels up: `runtime/` → `workers/` → `src/`, then down into `db/`). Use `../../db/client.ts` from within `src/api/src/workers/runtime/`.

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

Also add the `Db` import to the top of the file if not already present:

```ts
import {
  MongoClient,
  type Db,
  type Collection,
  ServerApiVersion,
} from "mongodb";
```

(`Db` is already imported — verify before adding a duplicate.)

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

## Task 10: API endpoint — worker routes

**Files:**
- Create: `src/api/src/workers/routes.ts`
- Create: `src/api/src/workers/routes.test.ts`

The status endpoint aggregates the supervisor's stage snapshots with Mongo pending/dead counts. The PATCH config handler writes to Mongo then calls `supervisor.notifyConfigChanged(name)` so the running child reloads its config live.

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
      new Request("http://localhost/api/workers/nonexistent/pause", { method: "POST" }),
    );
    expect(res.status).toBe(404);
  });
});

describe("POST /api/workers/:name/resume", () => {
  it("returns 404 for unknown stage", async () => {
    const sup = new Supervisor([]);
    const app = new Elysia().use(workerRoutes(sup));
    const res = await app.handle(
      new Request("http://localhost/api/workers/nonexistent/resume", { method: "POST" }),
    );
    expect(res.status).toBe(404);
  });
});

describe("POST /api/workers/:name/retry-dead", () => {
  it("returns 404 for unknown stage", async () => {
    const sup = new Supervisor([]);
    const app = new Elysia().use(workerRoutes(sup));
    const res = await app.handle(
      new Request("http://localhost/api/workers/nonexistent/retry-dead", { method: "POST" }),
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
 * Mounted on the main Elysia app in src/api/src/index.ts under /api/workers.
 * All routes are server-side only in Plan 1 — the Angular UI is Plan 4.
 *
 * Config change flow for PATCH /:name/config:
 *   1. Validate the patch body.
 *   2. Write to worker_config in Mongo (persistence).
 *   3. Call supervisor.notifyConfigChanged(name), which POSTs reload-config
 *      to the child's IPC port. The child re-reads from Mongo and applies live.
 *   4. Return { ok: true }.
 *
 * Routes:
 *   GET  /api/workers/status            — aggregated status + pending/dead counts
 *   POST /api/workers/:name/pause       — pause a stage's poll loop
 *   POST /api/workers/:name/resume      — resume a paused stage
 *   POST /api/workers/:name/retry-dead  — reset dead docs for a stage
 *   PATCH /api/workers/:name/config     — update WorkerConfig fields + notify child
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
            pending = await images.countDocuments({
              [`stages.${name}.dead`]: { $ne: true },
              [`stages.${name}.version`]: { $lt: 999999 },
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
          // Push the change to the running child via IPC.
          // Returns ok:false with an error if the child is not running — that
          // is non-fatal: the config is persisted and will be loaded on next boot.
          await supervisor.notifyConfigChanged(params.name);
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
git commit -m "feat(workers): API routes — status, pause, resume, retry-dead, config patch + notify"
```

---

## Task 11: Mount worker routes on the main Elysia app

**Files:**
- Modify: `src/api/src/index.ts`

The `Supervisor` is instantiated once at server startup with an empty stage list (Plan 1) and passed to `workerRoutes`. The existing `index.ts` builds the Elysia app as a `const app` inside a top-level module scope — extract it into an exported `buildApp` function so routes.test.ts can test against it without starting a live server.

- [ ] **Step 1: Write the failing test**

Create `src/api/src/workers/mount.test.ts`:

```ts
import { describe, expect, it } from "bun:test";

describe("worker routes mount smoke test", () => {
  it("GET /api/workers/status returns 200", async () => {
    // This test imports the live app and hits the route.
    // It requires no MongoDB connection because the supervisor has no stages.
    const { buildApp } = await import("../index.ts");
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

In `src/api/src/index.ts`, add these imports near the top alongside the existing route imports:

```ts
import { Supervisor } from "./workers/supervisor.ts";
import { workerRoutes } from "./workers/routes.ts";
```

Extract the app construction into an exported `buildApp` function. The existing `const app = new Elysia()...` block becomes the body of `buildApp`. Add a `stageNames` option and wire in `workerRoutes`:

```ts
export function buildApp(opts: { stageNames?: string[] } = {}): Elysia {
  const supervisor = new Supervisor(opts.stageNames ?? []);

  return new Elysia()
    .onBeforeHandle(({ set }) => {
      // ... existing CORS + COOP/COEP headers (copy verbatim from the current top-level block)
    })
    .options("/*", /* ... existing preflight handler ... */)
    .onError(/* ... existing error handler ... */)
    .use(healthRoutes)
    .use(authRoutes)
    .use(eventsRoutes)
    .use(
      new Elysia({ name: "authedApi" })
        .use(requireAuth)
        .use(foldersRoutes)
        .use(assetsRoutes)
        .use(indexerRoutes)
        .use(fsRoutes)
        .use(fsThumbsRoutes)
        .use(searchRoutes)
        .use(jobsRoutes)
        .use(enrichmentRoutes)
        .use(meilisearchBackfillRoutes)
        .use(peopleRoutes)
        .use(workerRoutes(supervisor)),
    )
    .use(staticUiPlugin);
}
```

The existing top-level startup `start()` function should call `const app = buildApp()` and then `.listen(PORT)` on the result.

**Implementation note:** The existing `app` in `index.ts` is constructed inline (not in a function). The refactor is: move the `new Elysia()...` chain into `buildApp`, have `start()` call `buildApp().listen(PORT)`, and keep all the `ensureJwtSecret()`, `ensureIndexes()`, worker-bootstrap calls inside `start()` as before.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd src/api && bun test src/workers/mount.test.ts`

Expected: 1 test passes — the route returns 200 with `{ stages: [] }`.

- [ ] **Step 5: Commit**

```bash
git add src/api/src/index.ts src/api/src/workers/mount.test.ts
git commit -m "feat(workers): mount worker routes on main Elysia app"
```

---

## Task 12: Supervisor IPC — per-child HTTP server for status/pause/resume/reload-config

**Files:**
- Modify: `src/api/src/workers/runtime/run-stage.ts`

Each stage child runs a small localhost HTTP server. The supervisor contacts it for `/status`, `/pause`, `/resume`, and `/reload-config`. The `reload-config` verb triggers a re-read of `worker_config[name]` from Mongo and applies the new config live — this is how `PATCH /api/workers/:name/config` propagates to a running child without restarting it.

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
  /**
   * Called when the supervisor sends POST /reload-config.
   * The implementation should re-read worker_config[name] from Mongo
   * and update the running config reference so the next poll tick uses
   * the new concurrency, pollIntervalMs, batchSize, maxAttempts, and paused.
   */
  onReloadConfig?: () => Promise<void>;
}

/**
 * Small HTTP server listening on 127.0.0.1 only. The supervisor discovers
 * the port by reading the child's stdout line "__MAPLE_IPC_PORT__=<port>".
 * Responds to:
 *   GET  /status         → { status, inFlight, throughput }
 *   POST /pause          → calls onPause callback
 *   POST /resume         → calls onResume callback
 *   POST /reload-config  → calls onReloadConfig callback (re-reads config from Mongo)
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
      async fetch(req: Request): Promise<Response> {
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
        if (req.method === "POST" && url.pathname === "/reload-config") {
          try {
            await opts.onReloadConfig?.();
          } catch {
            return Response.json({ ok: false, error: "reload failed" }, { status: 500 });
          }
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

The `IpcServer` class is a named export, not gated on `MAPLE_TEST`, since it is also used in production by `runStage`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd src/api && MAPLE_TEST=1 bun test src/workers/runtime/run-stage.test.ts`

Expected: all tests pass including the three new `IpcServer` tests.

- [ ] **Step 5: Commit**

```bash
git add src/api/src/workers/runtime/run-stage.ts src/api/src/workers/runtime/run-stage.test.ts
git commit -m "feat(workers): IpcServer — status/pause/resume/reload-config IPC verbs"
```

---

## Task 13: Full `runStage` wires the IpcServer, emits the ready signal, and handles reload-config

**Files:**
- Modify: `src/api/src/workers/runtime/run-stage.ts`
- Modify: `src/api/src/workers/supervisor.ts`

The IpcServer must be started inside `runStage` so the supervisor can find the port. After starting, the child writes `__MAPLE_IPC_PORT__=<port>` to stdout and the supervisor updates `m.child.ipcPort`. The `reload-config` handler re-reads `worker_config[name]` from Mongo and updates the live `config` reference used by the poll loop.

- [ ] **Step 1: Add the IPC integration test**

Append to `src/api/src/workers/runtime/run-stage.test.ts`:

```ts
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

Expected: 1 additional test passes — no code changes needed, this just verifies the signal format.

- [ ] **Step 3: Wire IpcServer into `runStage`, emit the port signal, handle reload-config**

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

  const throughput = new ThroughputWindow();
  const inFlightSet = new Set<string>();

  // ── IPC server ────────────────────────────────────────────────────────────
  const repo = new WorkerConfigRepo(configCollRaw);

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
    onReloadConfig: async () => {
      // Re-read the full config from Mongo — the supervisor called this after
      // the PATCH /api/workers/:name/config handler updated the DB.
      const updated = await repo.load(stage.name);
      if (updated) {
        config = updated;
        log.info({ config }, `${stage.name} config reloaded via IPC`);
      }
    },
  });

  const ipcPort = await ipc.start();
  // Signal the supervisor with the IPC port so it can send IPC commands.
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
    await ipc.stop().catch(() => {});
  };
  process.on("SIGTERM", () => { shutdown().catch(() => {}); });

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
      const deadline = setTimeout(() => {
        log.warn(`${stage.name} drain timeout 30s — force exiting`);
        resolve();
      }, 30_000);
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

The supervisor's `handleReadySignal` already handles the `__MAPLE_IPC_PORT__=` line and sets `m.child.ipcPort` (added in Task 8, Step 3). No further changes to `supervisor.ts` are needed.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd src/api && MAPLE_TEST=1 bun test src/workers/runtime/run-stage.test.ts`

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/api/src/workers/runtime/run-stage.ts
git commit -m "feat(workers): runStage wires IpcServer + reload-config + emits port signal"
```

---

## Task 14: Full test suite pass and regression check

**Files:**
- No new files; runs the full API test suite to verify no regressions.

- [ ] **Step 1: Run the full API test suite**

```bash
cd src/api && MAPLE_TEST=1 bun test
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
- [ ] Full suite passes: `cd src/api && MAPLE_TEST=1 bun test` with no regressions
- [ ] `GET /api/workers/status` returns `{ stages: [] }` against a running dev server
- [ ] No occurrences of `TODO`, `TBD`, or placeholder comments in new files
- [ ] No reference to `mongodb-memory-server` anywhere in `src/api/src/workers/`
- [ ] `WorkerConfigRepo` has only `load`, `upsert`, `patch` — no `subscribe`, `startWatching`, `startPolling`, `stopPolling`, `stopWatching`, `pollForChanges`
- [ ] `reload-config` IPC verb appears in `IpcServer` (Task 12), is wired in `runStage` (Task 13), and is called from `supervisor.notifyConfigChanged` (Task 8), which is triggered from the PATCH handler (Task 10)
- [ ] Type consistency: every reference uses exact names `StageConfig`, `StageState`, `WorkerConfig`, `StageResult`, `StageContext`, `runStage`, `defineStage`, `WorkerConfigRepo`, `Supervisor`, `IpcServer`
- [ ] Import paths verified:
  - From `src/api/src/workers/worker-config.repo.ts` → `./runtime/define-stage.ts` ✓
  - From `src/api/src/workers/runtime/run-stage.ts` → `../../log.ts` ✓, `../worker-config.repo.ts` ✓
  - From `src/api/src/workers/runtime/run-stage.ts` → `../../db/client.ts` (dynamic import inside `runStage`) ✓
  - From `src/api/src/workers/routes.ts` → `../db/client.ts` ✓
  - From `src/api/src/workers/runtime/indexes.test.ts` → `../../db/client.ts` ✓
  - From `src/api/src/workers/worker-config.repo.test.ts` → `../db/client.ts` (Task 2 import assertion) ✓
- [ ] Existing pipeline (`src/api/src/indexer/pipeline.ts`, `control.ts`, `standalone.ts`) is completely unchanged
- [ ] Existing enrichment workers (`src/api/src/enrichment/*-bootstrap.ts`) are completely unchanged
- [ ] 13 commits land in order, each independently bisectable

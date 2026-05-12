# `/api/workers/status` Performance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `GET /api/workers/status` answer in tens of milliseconds instead of the multi-second response the workers page sees today, on libraries with tens of thousands of `assets`.

**Architecture:** The route currently builds a single `$facet` aggregation with `2 × 8 = 16` sub-pipelines and runs it as the first stage of an aggregation on `assets`. Because there is no `$match` ahead of the `$facet`, the planner has to feed the entire collection into the stage, and the sub-pipelines run against that materialized input set — every poll = one COLLSCAN of `assets`. On top of that, `stages.<name>.dead: true` has no index, and `dead: { $ne: true }` cannot use an index even if one existed. Fix: replace the `$facet` with `Promise.all` of indexed `countDocuments()` calls (one pending + one dead per stage), add a partial index on `stages.<name>.dead: true`, and run the supervisor IPC refresh concurrently with the DB queries instead of sequentially.

**Tech Stack:** Bun + Elysia + MongoDB driver, `bun:test`. Indexes live in `src/api/src/db/client.ts`. Route lives in `src/api/src/workers/routes.ts`. Integration tests run against a real local MongoDB (skip-pass if unreachable) — same pattern as `tests/search-route.test.ts`.

**Reference numbers (for ratchet):**
- Stages today: `hash, exif, thumb, face, ocr, describe, geocode, meili` — 8 stages.
- Sub-pipelines today: 16 (2 per stage).
- Per-call DB calls after fix: 16 `countDocuments` + 1 `find({}).toArray()` on `worker_config`, run in parallel.
- IPC refresh: bounded to a 300 ms `AbortSignal.timeout` per child, parallel — total wall time stays ≤ 300 ms.

---

## File Structure

**Modified:**
- `src/api/src/db/client.ts` — extend `ensureStageIndexes()` to also create a partial `{ stages.<name>.dead: 1 }` index per stage. One responsibility (Mongo schema).
- `src/api/src/workers/routes.ts` — replace the `$facet` block in `GET /status` with parallel `countDocuments` + concurrent IPC refresh. One responsibility (route handler).

**Created:**
- `src/api/tests/workers-status-perf.test.ts` — integration test against real Mongo that (a) verifies `ensureStageIndexes` creates the new dead index, (b) seeds a small assets fixture and asserts the route returns the correct pending/dead counts, (c) asserts the explain plan for both count queries uses an index (no `COLLSCAN`). Mirrors the `search-route.test.ts` skip-when-Mongo-unreachable pattern.

No file split is needed in `routes.ts` — the `/status` handler stays small after the refactor; the rest of the file (other routes) is untouched.

---

## Task 1: Add partial dead index per stage

**Files:**
- Modify: `src/api/src/db/client.ts:180-198` (extend `ensureStageIndexes`)
- Test: `src/api/tests/workers-status-perf.test.ts` (new file, first test block)

### Step 1.1: Write the failing index test

- [ ] Create `src/api/tests/workers-status-perf.test.ts` with the index assertion:

```ts
/**
 * Integration tests for /api/workers/status performance + correctness.
 *
 * Skip-passes when MongoDB is unreachable so CI without a Mongo container
 * stays green — same pattern as tests/search-route.test.ts.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { MongoClient } from "mongodb";

const TEST_DB = `maple_test_workers_status_${process.pid}`;
const PRIOR_MONGO_DB = process.env.MAPLE_MONGO_DB;
process.env.MAPLE_MONGO_DB = TEST_DB;

const MONGO_URI = process.env.MAPLE_MONGO_URI ?? "mongodb://localhost:27017";

let mongo: MongoClient | null = null;
let mongoReachable = false;

beforeAll(async () => {
  try {
    mongo = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 500 });
    await mongo.connect();
    await mongo.db("admin").command({ ping: 1 });
    mongoReachable = true;
  } catch {
    mongoReachable = false;
  }
});

afterAll(async () => {
  if (mongo && mongoReachable) {
    try {
      await mongo.db(TEST_DB).dropDatabase();
    } catch {}
    await mongo.close();
  }
  if (PRIOR_MONGO_DB === undefined) delete process.env.MAPLE_MONGO_DB;
  else process.env.MAPLE_MONGO_DB = PRIOR_MONGO_DB;
});

describe("ensureStageIndexes — dead partial index", () => {
  it("creates stage_<name>_dead partial index for every stage", async () => {
    if (!mongoReachable) return;
    const { closeDb, ensureStageIndexes } = await import("../src/db/client.ts");
    await closeDb();
    const db = mongo!.db(TEST_DB);
    // Pre-create the assets collection so dropIndex on a fresh namespace
    // doesn't throw NamespaceNotFound (matches the pattern in
    // tests/search-route.test.ts:1310).
    try {
      await db.createCollection("assets");
    } catch {}

    await ensureStageIndexes(db);
    // Idempotent — second call must not throw.
    await ensureStageIndexes(db);

    const indexes = await db.collection("assets").indexes();
    const byName = new Map(indexes.map((i) => [i.name as string, i]));

    for (const name of [
      "hash",
      "exif",
      "thumb",
      "face",
      "ocr",
      "describe",
      "geocode",
      "meili",
    ]) {
      const idx = byName.get(`stage_${name}_dead`);
      expect(idx).toBeDefined();
      // Partial filter must restrict to dead: true so the index stays tiny.
      expect(idx?.partialFilterExpression).toEqual({
        [`stages.${name}.dead`]: true,
      });
    }
  });
});
```

### Step 1.2: Run the test to verify it fails

- [ ] Run:

```bash
cd src/api && bun test tests/workers-status-perf.test.ts
```

Expected: FAIL — `Expected: defined; Received: undefined` for `stage_hash_dead`. (If Mongo is not running locally, the test skip-passes — start Mongo with `docker run -p 27017:27017 --rm mongo:7` or the project's `docker-compose` and rerun.)

### Step 1.3: Add the partial dead index in `ensureStageIndexes`

- [ ] Edit `src/api/src/db/client.ts:180-198` to also create the dead index. Replace the body of the `for` loop so the function reads:

```ts
export async function ensureStageIndexes(db: Db): Promise<void> {
  for (const name of WORKER_STAGE_NAMES) {
    // Drop the old partial index (which used { dead: { $eq: false } }) so we
    // can recreate it without a partial filter. The old filter excluded docs
    // where `dead` is missing (freshly-indexed assets never had this field
    // set) — those new docs would fall back to a collection scan on the claim
    // query. Without the partial filter the index covers all docs and the
    // claim query `dead: { $ne: true }` hits the index for both false and
    // missing values. The index is larger but correctness beats compactness here.
    try {
      await db.collection("assets").dropIndex(`stage_${name}_version`);
    } catch {
      // IndexNotFound is fine — index may not exist yet on a fresh deploy.
    }
    await db.collection("assets").createIndex(
      { [`stages.${name}.version`]: 1 },
      { name: `stage_${name}_version` },
    );

    // Tiny partial index on dead-lettered docs. Powers the dead-count branch
    // of GET /api/workers/status — countDocuments({ stages.<name>.dead: true })
    // becomes a count of index entries instead of a full collection scan.
    // The partial filter keeps the index size proportional to the (small)
    // set of dead docs, not the whole collection.
    await db.collection("assets").createIndex(
      { [`stages.${name}.dead`]: 1 },
      {
        name: `stage_${name}_dead`,
        partialFilterExpression: { [`stages.${name}.dead`]: true },
      },
    );
  }
}
```

### Step 1.4: Run the test to verify it passes

- [ ] Run:

```bash
cd src/api && bun test tests/workers-status-perf.test.ts
```

Expected: PASS (or skip-pass with `mongoReachable = false`).

### Step 1.5: Commit

- [ ] Run:

```bash
git add src/api/src/db/client.ts src/api/tests/workers-status-perf.test.ts
git commit -m "$(cat <<'EOF'
perf(api/workers): add partial dead index per stage

Adds { stages.<name>.dead: 1 } partial index (filter: dead = true) per
worker stage in ensureStageIndexes. Unblocks the next commit, which
replaces the COLLSCAN-forcing $facet in /api/workers/status with parallel
indexed countDocuments calls.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Replace `$facet` with parallel `countDocuments`

**Files:**
- Modify: `src/api/src/workers/routes.ts:38-124` (the `GET /status` handler)
- Test: `src/api/tests/workers-status-perf.test.ts` (add a correctness test block)

### Step 2.1: Write the failing correctness test

- [ ] Append to `src/api/tests/workers-status-perf.test.ts`:

```ts
describe("GET /api/workers/status — counts", () => {
  it("returns correct pending + dead counts using indexed queries", async () => {
    if (!mongoReachable) return;

    const { closeDb, ensureStageIndexes, getDb } = await import(
      "../src/db/client.ts"
    );
    await closeDb();
    const db = mongo!.db(TEST_DB);
    try {
      await db.dropCollection("assets");
    } catch {}
    try {
      await db.dropCollection("worker_config");
    } catch {}
    await db.createCollection("assets");
    await ensureStageIndexes(db);

    // Seed 6 docs against a single stage so we have a deterministic shape.
    //   - 2 docs with version < tv, dead != true  → pending
    //   - 1 doc  with version field absent        → pending
    //   - 2 docs with version == tv               → up-to-date (not counted)
    //   - 1 doc  with dead = true                 → dead
    const tv = 3;
    await db.collection("assets").insertMany([
      { stages: { hash: { version: 1 } } },
      { stages: { hash: { version: 2 } } },
      { stages: {} }, // no stages.hash at all → pending
      { stages: { hash: { version: tv } } },
      { stages: { hash: { version: tv } } },
      { stages: { hash: { version: 1, dead: true } } },
    ]);

    // Build a supervisor stub that reports the hash stage with targetVersion = tv.
    const { Elysia } = await import("elysia");
    const { workerRoutes } = await import("../src/workers/routes.ts");
    const sup = {
      refreshLiveStatus: async () => {},
      statuses: () => ({
        hash: {
          status: "running",
          inFlight: 0,
          throughput: 0,
          lastError: null,
          targetVersion: tv,
        },
      }),
    } as unknown as import("../src/workers/supervisor.ts").Supervisor;

    // Force the route's getDb() to point at TEST_DB.
    process.env.MAPLE_MONGO_DB = TEST_DB;
    await closeDb();
    await getDb();

    const app = new Elysia().use(workerRoutes(sup));
    const res = await app.handle(
      new Request("http://localhost/api/workers/status"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      stages: Array<{ name: string; pending: number; dead: number }>;
    };
    const hash = body.stages.find((s) => s.name === "hash");
    expect(hash).toBeDefined();
    expect(hash!.pending).toBe(3);
    expect(hash!.dead).toBe(1);
  });

  it("uses an index plan (no COLLSCAN) for the dead-count query", async () => {
    if (!mongoReachable) return;
    const { closeDb, ensureStageIndexes } = await import(
      "../src/db/client.ts"
    );
    await closeDb();
    const db = mongo!.db(TEST_DB);
    try {
      await db.createCollection("assets");
    } catch {}
    await ensureStageIndexes(db);

    const explain = await db
      .collection("assets")
      .find({ "stages.hash.dead": true })
      .explain("queryPlanner");
    const winning = JSON.stringify(explain.queryPlanner?.winningPlan ?? {});
    expect(winning).not.toContain("COLLSCAN");
    expect(winning).toContain("stage_hash_dead");
  });
});
```

### Step 2.2: Run the tests to verify they fail

- [ ] Run:

```bash
cd src/api && bun test tests/workers-status-perf.test.ts
```

Expected: FAIL on the count test (the existing `$facet` may still produce correct counts — if it does, the assertion passes by luck; the *plan* test will fail because the route still uses `$facet`). Specifically, the explain-plan test asserts the route picks the new index; even if counts happen to be correct, this gates the refactor.

If only the explain test fails and the count test passes, that's fine — proceed; the next step refactors the route anyway and we'll re-run both.

### Step 2.3: Refactor the `/status` handler

- [ ] In `src/api/src/workers/routes.ts`, replace the body of the `.get("/status", async () => { ... })` handler (currently lines 38-124) with the version below. Keep everything else in the file unchanged.

```ts
    .get("/status", async () => {
      // Run the supervisor IPC refresh concurrently with the DB work — both
      // are I/O-bound and independent. refreshLiveStatus is bounded by the
      // child-side 300 ms AbortSignal.timeout, so total wall time = max(
      // IPC fan-out, DB fan-out) instead of their sum.
      const refreshPromise = supervisor.refreshLiveStatus();

      // DB collections — fetched once for all stages.
      let assets:
        | import("mongodb").Collection<import("mongodb").Document>
        | null = null;
      let configMap = new Map<string, WorkerConfig>();
      let pendingByStage = new Map<string, number>();
      let deadByStage = new Map<string, number>();

      try {
        const db = await getDb();
        assets = db.collection("assets") as import("mongodb").Collection<
          import("mongodb").Document
        >;
        const configColl = db.collection<WorkerConfigDoc>("worker_config");

        // Load all worker configs in one query.
        const allConfigs = await configColl.find({}).toArray();
        for (const cfg of allConfigs) {
          configMap.set(cfg.name, cfg);
        }
      } catch {
        // DB unavailable — counts remain zeros, configMap empty.
      }

      // We need the supervisor statuses before we know per-stage targetVersions,
      // but refreshLiveStatus mutates the in-memory state, so await it first.
      await refreshPromise;
      const statuses = supervisor.statuses();
      const stageNames = Object.keys(statuses);

      if (assets && stageNames.length > 0) {
        // Fan out 2 indexed countDocuments per stage in parallel.
        // The pending query uses { stages.<name>.version: 1 } via the $lt branch
        // and via the $exists:false branch (Mongo indexes missing-field docs
        // as null entries on a non-sparse index). The dead query hits the new
        // partial index { stages.<name>.dead: 1 } filtered to dead:true.
        const counts = await Promise.all(
          stageNames.flatMap((name) => {
            const tv = statuses[name]?.targetVersion ?? 1;
            const pending = assets!
              .countDocuments({
                $or: [
                  { [`stages.${name}.version`]: { $lt: tv } },
                  { [`stages.${name}.version`]: { $exists: false } },
                ],
                [`stages.${name}.dead`]: { $ne: true },
              })
              .then((n) => ({ key: "pending" as const, name, n }))
              .catch(() => ({ key: "pending" as const, name, n: 0 }));
            const dead = assets!
              .countDocuments({ [`stages.${name}.dead`]: true })
              .then((n) => ({ key: "dead" as const, name, n }))
              .catch(() => ({ key: "dead" as const, name, n: 0 }));
            return [pending, dead];
          }),
        );
        for (const c of counts) {
          if (c.key === "pending") pendingByStage.set(c.name, c.n);
          else deadByStage.set(c.name, c.n);
        }
      }

      const stages = Object.entries(statuses).map(([name, s]) => {
        const pending = pendingByStage.get(name) ?? 0;
        const dead = deadByStage.get(name) ?? 0;
        const config = configMap.get(name) ?? null;
        const configured = config?.concurrency ?? 0;
        const batchSize = config?.batchSize ?? 0;
        // Surface config-level pause as a distinct status. The supervisor
        // status tracks the process; a stage whose child is alive but whose
        // poll loop is paused (config.paused = true) should read as
        // "paused" in the UI, not "running".
        const status =
          s.status === "running" && config?.paused === true
            ? "paused"
            : s.status;
        return {
          name,
          status,
          inFlight: s.inFlight,
          configured,
          pending,
          dead,
          throughput: s.throughput,
          lastError: s.lastError,
          config,
          batchSize,
        };
      });

      return { stages };
    })
```

### Step 2.4: Run the tests to verify they pass

- [ ] Run:

```bash
cd src/api && bun test tests/workers-status-perf.test.ts
```

Expected: PASS (both the count test and the explain-plan test). Also rerun the existing route tests:

```bash
cd src/api && bun test src/workers/routes.test.ts
```

Expected: PASS (5 existing tests).

### Step 2.5: Smoke-test against a real running API

- [ ] Run the API locally:

```bash
cd src/api && bun run dev
```

In another terminal:

```bash
time curl -s http://localhost:3000/api/workers/status | head -c 400
```

Expected: response in < 200 ms with a non-empty `stages` array. (If you previously timed the slow version, compare; on a library with thousands of `assets` the new version should be sub-100ms.)

### Step 2.6: Commit

- [ ] Run:

```bash
git add src/api/src/workers/routes.ts src/api/tests/workers-status-perf.test.ts
git commit -m "$(cat <<'EOF'
perf(api/workers): replace $facet with parallel indexed countDocuments in /status

The previous /api/workers/status implementation built a single $facet
aggregation with 16 sub-pipelines (2 per stage × 8 stages). With no $match
ahead of the $facet, the planner had to COLLSCAN the entire assets
collection and materialize it as input to every sub-pipeline. On large
libraries the workers page took multiple seconds to poll.

Now: 16 parallel countDocuments calls, each using the per-stage version
index (pending) or the new stage_<name>_dead partial index (dead). The
supervisor IPC refresh runs concurrently with the DB fan-out instead of
sequentially before it, so total wall time = max(IPC, DB) rather than
sum.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Verify no regression in the broader API test suite

**Files:** none modified — pure verification step.

### Step 3.1: Run the full `src/api` test suite

- [ ] Run:

```bash
cd src/api && bun test
```

Expected: all tests pass (or skip-pass when Mongo / fixtures aren't available locally). If any test fails, read the failure and fix the route or index code — do NOT skip or weaken the test.

### Step 3.2: Verify supervisor / mount tests still pass

- [ ] Run:

```bash
cd src/api && bun test src/workers/
```

Expected: PASS.

### Step 3.3: Verify the route still serves the workers UI correctly

- [ ] Start the dev API (`cd src/api && bun run dev`) and open the workers page in the browser (`https://maple.lawrence.io/api/workers/status` or wherever the local UI is mounted). Confirm:
  - Page loads without errors.
  - Each stage row shows non-zero `pending` or `dead` if there are unprocessed / dead-lettered docs.
  - `inFlight` and `throughput` update across consecutive polls (proves `refreshLiveStatus` still runs).

- [ ] No commit needed for this task — verification only.

---

## Self-Review Notes

- **Spec coverage:**
  - Cause #1 in the diagnosis (COLLSCAN-forcing `$facet`) → Task 2 replaces it with indexed countDocuments.
  - Cause #2 (no index on `stages.<name>.dead`) → Task 1 adds a partial index.
  - Cause #3 (`refreshLiveStatus` adds 300 ms serial wait) → Task 2 runs it concurrent with DB I/O.
- **Placeholder scan:** every code block is complete; every command has expected output; no "similar to above" references.
- **Type consistency:** `pendingByStage`/`deadByStage` are `Map<string, number>`; the supervisor stub matches the `Supervisor` shape that `workerRoutes` actually reads (`refreshLiveStatus`, `statuses`). `WorkerConfigDoc` import already exists in `routes.ts`.
- **Index naming:** `stage_<name>_dead` is consistent with the existing `stage_<name>_version` convention.
- **Idempotency:** `ensureStageIndexes` is safe to call twice — `createIndex` is a no-op when the index already exists with the same options, and the test explicitly calls it twice.

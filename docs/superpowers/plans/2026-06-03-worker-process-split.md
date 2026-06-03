# Worker-Tier Process Split — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** Move the entire worker tier (8 stages + import + discover + job runner + maintenance + enrichment + FFI pool) out of the API process into a single niced **worker child process**, so the API event loop can never be starved or crashed by worker load. Then isolate the non-RAW decode (sharp + HEIC) into a decode child so a poison image can't restart the worker tier either. Closes #890.

**Architecture:** API process = Elysia (UI + routes) + auth + uploads + SSE change-feed tailer + meili _search_ client + otel. It spawns ONE worker child via the existing `ChildProcessWorker` transport (`runtime/child-process-worker.ts`), gated by `MAPLE_INDEXER_AUTOSTART`. The worker child runs `startWorkers()` and talks to the API only through Mongo (claim queue, asset docs, `asset_changes`→SSE, `worker_config`→pause, a new `worker_status` doc→status page). Reverts the #135 single-process collapse for the worker tier.

**Tech Stack:** Bun + Elysia + MongoDB. Tests: `cd src/api && MAPLE_MONGO_URI=mongodb://127.0.0.1:27077 bun test <path>`. **Never pipe bun/test output through `tail`/`head`** (watchdog kills piped commands). `bun install` needs `HOME=/tmp/x` (socket scanner). A throwaway `mongod` runs on :27077.

---

## Boot boundary (from `src/api/src/index.ts` boot IIFE, ~lines 288–440)

**Moves into `startWorkers()` (the worker process):** `startAllStages`, discover startup (call `startDiscover` IN-PROCESS — no more `sweeper.child` spawn), `sweepOrphanedCaches` cache-gc, `bootstrapFfiPool`, `startGeocodeWorker`, `startFaceWorker`, `startDescribeWorker`, the meili **stage-side** `reconfigureMeilisearch`, `startJobRunner`, `startImportRunner`.

**Stays in the API process:** `getDb`, `ensureIndexes`, `getChangeFeedTailer().start()` (SSE), the meili **search-side** config, `initOtel`, HTTP server, auth, uploads.

---

## Phase 1 — Extract `startWorkers()`, worker entry, API spawns it (THE fix)

### Task 1: `startWorkers()` extraction

**Files:** Create `src/api/src/workers/start-workers.ts`; Modify `src/api/src/index.ts`.

- [ ] **Step 1:** Create `src/api/src/workers/start-workers.ts` exporting `async function startWorkers(): Promise<void>` and `async function stopWorkers(): Promise<void>`. Move the worker-tier boot logic out of `index.ts`'s IIFE into `startWorkers()`, preserving each `try/catch … log` block verbatim:
  - `startAllStages()` (+ `log.info(stageRegistry.statuses(), 'Worker stages running')`)
  - discover: resolve `discoverRoots` from `foldersCollection`, then **`registerDiscoverWorker()` + `await startDiscover({ roots: discoverRoots })`** in-process (do NOT spawn `sweeper.child`; import `startDiscover` from `./discover/index.ts`). Keep the `cache-gc` `sweepOrphanedCaches` loop.
  - `await bootstrapFfiPool()`
  - `startGeocodeWorker()`, `startFaceWorker()`, `startDescribeWorker()` (each in its own try/catch)
  - meili stage-side: `reconfigureMeilisearch(...)` + `ensureIndex()` (copy the block from index.ts)
  - `startJobRunner()`, `startImportRunner()`
    Move the needed imports from `index.ts` into `start-workers.ts`. `stopWorkers()` calls `stopAllStages()`, `stopJobRunner()`, `stopImportRunner()`, discover handle stop, `unregisterDiscoverWorker()` (mirror what `shutdown()` in index.ts already does for these).
- [ ] **Step 2:** In `index.ts`, DELETE the moved blocks from the boot IIFE. Leave `getDb`, `ensureIndexes`, `getChangeFeedTailer().start()`, the meili **search** config, `initOtel`. Remove the now-unused imports (startAllStages, startJobRunner, startImportRunner, bootstrapFfiPool, the enrichment-worker starts, discover spawn bits) — they live in start-workers.ts now. Keep `index.ts` compiling.
- [ ] **Step 3:** Verify the API still boots WITHOUT workers: `cd src/api && MAPLE_INDEXER_AUTOSTART=0 MAPLE_MONGO_URI=mongodb://127.0.0.1:27077 MAPLE_MONGO_DB=maple_plan_test bun src/index.ts &` → wait ~4s → `curl -s localhost:3000/api/health` returns `{"ok":true,...}` → `kill %1`. (No worker child yet — that's Task 3.)
- [ ] **Step 4:** Commit: `git commit -am "refactor(workers): extract startWorkers()/stopWorkers() out of index.ts boot"`

### Task 2: `worker-main.ts` — the worker process entry

**Files:** Create `src/api/src/workers/worker-main.ts`.

- [ ] **Step 1:** Implement (mirrors `sweeper.child.ts`'s hardening + the existing `shutdown` pattern):

```ts
/**
 * Worker process entry. Runs the entire worker tier (stages, import, discover,
 * job runner, maintenance, enrichment) OFF the API event loop. The API spawns
 * this as one niced child; a crash/runaway here can never touch the HTTP server.
 */
import { installChildHardening } from '../runtime/child-process-worker.ts';
import { getDb, ensureIndexes, closeDb } from '../db/client.ts';
import { startWorkers, stopWorkers } from './start-workers.ts';
import { initOtel } from '../observability/otel.ts'; // confirm the real path/symbol
import { resolveObservabilityConfig, loadObservabilityConfig } from '../observability/config.ts'; // confirm
import { child as childLogger } from '../log.ts';

installChildHardening('worker');
const log = childLogger('worker-main');

async function main(): Promise<void> {
  await getDb();
  try {
    await ensureIndexes();
  } catch (e) {
    log.warn({ err: e instanceof Error ? e.message : e }, 'ensureIndexes failed — continuing');
  }
  try {
    await initOtel(resolveObservabilityConfig(await loadObservabilityConfig()));
  } catch (e) {
    log.warn({ err: e }, 'otel init failed');
  }
  await startWorkers();
  log.info('worker tier started');
  const shutdown = async () => {
    try {
      await stopWorkers();
    } catch {
      /* best effort */
    }
    await closeDb();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
}
main().catch((e) => {
  process.stderr.write(`[worker-main] fatal: ${e instanceof Error ? e.message : e}\n`);
  process.exit(1);
});
```

Confirm the real import paths for `initOtel` / observability config + `stopAllStages`/`stopJobRunner`/`stopImportRunner` against the code (grep them); adjust to match. Do NOT invent symbols.

- [ ] **Step 2:** Smoke-test the worker entry standalone: `cd src/api && MAPLE_MONGO_URI=mongodb://127.0.0.1:27077 MAPLE_MONGO_DB=maple_plan_test bun src/workers/worker-main.ts &` → wait ~5s → confirm it logs `worker tier started` and stays alive (`kill %1` after). It will log "no registered folder matched" etc. on an empty DB — fine.
- [ ] **Step 3:** Commit: `git commit -am "feat(workers): worker-main.ts process entry running the worker tier"`

### Task 3: API spawns the worker child, gated by the flag

**Files:** Modify `src/api/src/index.ts`.

- [ ] **Step 1:** In `index.ts`, where the worker boot used to be, add (importing `ChildProcessWorker`, `childScriptPath`, `DEFAULT_NATIVE_CHILD_NICE` — already imported for discover):

```ts
if (process.env.MAPLE_INDEXER_AUTOSTART === '0') {
  log.info('Worker process disabled (MAPLE_INDEXER_AUTOSTART=0)');
} else {
  try {
    _workerChild = new ChildProcessWorker(
      childScriptPath(import.meta.url, './workers/worker-main.ts'),
      { nice: DEFAULT_NATIVE_CHILD_NICE, label: 'worker' },
    );
    log.info('worker process spawned');
  } catch (err) {
    log.error({ err }, 'failed to spawn worker process');
  }
}
```

Declare `let _workerChild: ChildProcessWorker | null = null;` at module scope (replace the old `_discoverChild`). In `shutdown()`, `_workerChild?.terminate()` (and remove the old `_discoverChild`/`stopAllStages`/`stopJobRunner`/`stopImportRunner` calls — those now live in the worker process, stopped via its SIGTERM when `terminate()` is called).

- [ ] **Step 2:** Add an `error` listener on `_workerChild` that logs + respawns (so a worker crash auto-recovers): on `error`, log it, null the handle, and re-spawn after a short delay (1 s) unless shutting down. Mirror the respawn shape in `ffi-pool.ts`/`face-pool.ts`.
- [ ] **Step 3:** Full boot test at `autostart=1`: start `bun src/index.ts` with `MAPLE_INDEXER_AUTOSTART=1 MAPLE_MONGO_URI=…:27077`, wait ~6 s, then: `curl -s localhost:3000/api/health` → `ok:true`; `ps aux | rg worker-main | rg -v rg` shows the spawned worker; `docker`-free — just confirm two bun processes (API + worker). Kill.
- [ ] **Step 4:** Commit: `git commit -am "feat(api): spawn the worker tier as a niced child; gate on MAPLE_INDEXER_AUTOSTART"`

### Task 4: Verify the API is insulated

- [ ] **Step 1:** With the worker running, `kill -9` the worker process → confirm the API stays up (`/api/health` still 200) and the `error`-handler respawns a new worker. This is the whole point — prove a worker death can't take the API down.
- [ ] **Step 2:** Commit any fixes; no code expected.

---

## Phase 2 — Worker status to Mongo (keep `/settings/workers` working cross-process)

### Task 5: Worker writes status; API reads it

**Files:** `src/api/src/workers/worker-status.repo.ts` (new), `start-workers.ts`, `routes-main.ts`/`routes-status.ts`.

- [ ] **Step 1:** New `worker_status` single-doc repo: `writeWorkerStatus(snapshot)` + `readWorkerStatus()`. The worker, on an interval (every ~2 s, unref'd timer started in `startWorkers()`), writes `stageRegistry.statuses()` (+ pending/ready/dead counts it already computes) to `worker_status`.
- [ ] **Step 2:** `GET /api/workers/status` in the API reads `worker_status` from Mongo instead of the (now-empty) in-process `stageRegistry`. Pause/resume already write `worker_config` (Mongo) and the worker re-reads per tick — confirm a pause toggled via the API is observed by the worker. Add a test.
- [ ] **Step 3:** Commit.

---

## Phase 3 — Isolate non-RAW decode (sharp + HEIC) into a decode child

### Task 6: non-RAW decode child

**Files:** `src/api/src/thumbs/imgdecode.child.ts` (new), convert `heic-pool` + the sharp render path to dispatch to it.

- [ ] **Step 1:** Read `src/api/src/thumbs/heic-pool.ts`, `heic.worker.ts`, and the sharp render path in `indexer/thumbnailer.ts`/`previewer.ts` (`renderImageThumbToFile`). Create a decode child (`ChildProcessWorker`) that performs the **non-RAW thumb/preview render** (the `sharp` + `heic-convert` pipeline) given `(srcPath, outPath, maxPx, quality)` and returns `{ ok, error? }` — mirroring the FFI child's `renderThumbnailJpegToFile`.
- [ ] **Step 2:** Route the non-RAW branch of `thumbnailer`/`previewer` through this child (RAW already goes to the FFI child). DELETE the `heic.worker.ts` Bun **Worker thread** (its WASM abort takes down the host — the whole reason this is a child now). A decode crash → child dies → the stage gets a rejection → `attempts++` → dead-letter after `maxAttempts`.
- [ ] **Step 3:** Tests: a child round-trip + crash-isolation (kill the child mid-call → caller gets an error, parent survives). Confirm `bun test src/thumbs src/indexer` green.
- [ ] **Step 4:** Commit.

---

## Phase 4 — Open PR + verify

### Task 7: PR

- [ ] Prettier-clean the diff (`HOME=/tmp/x bunx prettier@3.8.3 --write --config src/web/.prettierrc <changed files>`; the CI gate uses 3.8.3). Run the full `cd src/api && MAPLE_MONGO_URI=…:27077 bun test` and confirm no NEW failures vs main. Push; open PR `Closes #890` (ready, not draft); body = the #135-revert rationale + before/after (API survives a worker kill).

## Self-review notes

- **Confirm against source (don't invent):** `stopAllStages`/`stopJobRunner`/`stopImportRunner` names + the `initOtel`/observability-config import paths (Task 1/2); the discover `DiscoverHandle.stop` wiring (Task 1); the meili reconfigure block (Task 1). Each is copied from existing `index.ts` — grep it.
- **Spec coverage:** worker tier off the API ✔ (Task 1–3) · API insulated from worker death ✔ (Task 4) · flag gates the whole worker incl. import ✔ (Task 3) · status/pause cross-process ✔ (Task 5) · non-RAW decode isolated + dead-letters ✔ (Task 6).

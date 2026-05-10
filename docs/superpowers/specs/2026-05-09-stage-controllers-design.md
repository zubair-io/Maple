# Stage Controllers — Worker Architecture Redesign

Status: draft 2026-05-09. Awaiting review.

## Problem

The API runs three different worker abstractions today:

1. **Indexer pipeline** (`src/api/src/indexer/pipeline.ts`, `channel.ts`) — a single child process holds an in-memory channel topology with stages `discover → hash → exif → thumb → ai → mongo`. Stages are tightly coupled: each one feeds the next via in-process channels. The `ai` stage is a fiction — it does multiple unrelated jobs (face, OCR, describe, geocode). A crash in any stage drains the whole pipeline. Adding a stage means restructuring the channel graph.
2. **Generic job-runner** (`src/api/src/job-runner/runner.ts`) — DB-backed handler queue used for one-off jobs (model bootstrap, geocode-backfill commands, rescan enqueues).
3. **Bespoke enrichment workers** (`src/api/src/enrichment/{face,ocr,geocode,describe}-worker.ts`) — four ~300–400 line polling loops, each with its own circuit breaker, dead-letter, and config. They already do "claim a batch from Mongo, do the work, mark done" but in four different shapes.

Pain: three patterns to choose from when adding a worker. Stages of one image are tangled into a single in-memory pipeline, so a slow describe call backs up exif. Backfill is a bespoke job per stage (`exif-backfill`, `face-backfill`, `geocode-backfill`) instead of a property of the system.

## Goals

1. **One worker pattern.** Every per-image stage — hash, exif, thumb, face, OCR, describe, geocode, search-blob — runs as a stage controller with the same shape: poll Mongo for docs that need this stage and whose dependencies are satisfied, claim a batch in memory, dispatch to a worker pool, mark done, repeat.
2. **Hard fault isolation.** Each stage is its own child process. A face-detector segfault cannot take down hash. Native deps (raw-ffi, ONNX, OCR engine) load only in the processes that need them.
3. **Versioned state.** Each stage stores `version: number`, not `done: boolean`. Bumping a handler's target version is the entire backfill mechanism. `*-backfill` jobs disappear.
4. **Operator-tunable.** Per-stage `concurrency`, `pollIntervalMs`, `batchSize`, `maxAttempts` live in a `worker_config` collection and are editable from a UI page. No auto-tuning.
5. **One pane of glass.** `/settings/workers` shows every stage's status, throughput, pending count, dead-letter count, and settings link.

## Non-goals

- **Horizontal scaling across machines.** Single-box deployment is the assumption; one controller per stage means one process queries the DB. Multi-node would require per-doc leases — explicitly deferred.
- **Replacing the generic job-runner.** It stays for one-off, non-per-image work (model bootstrap, rescan-folder enqueue, admin commands). Different abstraction.
- **Replacing `discover`.** The filesystem watcher is a producer, not a consumer; it inserts new image rows and does not fit the stage-controller shape. It runs under the same supervisor with its own runtime.
- **Auto-priority across stages.** Per-stage concurrency cap is the only knob; we do not implement cross-stage scheduling fairness.
- **Reactive AI on the operator UI.** The user explicitly chose "no AI" — settings are operator-tuned values, no recommendation engine.

## Architecture

### Stage state schema

Every image doc gains a `stages` object with one entry per stage:

```ts
stages: {
  hash:     { version: 1, attempts: 0, last_error: null, last_skip_reason: null, processed_at: ISODate(...), dead: false },
  exif:     { version: 1, attempts: 0, last_error: null, last_skip_reason: null, processed_at: ISODate(...), dead: false },
  thumb:    { version: 1, attempts: 0, last_error: null, last_skip_reason: null, processed_at: ISODate(...), dead: false },
  face:     { version: 0, attempts: 0, last_error: null, last_skip_reason: null, processed_at: null,         dead: false },
  ocr:      { version: 0, attempts: 0, last_error: null, last_skip_reason: null, processed_at: null,         dead: false },
  describe: { version: 0, attempts: 0, last_error: null, last_skip_reason: null, processed_at: null,         dead: false },
  geocode:  { version: 0, attempts: 0, last_error: null, last_skip_reason: null, processed_at: null,         dead: false },
  meili:    { version: 0, attempts: 0, last_error: null, last_skip_reason: null, processed_at: null,         dead: false },
}
```

Field semantics, per stage:

| Field              | Meaning                                                                                         |
| ------------------ | ----------------------------------------------------------------------------------------------- |
| `version`          | Last version the handler ran at. Missing or `0` means "never run". Increments on success.       |
| `attempts`         | Failed attempts at the *current target version*. Reset to `0` on success or version bump.       |
| `last_error`       | Stringified error from the most recent failed attempt. Surfaces in the per-doc error list.      |
| `last_skip_reason` | The reason string passed with `{ skip }` on the most recent successful skip. `null` otherwise.  |
| `processed_at`     | Wall-clock time of the most recent successful run. Used for throughput rolling window.          |
| `dead`             | True when `attempts >= maxAttempts`. Excluded from the claim query.                             |

The schema is identical for every stage. New stages add an entry to this object — no per-stage flat-field proliferation on the doc.

### Dependency graph (initial)

Declared statically in each stage's config; the controller builds it into the claim query as `{ "stages.<dep>.version": { $gte: 1 } }`.

```
hash      → []
exif      → [hash]
thumb     → [hash, exif]                                   ← needs EXIF for orientation
face      → [thumb]
ocr       → [thumb]
describe  → [thumb]
geocode   → [exif]
meili     → [exif, thumb, face, ocr, describe, geocode]   ← fan-in, writes search blob
```

`meili` is the search-blob writer. The original pipeline's terminal `mongo` stage is dissolved — each stage writes its own slice, and `meili` does the cross-stage denormalization.

The `thumb` handler reads `image.exif.orientation` and applies the corresponding rotation/flip to the generated preview before encoding. The current thumbnailer at `src/api/src/indexer/thumbnailer.ts` does not honor EXIF orientation. That fix lands as a standalone commit against the current code *before* this redesign — orientation is a real bug today and shouldn't wait for the controller cutover. Once the redesign lands, the same `thumbnailer` function (now orientation-aware) is called by the new `thumb` handler.

### Controller contract (A1: static deps + return-value writeback)

Each stage child is a tiny config + handler file:

```ts
// src/api/src/workers/stages/exif.ts
import { defineStage } from "../runtime/define-stage";
import { readExif } from "../../indexer/exif";

export default defineStage({
  name: "exif",
  targetVersion: 1,
  dependsOn: ["hash"],
  defaults: {
    concurrency: 4,
    pollIntervalMs: 1000,
    batchSize: 10,
    maxAttempts: 5,
    pausedOnFirstBoot: false,
  },
  handler: async (image, ctx) => {
    const exif = await readExif(image.primary_url);
    return { patch: { exif } };          // runtime writes patch + bumps stages.exif
  },
});
```

Per-stage defaults — `pollIntervalMs: 1000, maxAttempts: 5` everywhere (matching the existing enrichment workers); concurrency and batchSize tuned per workload:

| Stage    | concurrency | batchSize | pausedOnFirstBoot | Reason                                                              |
| -------- | ----------- | --------- | ----------------- | ------------------------------------------------------------------- |
| hash     | 4           | 10        | false             | I/O-bound, parallelizable                                           |
| exif     | 4           | 10        | false             | I/O-bound, parallelizable                                           |
| thumb    | 2           | 5         | false             | CPU-heavy (decode + encode); cap to avoid thrashing                 |
| face     | 1           | 5         | false             | ONNX session is single-threaded                                     |
| ocr      | 1           | 5         | false             | OCR engine is single-threaded                                       |
| describe | 2           | 5         | **true**          | External paid API; requires API key setup before opt-in             |
| geocode  | 1           | 5         | **true**          | Rate-limited (1 req/s Nominatim); requires operator-set rate config |
| meili    | 2           | 20        | false             | HTTP + read-fan-in; cheap                                           |

`pausedOnFirstBoot: true` is observed only when `worker_config[name]` does not yet exist. After first boot, the operator's saved `paused` value is authoritative — re-deploying the API does not re-pause stages the operator unpaused.

The handler returns one of three shapes:

```ts
type StageResult =
  | { patch: Record<string, unknown> }   // runtime merges patch into image doc + marks done
  | { wrote: true }                       // handler did its own writes (e.g. meili sidecar collection)
  | { skip: string }                      // not an error; mark done with reason in last_skip_reason, count toward throughput
```

`{ patch }` is the default for stages whose output lives on the image doc. `{ wrote }` is the escape hatch for stages that write to a sibling collection (meili search index) — the runtime still bumps `stages.<name>.version` but does not write the patch. `{ skip }` is for "this image isn't applicable" cases (e.g. a video file in a face stage) — counts as success, no retry. The skip reason string is stored in `last_skip_reason`, not `last_error`.

Runtime hooks:

- **Throw** → caught by runtime → `attempts++`, `last_error = err.message`. If `attempts >= maxAttempts`, `dead = true`.
- **Return `{ patch }` or `{ wrote }` or `{ skip }`** → success. Runtime writes `version: targetVersion, attempts: 0, last_error: null, last_skip_reason: skipReasonOrNull, processed_at: now, dead: false`.

### Stage controller runtime

`src/api/src/workers/runtime/run-stage.ts` (~250 lines). Imported by every stage child's `index.ts`. Responsibilities:

1. **Boot.** Connect to Mongo, load `worker_config[stage.name]`, fall back to `stage.defaults`. Subscribe to a Mongo change stream on `worker_config` for live config edits.
2. **Version-bump reset.** On boot, the controller compares its `targetVersion` to `worker_config[name].last_seen_target_version`. If higher, run:
   ```js
   db.images.updateMany(
     { [`stages.${name}.version`]: { $lt: targetVersion } },
     { $set: { [`stages.${name}.dead`]: false, [`stages.${name}.attempts`]: 0, [`stages.${name}.last_error`]: null } }
   )
   ```
   Persist the new value. This realizes the "bump version → auto-reset dead" semantic.

   Cross-stage cascade is **not** automatic. If a dep's algorithm change invalidates this stage's output, the engineer who bumped the dep also bumps this stage's `targetVersion`. Tracking dep-version dependencies in code is engineer responsibility, not runtime magic.
3. **Poll loop.** On a `pollIntervalMs` timer, while the in-flight set has free slots:
   ```js
   db.images.find({
     [`stages.${name}.version`]: { $lt: targetVersion },
     [`stages.${name}.dead`]:    { $ne: true },
     ...Object.fromEntries(dependsOn.map(dep => [`stages.${dep}.version`, { $gte: 1 }])),
     _id: { $nin: [...inFlight] },
   }).limit(freeSlots).toArray()
   ```
4. **Dispatch.** Each result is added to the in-flight set and handed to a free slot in the worker pool. The pool is a fixed-size async queue.
5. **Writeback.** On worker completion: assemble `$set: { [`stages.${name}`]: {...}, ...patch }` and write atomically. Remove from in-flight set. The runtime rejects any patch whose keys start with `stages.` — stage-state ownership belongs to the runtime, not the handler.
6. **Throughput metric.** Ring buffer of recent `processed_at` timestamps; rolling 5-minute count exposed via supervisor IPC.
7. **Pause/resume.** A `paused: boolean` field on `worker_config[name]`. When true, the poll loop skips the find query (in-flight finishes drain naturally).
8. **Graceful shutdown.** SIGTERM stops new dispatches, awaits in-flight to finish (with a 30s ceiling, then SIGKILL), exits 0.

### Process model

Each stage child runs as `bun run src/api/src/workers/stages/<name>.ts`, where the file's default export is the `defineStage` config. The shared runtime is invoked by a small entry shim:

```ts
// src/api/src/workers/runtime/main.ts
import { runStage } from "./run-stage";
const stageName = process.argv[2];
const stage = await import(`../stages/${stageName}.ts`).then(m => m.default);
await runStage(stage);
```

`loadStage` validates `stageName` with a regex check (`/^[a-z][a-z0-9_-]{0,31}$/`) before the dynamic import to guard against path traversal. Additionally, `name` must be a member of `ALL_STAGE_NAMES` from `manifest.ts` — values outside the manifest are rejected even if they match the regex.

The supervisor spawns each child as `bun run src/api/src/workers/runtime/main.ts <stageName>`.

### Supervisor

`src/api/src/workers/supervisor.ts` — generalization of the existing `src/api/src/indexer/control.ts`. Lives in the API process. Owns:

- **Lifecycle.** Spawn each stage child + the discover child on API boot. Respawn on crash with exponential backoff (1s, 2s, 4s, 8s, 16s, max 30s). Mark a stage as `Status: Error` after 5 consecutive crashes; surface the last stderr in the UI.
- **IPC.** A small message channel per child for status/throughput requests, pause/resume, and shutdown. Implemented with the existing `handler-registry` HTTP transport pattern, scoped to localhost.
- **Log multiplexing.** Each child logs with pino tagged `{ controller: "<name>" }`. Supervisor pipes to the API's stdout, so existing logging infra (pino-pretty, file rotation) works unchanged.
- **API surface.** Mounts `/api/workers/status`, `/api/workers/:name/pause`, `/api/workers/:name/resume`, `/api/workers/:name/retry-dead`, `/api/workers/:name/config` (PATCH).

The existing indexer single-child supervisor is replaced by this. The only consumer of the old `control.ts` proxy was the indexer admin UI — that admin UI gets folded into `/settings/workers`.

### `discover` stage (special)

`src/api/src/workers/stages/discover.ts` does not use `run-stage` — it's a producer. It runs the existing `src/api/src/indexer/watcher.ts` polling loop, and on a new file, inserts an image doc with the `stages` skeleton:

```ts
{
  primary_url: "...",
  primary_mtime: 0,
  // ... metadata that is cheap to read at discovery
  stages: {
    hash:     { version: 0, attempts: 0, last_error: null, processed_at: null, dead: false },
    exif:     { version: 0, ... },
    thumb:    { version: 0, ... },
    face:     { version: 0, ... },
    ocr:      { version: 0, ... },
    describe: { version: 0, ... },
    geocode:  { version: 0, ... },
    meili:    { version: 0, ... },
  },
}
```

The skeleton is generated from the registered stage configs at API boot, so adding a stage automatically adds its entry. Discover writes only the skeleton; every other field on the doc is owned by a downstream stage.

### Indexes

One partial index per stage on `{ "stages.<name>.version": 1 }` with `partialFilterExpression: { "stages.<name>.dead": false }`. Mongo's `partialFilterExpression` only allows equality and a small set of comparison operators; `$ne: true` is not supported, so the equality form is required. Discover writes the skeleton with `dead: false` explicitly, so the field is always present and the partial filter always matches.

The partial filter excludes dead-lettered docs from the index — those won't appear in claim queries anyway, and they're a small minority of the collection. Keeps the index small and supports both the `$lt: targetVersion` claim predicate and the pending-count UI query.

A composite index on the meili stage's full dep set is not needed — the partial index on `meili.version` plus dep predicates on already-indexed paths is sufficient for the eligibility query.

### UI

`/settings/workers` page in the Angular shell. A row per stage:

```
  Stage      Status     Workers   In flight  Pending   Dead   Throughput   ⚙  ⏸/▶
  ─────────────────────────────────────────────────────────────────────────────
  hash       Running    4 / 4     3 / 10     1,247     0      18 /min      ⚙ ⏸
  exif       Running    4 / 4     4 / 10     1,239     0      17 /min      ⚙ ⏸
  thumb      Paused     0 / 8     0 / 10     1,239     0      —            ⚙ ▶
  face       Running    2 / 2     1 / 5      842       3 ↻    6  /min      ⚙ ⏸
  ocr        Running    2 / 2     2 / 5      842       0      4  /min      ⚙ ⏸
  describe   Error      —         —          842       0      —            ⚙   ← API key invalid
  geocode    Running    1 / 1     1 / 5      842       1 ↻    3  /min      ⚙ ⏸
  meili      Running    2 / 2     0 / 20     0         0      —            ⚙ ⏸
```

- **Status.** `Running`, `Paused`, `Error` (last child stderr surfaced as tooltip).
- **Workers.** `<active>/<configured>`.
- **In flight.** `<dispatched but not yet done>/<batchSize>`.
- **Pending.** Result of the claim-query count. The headline metric.
- **Dead.** Count of `dead: true` docs. `↻` icon when > 0; click to reset all dead docs for this stage (`updateMany({ ..., dead: true }, { $set: { dead: false, attempts: 0, last_error: null } })`).
- **Throughput.** Rolling 5-minute completions per minute.
- **⚙.** Opens settings dialog: `concurrency`, `pollIntervalMs`, `batchSize`, `maxAttempts`. Persisted to `worker_config`. Picked up by the running controller via change stream — no restart.
- **⏸/▶.** Toggles `paused` in `worker_config`.

The page polls `/api/workers/status` every 2 seconds. Supervisor responds with the aggregated status from each child's IPC plus the pending/dead counts (one count query per stage, ~9 queries total against well-indexed predicates — cheap).

### Versioning + auto-backfill semantics

Bumping a handler's `targetVersion` is the only backfill mechanism:

1. Engineer edits the handler file, increments `targetVersion`, deploys.
2. On controller boot, the version-bump-reset routine runs (see "Stage controller runtime" step 2). All non-dead docs at the lower version become eligible; previously-dead docs at the lower version are reset and become eligible.
3. The poll loop processes them like any other pending work.

`*-backfill` jobs in the existing job-runner (`face-backfill`, `geocode-backfill`, `exif-backfill`) are removed. The "rescan folder" feature, which today enqueues backfill jobs, is rewritten to do `updateMany({ folder match... }, { $set: { "stages.<name>.version": 0, "stages.<name>.dead": false } })` for each affected stage.

**On version bump, dead docs auto-reset.** This is the user-chosen behavior: a new version is presumed to fix the failure mode, so previously-dead docs get a fresh `maxAttempts` budget. If v4 hits the same failure they'll be marked dead again.

### Pause/resume + concurrency change semantics

- **First boot.** When `worker_config[name]` is absent, the controller writes `{ ...defaults, paused: stage.defaults.pausedOnFirstBoot }`. Subsequent boots respect the saved `paused` value, so re-deploying does not re-pause an unpaused stage.
- **Pause.** Poll loop short-circuits. In-flight docs finish naturally. UI shows `Paused`.
- **Resume.** Poll loop resumes next tick.
- **Concurrency increase.** Worker pool grows immediately; next tick can dispatch up to the new size.
- **Concurrency decrease.** Pool shrinks logically (no new dispatches above the new cap); in-flight above the cap drains naturally.
- **Batch size / poll interval change.** Picked up at the next tick.

### Migration

No migrator. Existing image docs without a `stages` field are picked up naturally — Mongo's `$lt` treats a missing field as less than any number, so the claim query matches them and each controller re-processes them at `targetVersion: 1`. We accept the cost of re-running every stage on every existing image, including paid stages (describe, geocode), as a one-time operator decision.

The first thing each new controller does on first boot is set `worker_config[<name>] = { ...defaults, paused: defaults.pausedOnFirstBoot }` if absent. That's the only setup write needed. Paid/rate-limited stages (`describe`, `geocode`) are paused-by-default — see the defaults table in the controller contract section.

### What gets retired

- `src/api/src/indexer/pipeline.ts` (650 lines) — in-memory channel orchestration.
- `src/api/src/indexer/channel.ts` (202 lines) — channel primitive.
- `src/api/src/indexer/service.ts` (688 lines) — most of it; the parts that survive (progress broadcast, gc) move into the supervisor or are reimplemented per-stage.
- `src/api/src/indexer/standalone.ts` (359 lines) — the indexer-as-single-child entrypoint; replaced by per-stage entry shim + supervisor.
- `src/api/src/enrichment/{face,ocr,describe,geocode}-worker.ts` (~1,400 lines total) — collapse to ~50-line `defineStage` files each. Their existing test files become handler-level unit tests.
- `*-backfill` job handlers in `src/api/src/job-runner/handlers/`.

### What stays

- `src/api/src/job-runner/` — unchanged. Used for one-shot non-per-image work.
- `src/api/src/handler-registry/` — used by the supervisor for IPC.
- `src/api/src/indexer/watcher.ts` — moved into `discover` stage, otherwise unchanged.
- `src/api/src/indexer/exif.ts`, `thumbnailer.ts`, `id.ts` — pure logic, called by the new handlers.
- `src/api/src/enrichment/circuit-breaker.ts`, `dead-letter.repo.ts`, `coordinate-cache.ts`, etc. — utility modules used by handlers.
- `src/api/src/enrichment/face-detector.ts`, `ocr-engine.ts`, `meilisearch-client.ts`, `nominatim-client.ts` — pure modules called by handlers.

## Testing

- **Runtime unit tests.** `run-stage.ts` is tested with a mock Mongo client and a synthetic handler. Cases: claim respects deps, version bump resets dead, max-attempts trips dead, pause short-circuits poll, concurrency change drains correctly, throw → attempts++, throw past maxAttempts → dead.
- **Per-stage handler tests.** Existing tests for `face-worker.test.ts`, `ocr-worker.test.ts`, etc. are rewritten as direct handler invocations: build an image doc, call the handler, assert the returned `{ patch }`. Faster and more focused than the old polling-loop tests.
- **Supervisor integration test.** Spawn a tiny stage child, send pause/resume/SIGTERM, kill it, assert respawn with backoff.
- **No mocks for the indexer↔Mongo seam.** Use the existing test-Mongo fixture pattern.
- **Thumb EXIF-orientation regression test.** Fixture image with non-default orientation; assert generated preview is upright.

## Risks

1. **Mongo change stream availability.** Live `worker_config` re-read uses change streams. Self Hosted MongoDB defaults to a standalone (no replica set) — change streams require a replica set. Mitigation: detect standalone at boot, fall back to a 5-second polling loop on `worker_config`.
2. **Per-stage process count.** With 8 stage-controller children (hash, exif, thumb, face, ocr, describe, geocode, meili) plus the discover producer plus the API process, that's 10 Bun processes per host. Memory footprint must be checked on a small VPS. Mitigation: every controller process loads only its own native deps. Hash/exif/thumb/discover share the raw-ffi dylib; face loads ONNX; OCR loads its engine; describe is HTTP-only; geocode is HTTP-only; meili is HTTP-only. Quick benchmark required before merge.
3. **In-flight set memory.** `inFlight` is `Set<ObjectId>` of size `concurrency * batchSize`. At default `concurrency: 4, batchSize: 10` that's 40 ids per stage — trivial. Even with `concurrency: 64`, it's 640 ids. Not a concern.
4. **First-boot reprocess cost.** With no migrator, every non-paused controller re-processes every existing doc on first boot. For local stages this is hours of CPU and is operator-accepted. For paid/rate-limited stages (`describe`, `geocode`), `pausedOnFirstBoot: true` is the mitigation — they don't run until the operator unpauses, which they'd need to do anyway to enter API keys / configure rate limits.

## Open questions

- **Should `discover` itself have a `stages.discover` entry?** Currently no — it's a producer, not a consumer. If we ever want to track "this image has been re-checked for FS changes since timestamp T," we may need one. Defer.
- **Should `worker_config` live in a separate collection or in the existing `indexer-config`?** New collection `worker_config` is cleaner; old `indexer-config` becomes legacy and gets a migration entry.
- **Cross-stage scheduling.** If thumb is starving face, today's answer is "bump face's concurrency." We'll see whether per-stage concurrency caps are sufficient in practice.

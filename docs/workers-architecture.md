# Indexer pipeline architecture

Status: design overview · last updated 2026-05-07

This doc describes the indexer pipeline in `src/api/src/indexer/` — how it's shaped, why, and where it can be extended without a rewrite. It exists to answer: **can we add new worker types into the current pipeline, or do we need to redesign?**

## TL;DR

The indexer pipeline is the only subsystem in Maple with a real notion of "worker types." It is a six-stage MPSC pipeline (`discover → hash → exif → thumb → ai → mongo`) with bounded channels, per-stage worker pools, retry/backoff, dead-letter, and live operational levers. Roughly 2000 LOC.

**Recommendation: extend, don't redesign.** The pipeline was built for new stages — adding one is a ~100-line diff that touches a handful of well-defined extension points. Two extension flavors do *not* fit the pipeline shape and should be built as sibling subsystems instead: long-running user-triggered jobs (export, batch reprocess), and external/pluggable handlers (third-party AI). Both reuse the pipeline's existing handler slots; neither replaces it.

The detailed analysis is in §8–10. The recommendation is in §11.

## 1. Shape

A linear, six-stage pipeline:

```
discover → hash → exif → thumb → ai → mongo
                                          ↑
                            removes/renames bypass to here
```

Each stage is three things:

1. A bounded async channel (`BoundedQueue<PipelineJob>`) with a fixed capacity.
2. A pool of `async` worker tasks reading from that channel and pushing into the next.
3. A handler function (default + override) that does the stage's actual work.

The whole thing is owned by a single `Pipeline` class in `pipeline.ts` that wires the channels, spawns the workers, tracks counters, exposes a status snapshot, and supports `start / stop / pause / resume / setPool`.

A job is dispatched by a single producer — the filesystem watcher — and progresses through the stages in arrival order, mostly. Removals and renames bypass `hash → exif → thumb → ai` and go straight from `discover` to `mongo`.

## 2. The bounded channel

`channel.ts` implements a minimal MPSC bounded queue with explicit backpressure:

- `push(item)` resolves immediately if a buffer slot is free, otherwise awaits until a consumer drains one.
- `take()` returns an async iterator. Multiple consumers share one channel; each `next()` call hands one item to one awaiter.
- `close()` rejects pending pushers and resolves pending takers with `{done: true}`. Workers exit their loop and the stage shuts down cleanly.

Capacities are tuned conservatively to force backpressure before memory bloat:

```
discover: 256   hash: 256   exif: 256   thumb: 128   ai: 128   mongo: 256
```

The channel implementation is ~100 LOC and has no dependencies. It's the substrate that everything else stands on, so changes here ripple — leave it alone unless you have a measured reason.

## 3. Pool sizes

`poolSizes()` derives concurrency from CPU count, with stage-specific reasoning baked into source comments:

```
discover: 4                          // I/O-bound, fixed
hash:     cpus/2                     // CPU + small I/O
exif:     cpus/2                     // exifr is async
thumb:    1                          // sync FFI, see below
ai:       min(2, max(1, cpus/4))     // stub today
mongo:    8                          // network-bound to Mongo
```

The `thumb: 1` cap is the only stage that actively trades latency for stability. The thumb handler calls into `bun:ffi`, which is **synchronous from JavaScript** — the symbol call pins the worker's JS thread for 50–200 ms per RAW. Multiple thumb workers don't add throughput (they serialize on the dylib) but they *do* starve the main HTTP thread of event-loop time, eventually causing `/api/*` timeouts under sustained indexer load. So the default is one, with `setPool("thumb", n)` available when the API is idle.

Channel capacity and pool size are independent levers. Capacity controls how much memory is allowed to buffer between stages; pool size controls how many jobs are processed in parallel inside a stage.

## 4. Job shape — `PipelineJob`

A single job accumulates fields as it moves down the pipeline:

| Stage | Adds | Clears |
|-------|------|--------|
| `discover` | `kind`, `folderId`, `absPath` | — |
| `hash` | `sha1Head`, `size`, `mtime`, `headBytes` | — |
| `exif` | `capturedAt`, `cameraSerial`, `shutterCount`, `exif`, finalises `mapleId` | `headBytes` |
| `thumb` | (side-effect on disk; no job mutation by default) | — |
| `ai` | `faces`, `aiTags` (today: empty arrays — pass-through stub) | — |
| `mongo` | (side-effect on MongoDB; terminal stage) | — |

This accumulating shape is convenient — every later stage has access to everything earlier stages produced. It's also a soft architectural risk: as more stages are added, `PipelineJob` grows. At ~30+ fields the case for splitting into per-stage payload types gets strong, but we are not there yet.

`kind` is `"index" | "remove" | "rename"`. Removals and renames carry only a path, bypass most of the pipeline, and short-circuit at `mongo`.

## 5. Handler extension surface

Stages can be customized via `PipelineHandlers`:

```ts
interface PipelineHandlers {
  readHead?:      (absPath: string) => Promise<Uint8Array>;
  readExif?:      (job: PipelineJob) => Promise<void>;
  generateThumb?: (job: PipelineJob) => Promise<void>;
  runAi?:         (job: PipelineJob) => Promise<void>;
  upsertMongo?:   (job: PipelineJob) => Promise<void>;
}
```

This is **functional composition, not plugin registration**. Tests pass mock handlers; production omits overrides and gets the defaults. There is no runtime "discover all installed stages." Adding a stage is a code change, not a config change — see §8.

The handlers are deliberately narrow: they take a job, mutate it, and return. They do not return new jobs, do not push downstream themselves, do not control flow. The pipeline owns the wiring; the handler owns the work.

## 6. Failure model

Inside `withRetry()`:

- Each handler call is retried up to `MAX_ATTEMPTS = 3` with exponential backoff (`100ms × 2^(attempt-1)` → 100ms, 200ms, 400ms).
- On final failure, the job moves to a `dead_letter` MongoDB collection with `{ key, stage, absPath, error, attempts }`. The `key` is `mapleId` if known, otherwise `absPath`.
- Failure of one job never blocks subsequent jobs in the same stage. The worker increments error counters and moves on.

Two things to know:

1. There is no UI for inspecting the dead-letter collection today. It's a sink, not a triage surface. Worth fixing before any third-party handlers ship — silent failure with retries that all fail is the worst of both worlds.
2. Retries are *per-handler*, not *per-pipeline*. A failure in the `exif` stage does not re-run `hash`. This is correct for idempotency but matters when a downstream stage corrupts state that an upstream stage produced — that situation does not exist today, but is the kind of thing to watch for.

## 7. Operational levers

Live-tunable via the `IndexerService` HTTP routes:

- `setPool(stage, n)` — grow a stage's pool. Shrinking is natural as workers drain on close; the implementation grows only.
- `pause()` / `resume()` — workers gate *after* `take()` and *before* processing, so pause is effective per-job, not per-batch. In-flight work already underway completes; nothing new starts until resume.
- `status()` — depth/capacity per channel, in-flight + errors + dead-letter per stage, currently-processing paths (capped at 64), processed counts.

Process-local state: counters reset on restart. Persistent state: jobs in the `assets`, `dead_letter`, and `checkpoint` collections survive restarts. The watcher resumes from checkpoint on boot.

## 8. Adding a new stage — worked example

A `phash` (perceptual hash) stage between `thumb` and `ai`:

The diff touches seven files/spots:

1. **`channel.ts`** — add `"phash"` to the `Stage` union, add `phash: ...` to `CHANNEL_CAPACITY` and `poolSizes()`.
2. **`pipeline.ts: PipelineChannels`** — add `phash: BoundedQueue<PipelineJob>`.
3. **`pipeline.ts: createChannels()`** — add `phash: createBoundedQueue<PipelineJob>(CHANNEL_CAPACITY.phash)`.
4. **`pipeline.ts: PipelineJob`** — add `phash?: string`.
5. **`pipeline.ts: Pipeline`** — add `phash: { inFlight: 0, errors: 0, deadLetter: 0 }` to `counters` and to all the other per-stage records (`inFlight`, `processedCounts`); add a `runPhash(job)` private method; call `spawnStage("phash", ...)` from `start()`; add a `case "phash"` in `channelFor()`.
6. **`pipeline.ts: PipelineHandlers`** — add `phash?: (job) => Promise<void>` if you want a test override.
7. **Wire upstream/downstream** — `runThumb` pushes into `this.channels.phash` instead of `this.channels.ai`; `runPhash` pushes into `this.channels.ai`.

That's it. Retry, dead-letter, status, pause/resume, pool resize, and counters all work without touching them. ~100 lines of code, mostly mechanical.

The pattern scales fine to 8–10 stages. Past that, the long parade of `runX` methods and the long switch in `channelFor()` start to bite. At that point the §11 refactor (data-driven stage list) is worth a half-day; not before.

## 9. What does NOT fit the pipeline

The streaming pipeline assumes:

- One job in, one job out (or one onto the next stage).
- Jobs are small, uniform, and processed in roughly arrival order.
- Failure is per-job, not per-batch.
- Progress is implicit (the job moved down the pipeline) rather than explicit (this job is 47% done).
- Jobs are produced by a watcher, not by user request with a tracked id.

A "batch export 5,000 RAWs to JPEG with a cancel button and progress bar" has none of those properties. Trying to model that as a pipeline stage warps the pipeline: now you need cancellation tokens, checkpointing of partial progress, request-scoped status, multi-output fan-out. None of that pays back when the watcher-driven indexer doesn't need it.

The right shape for user-triggered long-running work is a **sibling subsystem** — a job runner with persisted job documents, progress reporting, and a status route. It can reuse the FFI pool for the heavy lifting. It is *adjacent to* the indexer, not part of it.

If a request lands to add export-style work, do not push it through the pipeline. Build the JobRunner.

## 10. External / pluggable handlers

There is no plugin layer in the indexer today. Every handler is in-process TypeScript. If a customer or third party wants to drop in their own face detector or AI tagger, you need:

- **A handler contract.** A stable JSON-in / JSON-out shape, narrower than `PipelineJob` to avoid coupling consumers to an internal type. Versioned.
- **A transport.** Subprocess (stdin/stdout JSON), HTTP webhook to a customer-hosted endpoint, or sandboxed WASM module. Each has different latency, security, and ops trade-offs. HTTP is the cheapest first step.
- **A registry.** Config (Mongo doc) mapping stage names to handler implementations: `{ stage: "ai", impl: "builtin" }` vs `{ stage: "ai", impl: "http", url: "..." }`.
- **An adapter.** The existing `runAi(job)` becomes a router that looks up the configured impl and dispatches. The pipeline's shape does not change — only one of its handler slots becomes polymorphic.

This is a new layer **above** the pipeline, not a replacement for it. Estimate: ~500–800 LOC for an HTTP-transport MVP, no sandboxing, one stage. Sandboxing (WASM, subprocess isolation) doubles that.

Two prerequisites worth doing first, regardless: (a) a dead-letter inspection route, so plugin failures are visible; (b) a structured logger (the source notes a `TODO(T7-logger)` for pino) so failure patterns can be diagnosed across many tenants.

## 11. Recommendation and risks

**Extend the current architecture. Don't redesign.**

Concretely:

For new indexer stages — add them in-place using §8. Defer the data-driven refactor (below) until you have ≥10 stages.

For long-running / user-triggered jobs — build a sibling **JobRunner** subsystem (§9). Reuse the FFI pool. Don't bend the pipeline.

For external/pluggable workers — add a **handler registry layer** above the pipeline (§10). Start with HTTP transport for one stage (probably `ai`); generalize once the contract has shipped real production traffic.

**Risks worth tracking on the extend path.**

`PipelineJob` field bloat. Each new stage adds fields. Past ~30 fields, splitting into per-stage payload types is a maintenance win. Today the field count is ~13.

Runner-loop duplication. `Pipeline.spawnStage()` and `Pipeline.spawnOne()` duplicate the worker loop body. Fold them into one if you're already in there for a stage refactor.

No dead-letter UI. Plugins that fail will silently land in `dead_letter`. A status route showing the last N rows per stage is cheap and worth doing before the AI stage gets real handlers.

**Optional refactor when stage count justifies it.** Make the stage list data-driven:

```ts
interface StageDef<J> {
  name: string;
  capacity: number;
  poolSize: number;
  next: string | null;             // or fan-out
  handler: (job: J) => Promise<void>;
}

class Pipeline<J> {
  constructor(stages: StageDef<J>[]) { ... }
}
```

This keeps all the existing channel + retry + status + pause logic; it just makes adding a stage a config change instead of a six-file diff. Half-day refactor when it pays back, not before.

## 12. Where to read next

`src/api/src/indexer/pipeline.ts` — the canonical reference, including the `withRetry` policy and the `spawnStage` / `spawnOne` runner loops.

`src/api/src/indexer/channel.ts` — the bounded MPSC implementation and the per-stage capacities.

`src/api/src/indexer/service.ts` — `IndexerService` ownership of the pipeline, watcher wiring, HTTP route handlers.

`src/api/src/ffi/ffi-pool.ts` — what the `thumb` handler delegates to. Read the comment at the top before changing the `thumb: 1` pool default.

`docs/architecture.md` — overall system architecture; this doc is the indexer-pipeline zoom-in.

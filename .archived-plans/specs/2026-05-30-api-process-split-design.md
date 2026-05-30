# API process-split design — keep request serving off the background-CPU loop

**Ticket:** #709 (KTLO). **Status:** design / decision framework — no code in this ticket.
**Sibling tickets:** #706 (quick wins + lag probe), #707 (ONNX → worker), #708 (HEIC → worker), #710 (clustering marshaling).
**Date:** 2026-05-30. **Rev 2** — incorporates design-review feedback (config-sync gap, status-doc, boot matrix, tier framing, ONNX gate, heartbeat-vs-pause, migration ordering).

## 1. Problem

The Self Hosted API runs the Elysia HTTP server **and** all background CPU in one Bun
process on one event loop. Stage handlers execute on the main thread via `dispatchPool`
(`src/api/src/workers/run-stage.ts:233-253` — plain `async` closures awaited with
`Promise.all`, no worker, no child process). When a stage does synchronous CPU work —
ONNX `session.run()` (`enrichment/face-detector.ts:133`), HEIC WASM decode
(`thumbs/render.ts:52`), the face pre/post loops, large BSON deserialization — the loop
is frozen for the duration, so **every** request queues behind it, including the trivial
`GET /api/health` (which only returns a static object + a sync `isDbConnected()` flag).

Field symptom: intermittent multi-hundred-ms latency on `/api/health` and `index.html`
while average CPU is ~14% of 8 cores — one core saturating in bursts, the average across
8 cores hiding it. This is event-loop blocking, not a resource shortage; adding cores/RAM
cannot help a single blocked thread.

## 2. How we got here (and why this is not "revive the supervisor")

The API **used to be multi-process.** Issue #135 ("Delete the worker supervisor framework
— over-engineered for 4 stages", merged in PR #164) deleted a 613-LOC `supervisor.ts` that
spawned each stage in a **child process** with IPC port discovery, heartbeats, and custom
crash-backoff, and replaced it with the in-process `runStage` orchestrator we have today
(`workers/orchestrator.ts`, `workers/run-stage.ts`).

That refactor was correct about **complexity** — a bespoke multi-process framework with a
plugin API for four concrete stages was not earning its keep. But collapsing to one process
**also discarded the process isolation that kept stage CPU off the HTTP event loop.** #135's
acceptance criteria — "no regression on enrichment latency or completeness" — measured the
_workers'_ throughput. They never measured _HTTP request latency while indexing runs_, which
is the regression we are now seeing. The isolation was load-bearing; its removal was an
unmeasured side effect.

So this design does **not** propose resurrecting `supervisor.ts`. We keep #135's
simplification (the ~50-line `runStage` helper, plain `async` stages) and add back **only**
the isolation — using infrastructure that already survived the collapse.

**What already survived and helps us:**

- **The cross-process SSE bridge already exists.** `runtime/change-feed-tailer.ts` polls
  Mongo `asset_changes` (standalone Mongo has no change streams — those need a replica set —
  so the tailer _polls_, every 500ms) and republishes onto the in-process `ChangeBus` for SSE
  clients. Its docstring is explicit: _"worker stages run in CHILD processes spawned by the
  supervisor… the parent API process never sees [the local bus publish]… Without the tailer,
  every worker-emitted change is invisible."_ The hard part of any split — getting
  worker-emitted changes to SSE clients — is **already solved via Mongo**, idempotently
  (the bus dedupes by `cursor`). It works whether the worker is a thread, a child process, or
  the same process.

**What did NOT survive (the real coordination work — §5):**

- **Worker status is in-memory only.** `/api/workers/status` and the `/api/events` WS
  `process` snapshot read `stageRegistry.statuses()` (`routes/events.ts:26,74`) from an
  in-process registry. In a split, the `http` process has no registry to read.
- **Config changes (pause/resume/concurrency) propagate only in-process.** This is a verified
  gap that breaks any split unless fixed — see §5.1.

## 3. Key constraint: the claim model is single-process-only

`runOnce` (`run-stage.ts:298-388`) claims docs with a Mongo query filtered by stage version
plus an **in-memory** `inFlightSet` and `_id: { $nin: [...inFlight] }` (`run-stage.ts:223`).
The DB is only written **after** the handler completes. There is no atomic "claimed" flag in
Mongo. Consequences:

- A given stage is safe in **exactly one** process. Run the same stage in two processes and
  they double-process the same docs (each process's `inFlightSet` is local). Stage writes are
  idempotent (set-of-version), so a brief overlap wastes CPU rather than corrupting data — but
  it must not be a steady state.
- Crash recovery is already fine **for a single worker process**: a crash mid-handler leaves
  the stage version unadvanced, so the doc is re-picked next poll. The `missing-reaper` +
  per-stage retry/backoff handle transient failures. **No DB lease is needed** unless we later
  shard one stage across multiple processes (§4 Tier 3) — then add an atomic `findOneAndUpdate`
  claim with a `claimed_at` TTL and a reaper for orphaned claims.

**Design rule:** each stage type runs in exactly one process. Never run `role=all` and
`role=workers` against the same database _as a steady state_. (Migration has a controlled
window — see §6.)

## 4. The decision: three tiers — Tier 1 is the foundation, not an alternative

The goal is "no background CPU can block request serving." There are two distinct mechanisms,
and **they compose** — Tier 2 is built _on top of_ Tier 1, not instead of it.

### Tier 1 — worker threads (in-process). Already in flight: #706/#707/#708/#710.

Move each heavy op onto a `Worker` thread, mirroring the three pools already in the repo
(`ffi/ffi-pool.ts`, `ffi/raw_ffi.worker.ts`, `people/cluster-pool.ts`). Bun `Worker`s run on a
separate thread with a **separate JS heap**, so this removes both the CPU **and** the GC
pressure from the loop that hosts them. Single-process deploy is preserved.

This is very likely **sufficient for the event-loop symptom** in `role=all`.

### Tier 2 — role-based process split (the recommended isolation endpoint).

Add one env knob, `MAPLE_ROLE`, and branch `start()` in `index.ts` (full boot matrix in §5.3):

| `MAPLE_ROLE`                        | Runs                                                                                                                                 | Notes                                      |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------ |
| `all` (default — today's behaviour) | everything                                                                                                                           | backward-compatible zero-config            |
| `http`                              | Elysia listener, change-feed-tailer (SSE), **on-demand worker-thread pools (RAW/HEIC)**, worker-status reader, request-adjacent boot | no stages, discover, enrichment, JobRunner |
| `workers`                           | stage orchestrator, discover/chokidar, enrichment, JobRunner, cache-gc, **config-sync loop + status-doc writer**                     | no HTTP listener                           |

Deploy as **two containers sharing one Mongo** (or one `all` container for small installs).
Coordination is **Mongo**, not IPC; restarts are the **process manager's** job (Docker
`restart:`, systemd) — the deliberate anti-#135: no IPC framework, no heartbeat protocol, no
plugin API.

**Tier 1 is a prerequisite of the `http` role, with one nuance:**

- The **live-render pools (RAW via `ffi-pool`, HEIC via #708)** are needed in `role=http`
  regardless — `GET /api/fs/thumb` and histogram are interactive request paths and must not
  block the HTTP loop, and these renders happen _in the http process_ (do **not** route them
  cross-process; that adds IPC latency to an interactive path for no isolation gain). Note
  #708's HEIC pool is used by _both_ the live route and the indexer thumb stage, so it lives in
  both roles.
- The **ONNX stage offload (#707)** is required under Tier-1-only (single process). Under
  Tier 2, face inference runs in `role=workers`, already isolated from HTTP — so #707 is no
  longer needed _for HTTP latency_. It still improves **intra-`workers` fairness** (the workers
  process runs 8 stage poll-loops on one loop; a 300ms ONNX block stalls the others), so it
  remains worthwhile, just for throughput rather than HTTP responsiveness.

**Decision gate — RESOLVED (PR #718 / #707):** the gate was whether `onnxruntime-node` can
initialize inside a Bun `Worker` thread. **It can** — #707 confirmed both `InferenceSession.create()`
calls succeed in-worker and `session.run()` output matches the in-process path. Consequence:
**Tier 1 alone offloads the entire face pipeline** off the HTTP loop in `role=all`; Tier 2 is
therefore **not** mandatory for face inference. Tier 2 remains a purely optional
fault/memory-isolation choice (§7), not a requirement forced by ONNX. (Had it failed, Tier 2
would have been mandatory — but even then face inference would have needed no separate role,
since `role=workers` already isolates it from `role=http`.) Residual, throughput-only sub-point:
under a future Tier 2 split, a long ONNX run still blocks the _other_ stages sharing the workers
process's loop, so the worker-thread offload stays worthwhile there for intra-workers fairness —
not for HTTP latency.

### Tier 3 — multi-worker scale-out. Not now.

Only if one box can't keep up: N `workers` processes. Requires the atomic Mongo claim lease
from §3. Out of scope until throughput data demands it; noted so the constraint is on record.

## 5. Cross-process coordination

### 5.1 Config sync (pause / resume / concurrency) — VERIFIED GAP, must fix

The current implementation does **not** propagate config across processes. `runStage` reads
config once at boot into a local variable (`run-stage.ts:457` `let config = await bootConfig(...)`)
and passes that in-memory value to `runOnce` every tick (`:515-524`). It is refreshed only by
`reloadConfig()` (`:484-490`), which fires solely through the **in-process**
`stageRegistry.notifyConfigChanged()` (`registry.ts:182-194`). Two consequences in a split:

1. A `role=http` process patching `worker_config` and calling its local `stageRegistry` never
   reaches the `workers` process — which keeps running on stale config (won't pause/resume or
   change concurrency). (The docstring at `run-stage.ts:444` "re-read every tick" is already
   inaccurate — it's re-read only on the in-process callback.)
2. **Persistence itself is coupled to the registry.** The route path calls
   `stageRegistry.pause(name)` → the entry's `pause()` callback, which is what does the
   `repo.patch` (`:491-495`). Under `role=http` there is no registered entry, so
   `stageRegistry.pause()` returns `{ok:false, unknown stage}` and **never writes Mongo at all**.

**Fix (two parts):**

- **Persist independent of the registry.** The worker-management routes (`workers/routes.ts`)
  must write `worker_config` directly via `WorkerConfigRepo`, not only through a registry
  entry's callback — so the write succeeds in any role.
- **Workers poll Mongo for config.** Run a lightweight config-sync loop in `role=workers`
  (and harmlessly in `all`). Every ~2s, read the whole `worker_config` collection in one trip
  (8 small docs), compare against a per-stage cached key (`concurrency|maxAttempts|paused`),
  and on a delta call the local `stageRegistry.notifyConfigChanged(name)` (which triggers the
  existing `reloadConfig`). The compare-key avoids re-reading + log spam every tick. This is
  consistent with how the change-feed-tailer already polls (standalone Mongo, no change
  streams). In `role=all` the existing in-process notify still gives instant pause; the poll
  is a harmless backstop.

```ts
// runs under role=workers (and harmlessly under all)
const lastSeen = new Map<string, string>();
setInterval(async () => {
  try {
    for (const doc of await configColl.find({}).toArray()) {
      const key = `${doc.concurrency}|${doc.maxAttempts}|${doc.paused}`;
      if (lastSeen.get(doc.name) !== undefined && lastSeen.get(doc.name) !== key) {
        await stageRegistry.notifyConfigChanged(doc.name).catch(() => {});
      }
      lastSeen.set(doc.name, key);
    }
  } catch (err) {
    log.error({ err }, 'config sync failed');
  }
}, 2000).unref?.();
```

### 5.2 Worker status — single status doc, process-level heartbeat

`role=http` cannot read `stageRegistry.statuses()`. Replace with a **single Mongo status
document** (one write, not 8) the `workers` process maintains:

```jsonc
// worker_statuses / _id: "global_status"
{
  "heartbeat": "2026-05-30T15:32:00Z", // PROCESS-level liveness, written every 2s
  "stages": {
    "exif": { "status": "running", "inFlight": 0, "throughput": 4, "lastError": null },
    "thumb": { "status": "paused", "inFlight": 0, "throughput": 0, "lastError": null },
    // ...8 stages
  },
}
```

- **Writer** (`role=workers`): a `setInterval` (~2s) extracts `stageRegistry.statuses()` and
  does one `replaceOne({_id:"global_status"}, ...)`. One write per interval, not per stage.
- **Reader** (`role=http`): serve `/api/workers/status` and the WS `process` frame from this
  doc, behind the existing `STATUS_CACHE_TTL_MS` cache so concurrent requests don't hammer
  Mongo. Pre-populate static fields (`targetVersion`, `dependsOn`) from `stages/manifest.ts`
  so the schema is correct even before the worker process has ever booted.
- **Staleness ≠ pause (the distinction that matters):** the `heartbeat` is **process-level** —
  the writer updates it every 2s _regardless_ of whether stages are paused. If `now - heartbeat
  > 6s`(3 missed beats), the`http`process treats the **whole worker process** as down and
renders every stage`stopped`/`error`. A *paused* stage still has a fresh global heartbeat
(the process is alive) and is reported as `paused`, never as stale/down. So pausing a stage
  > must never make it look crashed.

### 5.3 Boot-task assignment matrix

| Bootstrap step (in `index.ts` `start()`)                         | `http` | `workers` | Guard / rationale                                  |
| ---------------------------------------------------------------- | :----: | :-------: | -------------------------------------------------- |
| `ensureJwtSecret()`                                              |   ✅   |    ✅     | Idempotent (DB row); both load it for parity       |
| `ensureIndexes()`                                                |   ✅   |    ✅     | Idempotent index build; whichever boots first wins |
| `ChangeFeedTailer.start()`                                       |   ✅   |    ❌     | Serves connected SSE clients; workers don't tail   |
| `clearBackupChunkDir()`                                          |   ✅   |    ❌     | HTTP upload-session state                          |
| `resetAllInProgressBytes()`                                      |   ✅   |    ❌     | HTTP upload-session state                          |
| `startAllStages()`                                               |   ❌   |    ✅     | Core pipeline — exactly one process (§3)           |
| `startDiscover()` (chokidar)                                     |   ❌   |    ✅     | FS watcher; mutates the asset DB                   |
| `startMaintenanceJobs()` (trash-gc, missing-reaper)              |   ❌   |    ✅     | Heavy/destructive; keep off HTTP                   |
| `sweepOrphanedCaches()` (cache-gc)                               |   ❌   |    ✅     | Heavy disk I/O                                     |
| `startGeocodeWorker` / `startFaceWorker` / `startDescribeWorker` |   ❌   |    ✅     | Model warm-up + enrichment                         |
| `startJobRunner()`                                               |   ❌   |    ✅     | Long-running export/reprocess                      |
| config-sync loop (§5.1) + status-doc writer (§5.2)               |   ❌   |    ✅     | The new coordination glue                          |
| worker-status reader / cached `/status` (§5.2)                   |   ✅   |    ❌     | Reads the status doc                               |

In `role=all` every row runs (today's behaviour). `ensureIndexes` ownership across roles:
pick `http` as the canonical owner (or run in whichever boots first — it's idempotent) and
document the choice.

### 5.4 Already handled

- **Cross-process pause read-side at the stage:** once §5.1 lands, the workers process's
  `config.paused` is current, and `runOnce` already short-circuits on it (`run-stage.ts:292`
  `if (config.paused) return 0`).

## 6. Migration path (incremental, each step shippable)

- **Phase 0 — confirm.** Ship #706's lag probe; run `MAPLE_DIAG_EVENTLOOP=1` on the live box
  and correlate spikes with stage logs. Do not build past Phase 1 until a spike is attributed
  to a specific activity.
- **Phase 1 — Tier 1 offloads.** #707 (ONNX), #708 (HEIC), #710 (clustering marshaling), plus
  #706's quick wins. **Re-measure.** If lag is gone in `role=all` and fault/memory isolation is
  not a concern, you may stop here. (#707's gate is **resolved** — ONNX runs in a Bun Worker,
  PR #718 — so Tier 1 covers the face pipeline; Tier 2 is no longer forced by ONNX.)
- **Phase 2 — Tier 2 role split.** Add `MAPLE_ROLE` (default `all`), the §5.1 config-sync fix,
  the §5.2 status doc, and a two-service compose file. Verify SSE end-to-end (tailer bridge)
  and `/api/workers/status` reading the status doc.
  - **Deploy ordering (closes the §3 double-run footgun):** do **not** start a `workers`
    container while an `all` container is still serving. Switch the existing container's role
    `all → http` first (that restart drops the stages), **then** bring up the `workers`
    container. There is no window where two processes run the same stage. (A momentary overlap
    would only waste CPU on idempotent re-writes, but the ordering removes it entirely.)
- **Phase 3 — Tier 3 (only if needed).** Multi-worker sharding + atomic Mongo claim lease.

## 7. Operational payoff of Tier 2 (why split at all, once Tier 1 fixes latency)

1. **Fault isolation.** A segfault in a native lib (`onnxruntime`, `libheif`) takes down only
   the `workers` container; the web app stays up. In one process it kills Elysia too.
2. **Resource ceilings.** Put Docker memory/CPU limits on `workers` so an OOM there can't get
   the HTTP server killed by the host OOM-killer.
3. **Instant HTTP start.** Loading ONNX models costs ~2–5s. `role=http` starts in <100ms and
   serves immediately while `role=workers` warms models in the background.

## 8. Open questions / decisions

- **#707 ONNX-in-Bun-Worker gate (§4) — RESOLVED.** ONNX runs in a Bun Worker (PR #718), so
  Tier 1 is enough for the face pipeline; Tier 2 is now an optional isolation choice, not forced.
- **Compose default:** keep a single `all` container as the zero-config default; ship a
  commented two-service (`maple-http` + `maple-workers`) example. _Recommended._
- **Heartbeat / staleness numbers:** 2s heartbeat, 6s (3-miss) staleness — quick UI feedback
  without hammering Mongo. _Adopt._
- **`ensureIndexes` owner across roles** — pick one, document it.

## 9. Recommendation

1. Land Phase 0 + Phase 1 (Tier 1 worker-thread offloads). Measure. Highest leverage-per-risk,
   already in flight.
2. If, after measurement, fault isolation / memory ceilings matter, land Phase 2 (Tier 2
   `MAPLE_ROLE` split) with the §5.1 + §5.2 coordination fixes. Small, reuses the surviving
   change-feed bridge, restores the isolation #135 removed **without** the 613-LOC supervisor.
   (No longer forced by ONNX — #707/PR #718 proved Tier 1 can offload it; Phase 2 is now a
   robustness choice, not a correctness requirement for the face pipeline.)
3. Hold Tier 3 until throughput data demands it.

**Caveat (per the debugging discipline):** this is a code-grounded design, not a verdict. The
live event-loop-lag data decides whether Tier 1 alone closes the symptom or Tier 2 is needed.

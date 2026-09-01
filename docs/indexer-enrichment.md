# Indexer, Workers and Search

Everything Maple knows about a photo beyond its bytes is produced by a background pipeline that lives in the API server's worker tier. A **discover sweep** walks each registered library folder one directory at a time and keeps the `assets` collection in step with the filesystem — inserting new files, deduplicating identical content, repointing renames, tagging vanished files. Every asset then flows through a set of **stages** (EXIF, thumbnail, preview, vision captioning, geocoding, faces, transcription, search indexing), each of which is a small handler plus a target version number; a generic runner claims assets whose recorded version is below target, runs the handler, and writes the result back. Bumping a stage's `targetVersion` re-queues the whole library through that stage. Alongside the stages sit interval-driven **maintenance workers** (trash purge, missing-file reaper, one-shot migrations, deduplication, mirror replication, derivative audit) and a **JobRunner** for user-triggered one-off work like a batch export or a panorama stitch. Operators see and control all of it on Settings → Workers.

The whole tier runs in a separate, `nice`d child process spawned by the HTTP server, so indexing load can never starve or crash the API.

## Where it runs

`src/api/src/index.ts` spawns `src/api/src/workers/worker-main.ts` as a child process (`ChildProcessWorker`, niced) and auto-respawns it on death with exponential backoff (1 s → 30 s, reset once a worker has lived 60 s). Setting `MAPLE_INDEXER_AUTOSTART=0` suppresses the spawn entirely — useful for running an API-only replica.

`worker-main.ts` connects to Mongo, ensures indexes, initialises OpenTelemetry, loads the mirror registry, and calls `startWorkers()` in `src/api/src/workers/start-workers.ts`, which brings up:

- the stage orchestrator (`workers/orchestrator.ts`)
- the discover sweep (`workers/discover/index.ts`) plus a one-shot cache-GC pass per library
- the FFI decode pool (`ffi/ffi-pool-bootstrap.ts`)
- enrichment bootstraps (Nominatim health check, face-model preload, describe config)
- Meilisearch config refresh (`workers/enrichment-config-refresh.ts`)
- the JobRunner and the import runner
- maintenance jobs (`workers/maintenance.ts`)

It also publishes a status snapshot into a `worker_status` Mongo document every 2 s. That is how the API process — which has an empty in-process registry — can answer `GET /api/workers/status`.

Native decoders are deliberately kept out of this process's address space: `src/api/scripts/check-worker-isolation.sh` fails if `sharp`, `onnxruntime-node`, or `heic-convert` are imported anywhere on the `worker-main` path outside a dedicated child (`thumbs/imgdecode.child.ts`, `enrichment/face-pool.child.ts`, and friends). A segfault in libraw or ONNX kills a child, not the tier.

## Discovery: keeping Mongo in step with disk

There is no filesystem watcher. `workers/discover/sweeper.ts` runs a breadth-first reconciliation sweep, one directory per tick, paced by `sweepDirIntervalMs` (default 250 ms) read from the `discover` row in `worker_config` on every tick — so pausing or re-pacing the sweep takes effect without a restart.

Each directory visit (`visitDirectory`):

1. Lists the directory. Subdirectories are pushed onto a Mongo-backed frontier queue (`workers/discover/frontier.repo.ts`), skipping dotdirs (notably `.maple/`, our own derivative cache — indexing it would create a self-feeding `.maple/.maple/…` loop) and the `_duplicates/` quarantine.
2. Does **one** indexed read for the assets already recorded in that directory, and diffs it against what is on disk. Files on disk with no row are "new candidates"; recorded entries absent from the listing are "missing candidates".
3. Re-stats every missing candidate before believing it. A `readdir` on an SMB share can succeed and return an incomplete listing; only a genuine ENOENT counts, and if the library root itself is unavailable the whole visit confirms nothing rather than mass-tagging present files.
4. Runs rename reconciliation, then emits ordinary `created` / `removed` events for whatever is left.
5. Reconciles the folder-level `.hidden` marker (`workers/discover/folder-hidden.ts`).

When the frontier for a generation drains, `advanceSweep` records a checkpoint (`indexer/checkpoint.ts`) and reseeds the root at the next generation, so the sweep loops forever and a restart resumes the in-progress generation rather than re-walking from scratch.

The supported extension set lives in `workers/discover/types.ts`: RAW formats decoded through libraw, bitmap formats through sharp, PSD/PSB and Radiance HDR, video containers (metadata-only), audio, and a handful of metadata-only stubs (`.eip`, `.braw`, `.afphoto`, `.ai`) that are indexed for filename/size/date and never decoded.

### Per-event handling and content dedup

`workers/discover/handle-event.ts` is the chokepoint every producer funnels into — the sweep, the import runner, browse indexing, the pano handler.

- **created / modified** — hash the first 64 KB (`indexer/id.ts`), look up an existing row by `maple_id`, falling back to `sha1_head`. A hit **appends a location** to the existing row's `fileinfo[]` rather than inserting a duplicate; a miss inserts a fresh row with a blank `stages` skeleton. An E11000 race with a concurrent insert falls back to the append path. Before either, a "modified in place to new content" guard compares the stored `sha1_head` for that exact `(library, path, filename)`; a mismatch marks the old entry `deleted_at` + `missing_since: 'content-changed'` so the stale row stops claiming the location.
- **removed** — re-confirm the file really is absent and the library root really is mounted, then stamp `missing_since` on **that one location**, never the whole asset. A photo that also exists elsewhere stays visible and claimable on its surviving entries.
- **renamed** — rewrite the matching `fileinfo` entry in place (the array length does not change) and re-arm the `meili` stage, because `filename` is the highest-weight lexical field in the search index.

Reserved trees (`.maple/`, `_duplicates/`) are refused for every event kind by `workers/discover/reserved-trees.ts`, whatever the producer.

### Rename reconciliation

`workers/discover/rename-reconcile.ts` handles the common case where a file is renamed **outside** Maple between two sweeps. Without it the sweep would see an unrelated removed+created pair, orphaning the `.xmp` sidecar and every edit in it.

The match signal is a cheap fingerprint — file size + EXIF capture time + camera serial — rather than a full checksum, because a pure rename never touches bytes and the sweep already pays for the EXIF read. The false-positive guard is structural: candidates on both sides are grouped into fingerprint buckets, and a pairing is only ever yielded from a bucket pair where **both** buckets have exactly one member. An ambiguous bucket declines outright and falls through to ordinary created/removed handling. A reconciled rename repoints the `fileinfo` entry, re-arms `meili`, and resets the `thumb` and `preview` stages (their cache keys are path-derived, so the derivatives must be regenerated at the new location — the cache files themselves are never physically moved).

### Missing files, damaged files, and the reaper

Three tags govern an asset's participation in the pipeline, and all three are enforced in one place — `buildClaimQuery` in `workers/claim-query.ts`:

| Signal                    | Set by                                                                           | Effect                                                                                                     |
| ------------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| per-entry `missing_since` | discover `removed`, a file-reading stage's ENOENT, the content-changed guard     | that location is non-live; an asset with no live location drops out of reads and every stage's claim query |
| per-entry `deleted_at`    | content replaced in place                                                        | same — the entry is dead, and is never re-stat'd (a different file may sit at that path)                   |
| root `damaged.since`      | a file-reading stage that exhausts retries, or a handler returning `{ damaged }` | the asset parks out of **every** stage and appears in the Workers "Damaged" list                           |

Tagging is the only automatic step. `workers/missing-reaper.ts` then reconciles, on a 60 s interval in batches of 200:

- **Recover** — the file reappeared: clear the tag, and re-arm any file-reading stage that had died on it. Never age-gated.
- **Prune** — the location is confirmed gone and has been missing longer than `prune_window_hours` (default 12 h): `$pull` the entry.
- **Soft-delete** — that prune emptied the row: set `deleted_at` + `deleted_reason: 'reaped'` and emit a `delete` change event. The record keeps its fileinfo and derived data; trash-GC purges it after the trash retention window, and a content re-discover revives it in the meantime.

Safety properties, all load-bearing: the reaper boots **paused** and its paused state persists in `worker_config`, but pausing suspends only the record soft-delete — recovery and sibling-prune keep running. An unregistered library, an absent mount point, or an unstattable path skips the row entirely. Before a soft-delete, the parent directory is listed and a case/Unicode near-match vetoes the delete (a stored-path bug, not a deleted file). A pass that soft-deletes more than 25 rows _and_ more than half of what it scanned surfaces a persistent worker error as a systemic-misdetection tripwire.

The prune window resolves DB row → `MAPLE_REAPER_PRUNE_HOURS` → 12 h default, clamped to 1 h–1 year, and is editable at `PATCH /api/workers/missing-reaper/prune-window`.

## The stage machinery

A stage is one object built with `defineStage()` (`workers/stage-config.ts`) and handed to `runStage()` (`workers/run-stage.ts`). There are no child processes and no IPC — every stage is a poll loop in the worker process.

### What a stage declares

| Field                     | Meaning                                                                           |
| ------------------------- | --------------------------------------------------------------------------------- |
| `name`                    | key in `worker_config` and in each asset's `stages.<name>` subdocument            |
| `targetVersion`           | bumping it re-queues every asset below that version, and resets dead docs on boot |
| `dependsOn`               | upstream stages, as `'exif'` (≥ v1) or `{ name, minVersion }`                     |
| `defaults`                | `concurrency`, `maxAttempts`, `paused`, `pausedOnFirstBoot`                       |
| `claimFilter`             | optional extra Mongo predicate `$and`-ed into the claim query                     |
| `tagsMissingOnEnoent`     | ENOENT means the original vanished — tag for the reaper                           |
| `tagsDamagedOnDeadLetter` | exhausting retries means the bytes are unreadable — tag `damaged`                 |
| `onProgress`              | optional per-tick hook; only `face-embed` uses it (auto-clustering)               |
| `handler`                 | `(image, ctx) => Promise<StageResult>`                                            |

`pausedOnFirstBoot` is the mechanism for a stage that cannot work until an operator configures something external — a Nominatim URL, an Ollama endpoint, Cloudflare credentials, a whisper model. It seeds `paused: true` on the very first boot only; from then on the saved value wins. Without it, a version-gated stage would mark every asset permanently handled before its configuration existed.

### The claim query

`buildClaimQuery` selects assets where `stages.<name>.version` is below target (or absent), the stage is not `dead`, the per-asset retry backoff has elapsed, at least one `fileinfo` entry is live, the asset is not tagged `damaged`, every `dependsOn` stage has reached its minimum version, and the id is not already in flight this tick. A stage's `claimFilter` is `$and`-merged on, so it cannot collide with the base query's keys — `transcribe` uses a video/audio filename regex so it never sweeps the photo library stamping "not media" skips.

### The poll loop

Each tick claims up to `5 × concurrency` documents (`deriveBatchSize`), dispatches them through a bounded pool (`workers/dispatch-pool.ts`), then decides the next delay (`workers/loop-policy.ts`):

- a full batch → poll again immediately, so a backlog drains as fast as the pool allows;
- otherwise → the global 1 s idle cadence (there is no per-stage poll-interval knob);
- after a tick that threw → exponential backoff 1 s → 30 s, and the error is published to the registry so it shows on `/status` rather than being log-only.

`worker_config` is re-read from Mongo at most every 2 s, which is how a pause written by the API process reaches the running loop with no IPC.

### Result shapes

A handler returns one of five things (`StageResult`):

- `{ patch }` — field values written atomically together with the stage's own success state. Handlers may not write `stages.*` keys themselves; the runner rejects that. An optional `invalidates: ['meili']` marks downstream stages stale in the _same_ write, so a crash can never land new fields without also re-arming the consumer. `describe`, `geocode` and `sidecar-metadata-index` all use this to force a search re-index.
- `{ wrote: true }` — the handler persisted its own output (e.g. `transcribe`), just record the stage state.
- `{ skip: reason }` — nothing to do and nothing retryable: no GPS, not a media file, a stub format with no decode path. Recorded as `last_error: "skip: <reason>"` with `attempts` reset, and the version **is** advanced, so the asset counts as handled.
- `{ rearm: { stage, reason } }` — an upstream artefact is missing even though that stage claims done (a moved cache directory, an interrupted write). The runner re-arms the named upstream stage, keeps this stage below target with its attempt spent, and the `dependsOn` gate parks the asset until the upstream completes. A pair that never converges dead-letters at `maxAttempts` instead of ping-ponging. The named stage must be one of this stage's dependencies.
- `{ damaged: reason }` — the handler already knows retries are futile (a 0-byte file). Marks the stage dead after one attempt and tags the asset. Only allowed on stages that set `tagsDamagedOnDeadLetter`.

### Retry, backoff, and dead-letter

The attempt counter is persisted **before** the handler runs, so an uncatchable native crash (SIGSEGV/SIGABRT in libraw or ONNX) still counts against the budget. A clean success or a skip resets it to zero.

A failure records `last_error`, `failed_at`, and `next_attempt_at` (`workers/stage-failure.ts`). The per-asset retry ladder is 30 s → 2 min → 5 min → 15 min with ±20 % jitter — minutes rather than seconds, because the failures worth surviving are provider restarts and model loads, and jitter because provider outages fail every in-flight asset within the same second. An error carrying `retryable: false` short-circuits the budget. Reaching `maxAttempts` sets `dead: true`, which removes the asset from the claim query.

Operators triage dead assets at `GET /api/workers/:name/dead` and reset them with `POST /api/workers/:name/retry-dead`. Damaged assets are listed at `GET /api/workers/damaged` and cleared with `POST /api/workers/damaged/clear`, which also resets the damage-tagging stages' bookkeeping so the file is genuinely retried.

(The `enrichment` subdocument in `db/schema.ts` and the `enrichment/dead-letter.repo.ts` triage helpers predate this design. Nothing writes that subdocument today except a `$setOnInsert` default, and the routes built on it are not mounted; `stages.<name>.dead` is the live dead-letter surface.)

### Registering a stage

Three additions, all mechanical: export `start<Name>Stage()` from `workers/stages/<name>.ts`; add the stage to both `stageManifest` and `ALL_STAGE_NAMES` in `workers/stages/manifest.ts` (this is what makes existing assets retroactively eligible and what the status counters key off); add an entry to `STAGE_STARTERS` in `workers/orchestrator.ts` (this boots the poll loop). A fourth, optional, gives the UI a real label instead of the generic fallback: a `STAGE_META` entry in `src/web/projects/maple/src/app/settings/workers/workers.vm.ts`.

Boot is best-effort and retried: a stage whose starter throws (missing ONNX model, Mongo blip) is retried with the same 1 s → 30 s ladder while every other stage comes up, and it is pre-registered so `/status` reports it as an error row rather than silently omitting it.

## The registered stages

All eleven live in `src/api/src/workers/stages/`.

| Stage                    | Depends on                  | Concurrency | Starts paused | What it does and where it writes                                                                                                                                                                                                                                            |
| ------------------------ | --------------------------- | ----------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `exif`                   | —                           | 4           | no            | Reads EXIF via exifr; writes `exif` and a heuristic `is_screenshot`. Upgrades `maple_id` from its fallback form (hash of the first 64 KB) to the primary form (hash + capture time + camera serial + shutter count) once a capture date is available. Tags missing/damaged. |
| `thumb`                  | `exif`                      | 2           | no            | 512-px AVIF at `<dir>/.maple/thumbs/<sha256_prefix16(filename)>.avif`, via `indexer/thumbnailer.ts`. Orientation is baked at decode time. Resets `cf-thumb-sync` on every rewrite. Tags missing/damaged.                                                                    |
| `preview`                | `thumb`                     | 2           | no            | 1280-px AVIF at `<dir>/.maple/previews/<filename>.avif`, via `indexer/previewer.ts`. Feeds both the Preview screen and `describe`. Tags missing/damaged.                                                                                                                    |
| `describe`               | `preview`                   | 2           | **yes**       | Vision-LLM captioning through a local Ollama pool. Writes `description`, `description_meta`, the structured `vision` doc + `vision_meta`, `ocr_text`/`ocr_meta`, and an authoritative `is_screenshot`. Invalidates `meili`.                                                 |
| `geocode`                | `exif` ≥ v2                 | 1           | **yes**       | Reverse-geocodes `exif.gps` against a self-hosted Nominatim, through a quantised coordinate cache. Writes `place`; resets `backup_layout_version` when the resolved place changes the canonical backup folder. Invalidates `meili`. No GPS → skip.                          |
| `face-detect`            | `thumb` ≥ v2                | 1           | **yes**       | SCRFD-10G ONNX detector over the cached thumbnail; writes one entry per detection into `faces[]` with bbox, 5-point landmarks, confidence, `person_id: null`.                                                                                                               |
| `face-embed`             | `face-detect`               | 1           | **yes**       | ArcFace R100 recognizer using the _stored_ bbox + landmarks — it never re-detects, so operator `person_id` assignments survive a re-embed. Per-index `$set` of `embedding` + `embedding_version`. Its `onProgress` hook drives auto-clustering.                             |
| `transcribe`             | — (claim-filtered to media) | 1           | **yes**       | Extracts a WAV and runs whisper.cpp on the CPU; writes `transcript` and re-arms `meili`. Timeout scales with audio duration (5 min floor, 6 h cap).                                                                                                                         |
| `sidecar-metadata-index` | `exif`                      | 4           | no            | Reconciles `metadata_override` from the XMP sidecar off the request path, recomputes `captured_year`/`captured_month`, writes/removes the `.hidden` marker, and resets `geocode` when the sidecar's GPS changed. Invalidates `meili`.                                       |
| `meili`                  | `exif`, `thumb`             | 2           | no            | Fan-in. Composes `search_blob` and upserts the Meilisearch document. Tombstones trashed or unlocatable assets instead of upserting.                                                                                                                                         |
| `cf-thumb-sync`          | `thumb` ≥ v2                | 2           | **yes**       | Mirrors the on-disk thumbnail to the Cloudflare R2 edge cache. Skips hidden assets and proactively deletes their edge copy. Unpausing this stage _is_ the backfill.                                                                                                         |

Two details worth internalising:

**`describe` is locked in code.** Provider, model, and prompt are not operator-configurable — `DESCRIBE_VISION_OLLAMA_TAG` (`gemma4:12b`) and `DEFAULT_DESCRIBE_VISION_PROMPT` / `DESCRIBE_VISION_PROMPT_VERSION` in `enrichment/`. The structured-JSON parser only accepts the shape that prompt plus Ollama's grammar-constrained decoding produces, so an operator override would dead-letter every row. What _is_ configurable is the list of Ollama server URLs, pooled by `enrichment/describe-server-pool.ts` with per-server concurrency and failover. OCR is not a separate engine: `ocr_text` is mirrored from the vision model's `text_visible`, and `ocr_meta.engine` is the literal `"qwen2.5-vl"`. Because the on-disk preview is AVIF and every provider sends `image/jpeg`, the handler re-encodes to JPEG in memory per call rather than persisting a second artefact.

**`meili` depends only on the always-on stages,** so search is available early. Every optional producer of searchable text — describe, geocode, transcribe, sidecar metadata, people renames — explicitly re-arms `meili` when its output changes.

## Maintenance workers

These are not per-asset version-claim stages. Each runs its own interval loop and registers into the same in-process registry, so the standard `/api/workers/<name>/{status,pause,resume}` surface controls it. All are started from `workers/maintenance.ts`.

| Worker               | Cadence                  | Behaviour                                                                                                                                                                                                                                                                                           |
| -------------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `trash-gc`           | daily                    | Purges assets whose `deleted_at` is past the retention window (default 30 days): unlink the file in `.maple/trash/` and its sidecars, delete the row. Reaper soft-deletes (`deleted_reason: 'reaped'`) skip the unlink entirely — a file that quietly returned must never be deleted by this sweep. |
| `missing-reaper`     | 60 s                     | Described above. Boots paused.                                                                                                                                                                                                                                                                      |
| `migration`          | 5 s, 50 items            | Runs a registry of named one-shot library migrations (`workers/migration/index.ts` — eleven today, e.g. `refile-backups`, `backfill-video-exif`, `backfill-meilisearch-vectors`). Each has its own operator toggle; the worker idles until one is enabled.                                          |
| `deduplicate`        | interval                 | Collapses an asset found at more than one live path down to one kept copy, **moving** the surplus originals and their sidecars into a reversible `_duplicates/` quarantine the sweep skips. A `.keep` marker pins every copy in its folder. `dry_run` previews without touching disk. Boots paused. |
| `mirror` scan + copy | hourly scan              | Detector enqueues `mirror_queue` rows for files missing or stale on a library's mirror; a separate copy worker drains the queue. An offline mirror root is skipped, never treated as "everything is missing".                                                                                       |
| `derivative-audit`   | 6 h                      | Verifies each live asset's thumb/preview/description on disk and its thumbnail in R2, and issues the canonical five-field stage reset when a derivative has drifted (most often after a move left the `.maple` cache behind). It never renders or uploads — it only re-arms the owning stage.       |
| `generated-search`   | daily                    | Invents themed photo collections per library via Ollama for the widget, Maple TV, and settings surfaces. Boots paused.                                                                                                                                                                              |
| `cache-gc`           | once per library at boot | Sweeps orphaned `.maple/{thumbs,previews}` files, including the retired `<maple_id>.avif` thumbs from when thumbnails were content-addressed. See [caching](caching.md).                                                                                                                            |

## The JobRunner

`src/api/src/job-runner/` is the sibling subsystem for **user-triggered, bounded** work: claim → dispatch → handle → complete/fail/cancel against the `jobs` collection, one in-flight job per runner, 1 s poll, 5 min lease. Handlers report progress and must consult `ctx.shouldCancel()` between steps so an in-flight job can be aborted.

Two kinds exist (`JobKind` in `db/schema.ts`, registry in `job-runner/handlers/index.ts`):

- `batch_jpeg_export` — renders the selected assets to JPEG into an output directory via the shared FFI pool.
- `pano_stitch` — spawns `maple-cli pano stitch` over the selected assets, parses coarse stage progress off stderr, and imports the result as a new asset. The route enforces one at a time. See [pano](pano.md).

**Which to reach for.** Anything whose job is "eventually, every eligible asset gets property X" is a stage, not a job — a stage gets pause/resume, concurrency, retry/backoff, dead-letter, and a live progress row on Settings → Workers for free from the generic machinery, and it becomes retroactively eligible for the existing library the moment it is added to the manifest. A JobRunner job is for a specific, user-selected request with no ongoing backlog behind it: export _these_ photos, stitch _this_ panorama.

## Imports

`src/api/src/imports/` copies a server-local folder into a library. `scan.ts` walks the source (following symlinks, with realpath cycle detection and a re-jail check against `MAPLE_ROOTS`), classifies files, pairs `.xmp` sidecars to their parent image, and groups everything into `YEAR/MM` buckets keyed on **capture** time — EXIF `DateTimeOriginal`/`CreateDate`, falling back to file mtime — so the folder a photo lands in matches the date it is shown under everywhere else. The user reviews and edits the buckets, and the create route freezes the per-file destination list onto the import document.

`imports/worker.ts` then claims pending imports one at a time. Per image it copies sidecars first, then the image, then hands the image to `handleEvent` for indexing. Dedup is decided at the image (`maple_id`, then `sha1_head`); a duplicate image _and_ its sidecars are skipped, because an orphan sidecar would be meaningless. Name collisions resolve to a free sibling, byte-identical files already present are skipped, and cancellation is observed between files with already-copied files left in place.

## Search

Search has two layers, and the second is optional.

**Mongo `$text` is the floor.** The `meili` stage always writes `search_blob` — a lowercased, whitespace-split, deduplicated, alphabetically sorted token bag composed by `enrichment/search-blob.ts` from place metadata, the LLM caption, OCR text, the transcript, the structured vision fields (subjects, setting, activity, notable objects, tags), and named people. Mongo permits one text index per collection, and these sources land on different schedules, so a single recomputed field is what keeps them coherent. Auto-generated `Person N` cluster names are excluded — folding them in would pollute the index with the token "person".

**Meilisearch is the typo-tolerant layer above it.** Maple is purely a client (`enrichment/meilisearch-client.ts`, bare `fetch` against the REST surface); operators run the server elsewhere and configure it on Settings → Workers. When no URL is configured every client method is a no-op and `GET /api/search` uses the Mongo `$text` path — assets stay searchable, just without typo tolerance. `routes/search/list-meili.ts` returns `null` rather than throwing on a miss or an error, precisely so the route keeps answering 200s when Meilisearch is down. The Meili branch ranks by relevance and therefore paginates by offset; the Mongo branch supports seek pagination on `(exif.captured_at, _id)`.

Semantic search rides on Meilisearch's managed embedder. `enrichment/meilisearch-embedder-template.ts` is the single source of truth for both the document template Meilisearch renders and the fingerprint that decides whether a re-embed is needed. `ASSET_DOC_SHAPE_VERSION` is folded into that fingerprint _and_ is the `meili` stage's `targetVersion` — a document-shape change is exactly the condition under which every asset must be re-upserted, so the two can never disagree. Template field order is load-bearing: the rendered text is truncated before embedding, so the highest-value fields (filename, media type, people, place) come first. `enrichment/meilisearch-backfill.ts` provides a leased, resumable bulk re-upsert for the existing library.

## People and face clustering

`face-detect` and `face-embed` produce the raw material; `src/api/src/people/` turns it into people.

`clustering-job.ts` runs online clustering: for each face without a `person_id`, find the nearest person centroid under cosine similarity and assign it if the score clears the threshold (default 0.5), else create a new auto-named "Person N" seeded with that embedding. Centroids are stored as the L2-normalised mean of assigned embeddings, so cosine similarity collapses to a dot product. The pass is incremental and idempotent — re-running touches only unassigned faces.

`cluster-coordinator.ts` fires it automatically, from two triggers: the work→drained edge of the `face-embed` stage (via its `onProgress` hook), and every N faces embedded (default 500, `MAPLE_AUTOCLUSTER_FACE_THRESHOLD`) so people populate progressively during a long run rather than only at the end. Both triggers, and the manual `POST /api/people/cluster`, share one single-flight guard that coalesces overlapping requests into exactly one follow-up pass — two concurrent passes would race on the same `person_id` writes.

The pure clustering core is isolated in `people/cluster-embeddings.ts` so it can be gated without a database. `src/scripts/test_face_clustering.sh` runs it over a committed JSONL fixture set and ratchets purity / NMI / V-measure / ARI / recall@1 against `test-fixtures/face-clustering/budgets.json`; `.github/workflows/face-clustering.yml` runs that on any change under `src/api/src/people/`. Both skip-pass when the fixture is absent. See [testing](testing.md).

## Operator surface

`GET /api/workers/status` (`workers/routes-status.ts`) is the one endpoint the Settings → Workers page polls, every 2 s. Per worker it reports:

| Field                                           | Source                                                                                           |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `status`, `inFlight`, `throughput`, `lastError` | the live registry snapshot, read from the `worker_status` Mongo doc the worker process publishes |
| `pending`                                       | assets below target version, not dead, with a live location                                      |
| `ready`                                         | the subset the claim query would actually pick up right now                                      |
| `blocked`                                       | derived as `pending − ready` — everything waiting on an upstream stage                           |
| `dead`                                          | assets at `dead: true` for this stage                                                            |
| `config`, `batchSize`                           | `worker_config`, with `batchSize` derived as 5 × concurrency                                     |

Plus collection-level `damaged` and `newlyHiddenTotal` counts. The DB half is cached for 2 s, keyed on the stage-name + target-version signature; the registry half is recomposed on every call. The response always covers the full known set (`ALL_STAGE_NAMES` plus the reaper, migration, deduplicate, and discover), so rows never vanish when the worker process restarts — an absent worker simply reports `stopped`.

The rest of the surface (see [server API](server-api.md) for the full reference):

```
GET   /api/workers/status
POST  /api/workers/:name/pause | /resume | /retry-dead
GET   /api/workers/:name/dead
PATCH /api/workers/:name/config          # concurrency 1–100, maxAttempts 1–20, paused
GET   /api/workers/damaged
POST  /api/workers/damaged/clear
GET   /api/workers/missing-reaper/prune-window
PATCH /api/workers/missing-reaper/prune-window
GET   /api/workers/deduplicate/config
PATCH /api/workers/deduplicate/config
GET   /api/workers/migration/migrations
PATCH /api/workers/migration/migrations/:id
GET   /api/workers/performance           # FFI decode-pool size + live pool stats
PATCH /api/workers/performance           # clamped 1–16, resizes the pool live
```

`pollIntervalMs` and `batchSize` are no longer knobs and a `PATCH` carrying either is rejected with a 400 rather than silently ignored. A `PATCH` to `preview`'s concurrency also resizes the on-demand preview limiter in the API process, since that path shares the setting.

On the web side, `settings/workers/workers.vm.ts` supplies `STAGE_META` — group (Ingest / Enrich / Index), icon, human description, and which enrichment config panel a row expands into. A stage the server reports but the map does not know still renders, at the bottom of Ingest with a generic icon, so adding a stage does not _require_ a UI change. That module also pins `FIXED_DESCRIBE_MODEL` to mirror the server's locked describe model, which is why the UI shows it read-only.

## Configuration

Per-worker runtime knobs (`concurrency`, `maxAttempts`, `paused`, plus discover's `sweepDirIntervalMs`) live in the `worker_config` collection keyed by name. Domain configuration — Nominatim URL and rate limit, describe server list, whisper tier, face model directory and download URLs, Meilisearch URL/key/semantic settings — lives in the `enrichment` document in `app_settings`, resolved by `enrichment/enrichment-config.resolve.ts` with environment variables only as a fallback for existing deploys. Per-feature settings (missing-reaper prune window, dedupe, derivative audit, map tiles, display) each get their own `app_settings` document.

New tunables belong in this settings system, not in new environment variables: a DB-backed setting is operator-toggleable at runtime and visible in the UI. Environment variables are reserved for bootstrap that must be known before Mongo is reachable — `MAPLE_MONGO_URI`, the port, secrets, and `MAPLE_INDEXER_AUTOSTART`.

Because settings are saved by the HTTP process while stages run in the child, `workers/enrichment-config-refresh.ts` polls the config row every 2 s in the worker and re-applies it — reconfiguring the Meilisearch client and dropping the describe stage's cached server pool — so an edit in `/settings/enrichment` takes effect without a restart.

## Build and test

```bash
cd src/api
bun install
bun run dev          # API + spawned worker tier on http://localhost:3000
bun test             # unit + integration; needs a reachable MongoDB
bun run typecheck
bun run lint

# Guard: no native decoders on the worker-main import path
bash scripts/check-worker-isolation.sh

# Face-clustering quality ratchet (no MongoDB needed)
bash src/scripts/test_face_clustering.sh
```

`.github/workflows/api.yml` runs `bun test` against a MongoDB 7 service container plus a real Meilisearch container for the transport integration test. `.github/workflows/face-clustering.yml` runs the clustering ratchet on changes under `src/api/src/people/`. See [testing](testing.md) for the full gate list, [api](api.md) for the server's own architecture, and [caching](caching.md) for how the derivatives these stages write are keyed and invalidated.

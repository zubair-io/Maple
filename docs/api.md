# Maple Server (Bun + Elysia)

The server in `src/api/` is Maple Self Hosted: one Bun process that serves the HTTP API, streams photo bytes, and hands the built Angular bundle to the browser, plus one **child process** it spawns and supervises that runs every background worker. State lives in MongoDB; the photos themselves stay where the operator put them, on the filesystem, and Maple only ever adds `.xmp` sidecars and a `.maple/` cache folder beside them. RAW decoding is done by the same Rust core the desktop apps use, loaded as a native shared library — but never in the HTTP process: decodes are dispatched to a pool of disposable child processes so a segfault deep in libraw can only kill a child. Almost everything an operator can tune lives in MongoDB and is editable from the Settings pages at runtime; environment variables are reserved for the handful of things that must be known before the database is reachable.

For the route-by-route reference see [server-api](server-api.md). For the stages, workers, and search machinery the child process runs, see [indexer-enrichment](indexer-enrichment.md).

## Process model

`src/api/src/index.ts` is the entry point (`bun src/index.ts`). It does three things in order: resolve the JWT signing secret, build and listen the Elysia app, and kick off a background boot sequence that connects Mongo, builds indexes, loads the mirror registry, starts the change-feed tailer, spawns the worker child, bootstraps Meilisearch, and initialises OpenTelemetry. Every phase of that sequence is individually wrapped: if Mongo is unreachable the server still listens and DB-bound routes fail with an error envelope, and if `ensureIndexes()` fails the server keeps going with whatever indexes exist.

The **worker child** is spawned from `runtime/child-process-worker.ts` running `workers/worker-main.ts`, at a lowered `nice` priority. It owns the whole background tier — pipeline stages, the discover sweep, cache GC, the FFI decode pool, the geocode/face/describe enrichment workers, the job runner and the import runner (`workers/start-workers.ts`). Splitting it out is deliberate: indexer load can neither starve the HTTP event loop nor crash it. When the child dies the parent respawns it with exponential backoff — 1s growing to a 30s ceiling on repeated fast deaths, reset once a child has run healthily for a minute — so a poison asset that aborts the tier on boot degrades into a slow retry rather than a hammering crash loop. Setting `MAPLE_INDEXER_AUTOSTART=0` suppresses the child entirely.

Because the worker tier lives in another process, the API process's in-memory `stageRegistry` is empty. Worker control routes therefore never use IPC: `POST /api/workers/:name/pause` writes `worker_config.<name>.paused` in Mongo and the worker picks it up on its next poll tick (`workers/routes-main.ts`).

A third tier of processes sits under the FFI pool (`ffi/ffi-pool.ts`): each RAW thumbnail, preview, or histogram decode runs in a short-lived child that `dlopen`s `native/libraw_ffi.{dylib,so}`. The pool queues requests, lazy-spawns children up to the operator-configured target, and drains in-flight work before shrinking. A native crash rejects only that one request.

`SIGTERM`/`SIGINT` drains in a fixed order: stop the event-loop probe, stop the change-feed tailer, terminate the worker child (its own handler drains the tier), flush OpenTelemetry, wait up to 5 seconds for in-flight mirror replication, close Mongo.

### Middleware stack

Four plugins wrap every request, mounted before any route:

| Plugin            | File                             | What it does                                                                                                                                                                                                                                                                                                                                     |
| ----------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `requestContext`  | `middleware/request-context.ts`  | Assigns a ULID request id, exposes it as `X-Request-Id`, threads it into a pino child logger, and normalises every non-2xx into `{ error, code, requestId, details? }`. Handles both thrown errors (`onError`) and handlers that set `set.status` and return a plain object (`mapResponse`).                                                     |
| `securityHeaders` | `middleware/security-headers.ts` | CORS plus `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`, which the web app needs for `SharedArrayBuffer` and the WASM thread pool. Streamed-file routes are exempted — writing `set.headers` on them makes Elysia rebuild the `Response` and discard the `BunFile` slice, which broke ranged video. |
| `bodyLimit`       | `middleware/body-limit.ts`       | The server-wide Bun cap is 64 GB so the upload route can stream a large video straight to disk; this guard rejects anything declaring more than 128 MB on every other route, before the parser buffers it. Only `POST /api/folders/:id/upload` is allowlisted for the full ceiling.                                                              |
| `swagger`         | `@elysiajs/swagger`              | Scalar docs UI at `/docs`, spec JSON at `/openapi.json`. Deliberately unauthenticated so clients can codegen DTOs from it.                                                                                                                                                                                                                       |

## Authentication

Auth is passkey-first. There are no passwords anywhere in the codebase.

**Claiming the server.** `GET /api/auth/bootstrap` tells a fresh client whether the server has an owner yet. The first WebAuthn registration wins ownership by inserting a single sentinel document (`server_state`, `_id: "owner_claim"`), so two concurrent first-registrations can't both become owner — the duplicate-key error decides it (`auth/server_claim.ts`). Every subsequent account needs an invite code, minted by the owner at `POST /api/auth/invites` and consumed during registration. Invites are 8-character base32, single-use, and expire in 15 minutes (`auth/invites.ts`).

**Sessions.** A successful passkey ceremony mints a 15-minute HS256 access JWT plus a 90-day refresh token (`auth/tokens.ts`). Access-token verification is stateless — signature and expiry only, no per-request DB read — which is the deliberate trade for a workload that hammers thumbnail routes. The cost is that revocation lands within one access-token lifetime rather than instantly. Refresh tokens rotate on every use and are tracked as a _family_: replaying a consumed token is normally treated as theft and revokes the whole lineage, except inside a 60-second grace window while the family still has a live token, which covers a lost response or two browser tabs refreshing at once (`auth/refresh_store.ts`).

**Claims and permissions.** The access token carries `sub`, `email`, `role` (`owner` | `member`) and `file_access`. Four gates are built on it in `auth/middleware.ts`:

- `requireAuth` — a valid bearer. Applied once to the big authed sub-app in `routes/authed-api.ts`.
- `requireOwner` — role must be `owner`. Gates Cloudflare config, the user roster, service API keys, invites, the Meilisearch admin routes, and `PUT /api/enrichment/config` (which could otherwise repoint search traffic at an attacker's host).
- `requireFileAccess` — the per-user permission that separates filesystem browsing and file move/rename/trash from photo backup, timeline, and search. Owners always have it; members have it unless an operator revokes it via `PATCH /api/users/:id`.
- `stepUpBeforeHandle` — requires a fresh `X-Step-Up` token, minted by `POST /api/auth/step-up/verify` after a _new_ WebAuthn assertion. Gates adding or removing a credential, creating or rescinding an invite, minting or revoking a service key, and revoking a paired device session — so a leaked 15-minute access token can't be escalated into permanent access.

**Alternate credentials.** Four narrower token types exist because a browser or a media element can't always send an `Authorization` header:

- _Native PKCE codes_ (`auth/native_code_store.ts`): the Apple and Windows shells launch the web sign-in flow with an S256 challenge; the signed-in page issues a single-use 60-second code; the app redeems it with the verifier for its own device-scoped tokens. A raw refresh token never rides in a redirect URL. The Windows shell polls `POST /api/auth/native-code/claim` instead, because Chromium blocks custom-scheme launches without a user gesture.
- _LAN handoff codes_ (`auth/lan_handoff_store.ts`): the same shape without PKCE, used when a session on the public URL needs to continue on the plain-HTTP LAN origin, where WebAuthn's secure-context requirement makes repeating the ceremony impossible.
- _Image capabilities_ (`auth/image-capability.ts`): a 43-character opaque token in `?token=`, stored hashed in `image_access_tokens`, valid for GET only, on one exact path, and only under `/api/thumb/` or `/api/preview/`.
- _Service API keys_ (`auth/service-api-keys.ts`): `maple_sk_<keyid>_<secret>`, scoped (today only `assets:search`), compared in constant time. They authenticate `POST /api/search/assets` for machine callers, entirely separate from user JWTs.

Paired-device sessions back Maple TV: a device proves possession of a refresh token to mint a long-lived session, and the owner can list and step-up-revoke them (`routes/auth-device-sessions.ts`).

**The signing secret is not an env var.** `auth/jwt-bootstrap.ts` resolves it from MongoDB (`server_state`, `_id: "jwt_secret"`), creating it on first boot. A file at `MAPLE_JWT_SECRET_FILE` is the fallback only when Mongo is unreachable at boot, and an in-memory random secret is the last resort — that one logs loudly, because it means every restart signs everyone out. Boot logs a 12-hex-character fingerprint of the active secret so two instances disagreeing about `bad signature` can be diagnosed by eye.

`MAPLE_DEV_AUTH=1` exposes `POST /api/auth/dev-login`, a passkey bypass for local development. Startup prints a warning when it is on.

## Data model

One MongoDB database (`maple` by default). `db/schema.ts` declares every document shape; `db/client.ts` owns the connection singleton, the typed collection accessors, and `ensureIndexes()`, which also runs the schema migrations in `db/migrations.ts`. The connection re-reads `MAPLE_MONGO_URI`/`MAPLE_MONGO_DB` on every `getDb()` call and reconnects if they changed — in production that is one string compare, in tests it is what makes per-suite database overrides reliable.

| Collection                                                                                                                                             | Holds                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `folders`                                                                                                                                              | Registered library roots: path, slug, mirror locations                                                                                                           |
| `assets`                                                                                                                                               | The catalog. One doc per asset, carrying `fileinfo[]` (its on-disk locations), `exif`, `vision`, `faces[]`, `place`, `stages.*` progress, trash and hidden state |
| `asset_changes`                                                                                                                                        | Append-only change feed with a monotonic cursor, tailed for SSE                                                                                                  |
| `people`, `person_merge_dismissals`                                                                                                                    | Face clusters, names, cover assets, dismissed merge suggestions                                                                                                  |
| `geocode_cache`                                                                                                                                        | Reverse-geocode results keyed by coordinate                                                                                                                      |
| `indexer_queue`, `discover_frontier`, `indexer_checkpoints`, `indexer_dead_letter`                                                                     | Discovery and indexing work state                                                                                                                                |
| `worker_config`, `worker_status`                                                                                                                       | Per-stage pause/concurrency/batch settings, and published status snapshots                                                                                       |
| `jobs`, `imports`, `import_files`                                                                                                                      | One-off JobRunner work and the import runner's per-file progress                                                                                                 |
| `users`, `credentials`, `invites`, `challenges`, `refresh_tokens`, `service_api_keys`, `native_auth_codes`, `lan_handoff_codes`, `image_access_tokens` | Auth                                                                                                                                                             |
| `backup_sessions`, `upload_sessions`                                                                                                                   | Chunked PhotoKit backup ingest state                                                                                                                             |
| `mirror_queue`                                                                                                                                         | Failed mirror replications awaiting retry                                                                                                                        |
| `presets`                                                                                                                                              | User develop presets (sparse, schema-versioned adjustment models)                                                                                                |
| `generated_searches`                                                                                                                                   | The themed collections the generated-search worker invents                                                                                                       |
| `app_settings`, `indexer_config`, `server_state`                                                                                                       | Settings documents, indexer worker counts, and the JWT secret + ownership sentinel                                                                               |
| `meilisearch_backfill_state`, `_leases`, `_failures`                                                                                                   | Meilisearch backfill bookkeeping                                                                                                                                 |
| `migrations`, `stage_handlers`, `describe_spend`, `video_geo_backfill_audit`                                                                           | Migration marks, per-stage handler overrides, describe-provider spend, geo backfill audit                                                                        |

## Settings: database first, env vars only for bootstrap

Operator configuration lives in Mongo, not the environment, so it can be changed from the Settings pages without a restart or shell access. Two collections carry it:

- **`app_settings`** — one document per subsystem, each with a `_id` naming it: `cloudflare`, `display`, `enrichment`, `performance` (the FFI pool size), `map`, `network`, `observability`, `pano`, `render`, `deduplicate`, `derivative-audit`, `generated_search`, `migration`, `missing-reaper`. Each has a repo module (e.g. `render/render-config.repo.ts`) that loads the stored document and a resolver that fills in built-in defaults, reporting per-field whether the value came from `db` or `default` so the UI can say so.
- **`worker_config`** — per-stage pause flags, concurrency, and batch sizing, read by the worker tier on every poll tick.

Environment variables are limited to things that must be known before the database is reachable, or that are pure deploy topology. These are the ones actually read by the code today:

| Variable                                                                                                                                                              | Purpose                                                                                                                                                                                                                    |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`                                                                                                                                                                | Listen port; anything outside 1–65535 falls back to 3000 (`runtime/server-port.ts`)                                                                                                                                        |
| `MAPLE_MONGO_URI`, `MAPLE_MONGO_DB`                                                                                                                                   | Connection string and database name (defaults `mongodb://localhost:27017`, `maple`)                                                                                                                                        |
| `MAPLE_ROOTS`                                                                                                                                                         | Colon-separated absolute paths the server may touch at all. Unset means only registered folder roots bound access — in Docker the mount is the jail                                                                        |
| `MAPLE_TLS_CERT`, `MAPLE_TLS_KEY`                                                                                                                                     | Serve HTTPS. Both or neither; a half-configured pair throws at startup rather than quietly serving HTTP. This exists because a plain-HTTP LAN origin is not a secure context, so WebGPU and WebAuthn are unavailable there |
| `MAPLE_JWT_SECRET_FILE`                                                                                                                                               | On-disk fallback location for the signing secret when Mongo is down at boot                                                                                                                                                |
| `MAPLE_RP_ID`, `MAPLE_ORIGIN`, `MAPLE_CORS_ORIGIN`                                                                                                                    | WebAuthn relying-party id and allowed origins; required in production because the browser matches them against the page hostname                                                                                           |
| `MAPLE_TRUSTED_PROXIES`                                                                                                                                               | How many reverse-proxy hops sit in front, so the auth rate limiter reads the client IP from a trusted `X-Forwarded-For` entry rather than the spoofable leftmost one (default 1; set 0 when directly internet-facing)      |
| `MAPLE_DEV`, `MAPLE_DEV_ORIGIN`, `MAPLE_DEV_AUTH`, `MAPLE_UI_DIST`                                                                                                    | Dev-server proxying, the passkey bypass, and overriding the UI dist directory                                                                                                                                              |
| `MAPLE_INDEXER_AUTOSTART`                                                                                                                                             | `0` suppresses the worker child                                                                                                                                                                                            |
| `MAPLE_BACKUP_TMP`                                                                                                                                                    | Chunk staging directory for resumable uploads (default `/tmp/maple-backup-chunks`)                                                                                                                                         |
| `MAPLE_MODEL_DIR`, `MAPLE_FACE_*`, `MAPLE_PANO_MODELS`                                                                                                                | Model download URLs, checksums, ONNX Runtime thread counts, and pano model paths                                                                                                                                           |
| `MAPLE_MEILISEARCH_URL`, `MAPLE_MEILISEARCH_API_KEY`, `MAPLE_NOMINATIM_URL`, `MAPLE_NOMINATIM_RATE_LIMIT_PER_SEC`, `MAPLE_GEOCODE_WORKER_ENABLED`, `MAPLE_DESCRIBE_*` | Fallbacks only. `enrichment/enrichment-config.resolve.ts` prefers the `app_settings` document and reads these when no value has been saved                                                                                 |
| `MAPLE_LOG_LEVEL`, `MAPLE_DIAG_EVENTLOOP`                                                                                                                             | Log level, and an opt-in event-loop lag probe                                                                                                                                                                              |
| `MAPLE_FFI_WORKERS`, `MAPLE_REAPER_PRUNE_HOURS`                                                                                                                       | Fallbacks for values now owned by settings documents (`performance`, `missing-reaper`): the DB row wins, then the env var, then the built-in default                                                                       |
| `MAPLE_AUTOCLUSTER_FACE_THRESHOLD`                                                                                                                                    | How many new faces trigger an automatic re-cluster. Env-only, with a built-in default                                                                                                                                      |

## Library addressing

A library is a registered folder root with a URL-safe slug derived from its name (`library/slug.ts`; collisions get a `-2` suffix). Anything inside it is addressed as `slug:relPath`, which is what the four unified routes take as `/api/{folder,image,thumb,preview}/:slug/*`.

`library/address.ts` is the single jail for those routes. It resolves the slug to a root through an in-memory cache (no DB round-trip per request), rejects absolute paths, backslashes, and `..` segments, then `realpath`s the result and confirms it still sits under the root — so a symlink cannot escape. Path-addressed legacy routes (`/api/fs/*`, `/api/xmp`, `/api/preview`) keep their own equivalent checks (`fs/root.ts`, `routes/fs-jail.ts`, `routes/xmp-path-auth.ts`), all enforcing the same `MAPLE_ROOTS` policy plus a system-directory denylist from `fs/browse.ts`.

## Filesystem layer

Originals are never modified. Everything Maple derives lands in a `.maple/` directory beside the photos, and everything the user edits lands in an `.xmp` sidecar (see [xmp-canonical-format](xmp-canonical-format.md)).

| Artefact  | Path                                                                                      | Keyed by                                                                                      |
| --------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Sidecar   | `<file>.xmp` for video (`clip.mov.xmp`), stem-swap for images (`IMG_1.ARW` → `IMG_1.xmp`) | Filename. Video keeps its extension so a Live Photo's still and clip don't clobber each other |
| Thumbnail | `<dir>/.maple/thumbs/<sha256_prefix16(basename)>.avif`                                    | First 16 hex of sha256 of the _basename_, so the cache travels when the folder is copied      |
| Preview   | `<dir>/.maple/previews/<basename>.avif`                                                   | The source filename, one unversioned file overwritten in place. 1280 px long edge             |
| Histogram | `<dir>/.maple/previews/<basename>.histogram.json`                                         | Same scheme, different suffix                                                                 |
| Trash     | `<dir>/.maple/trash/<rel>`                                                                | Soft-deleted originals plus their sidecars                                                    |

Both derived tiers are path-keyed rather than content- or id-keyed, so a client can resolve either from a path alone with no database lookup. The trade-off is that a rename orphans them for one re-render; the missing-reaper, the dedupe cache-removal hook, and the `cache-gc` sweep reclaim the strays. There is deliberately no `size` parameter on the thumb route: one cache file per source means any other requested size would silently serve whatever was written first. Thumbnails also carry no source-mtime staleness check on read — since originals are immutable by design, invalidation happens where changes are observed (the discover watcher, derivative-audit, and the write-time mtime guard), not on every read.

`fs/mirrored.ts` is a drop-in replacement for `node:fs/promises` with identical signatures. Modules that import it instead of the real thing get every durable write, move, and delete under a mirrored library root replicated to that library's configured backup roots. The primary operation runs and throws exactly as before; replication is _scheduled_, never awaited, so a slow or offline backup can't stall an edit. Temp files are skipped — the codebase writes `<final>.tmp.<pid>` then renames, so only the committed result replicates. Failures land in `mirror_queue` for the mirror copy worker to retry, and reads fail over to a mirror only when the primary volume is unreachable (`fs/mirror-read.ts`).

## Native decoding

`src/api/native/libraw_ffi.{dylib,so}` is the Rust core (`raw-ffi`) compiled as a shared library and loaded through `bun:ffi`. Build it with:

```bash
./src/api/scripts/build-raw-ffi.sh          # auto-detects platform
./src/api/scripts/build-raw-ffi.sh linux    # cross-compile via `cross` + Docker
```

Rebuild it after any change to `raw-core` or `raw-ffi`. If the library is absent, `tryGetRawFfi()` returns null and every caller degrades: RAW thumbnails are logged as deferred and skipped, and the rest of the pipeline advances. `ffi/raw_ffi.ts` is the symbol wrapper; `ffi/ffi-pool.ts` is the process pool described above; `thumbs/imgdecode-pool.ts` is the sibling pool for non-RAW bitmap formats, and `thumbs/hdr-decode-isolated.ts` isolates PSD/Radiance decode the same way. Pool size is an `app_settings` value (`_id: "performance"`) exposed at `GET/PATCH /api/workers/performance`.

## Cloudflare R2 thumbnail cache

Two deploy units, no shared code. On the server side, the `cf-thumb-sync` pipeline stage (`workers/stages/cf-thumb-sync.ts`) uploads each indexed asset's on-disk thumbnail to an R2 bucket via a signed S3-compatible PUT (`cloudflare/r2-client.ts`, using `aws4fetch`). The object key is derived purely from the URL shape — `thumbs/<slug>/<relDir>/<filename>`, percent-encoded per segment (`cloudflare/thumb-key.ts`) — so a re-render simply overwrites at the same key and there is no invalidation step.

On the edge side, `src/cloudflare/` is a Worker that fronts `GET /api/thumb/*`. It verifies the bearer token against the shared HS256 secret before touching anything, derives the same key from the URL with no database access (`src/cloudflare/src/r2.ts` re-implements the derivation independently — keep the two in sync by hand), serves R2 hits with immutable cache headers, and on a miss proxies to the origin and populates R2 asynchronously. Image-capability URLs bypass R2 entirely and proxy to the origin for authoritative validation. Credentials are entered on Settings → Cloudflare and validated before saving; the stage starts `pausedOnFirstBoot` because those credentials aren't known at first boot, and hidden assets are excluded (an edge cache has no per-request visibility check), with `cloudflare/hidden-cleanup.ts` actively deleting the edge copy when an already-synced asset becomes hidden.

The Worker needs the same JWT secret. There is deliberately no API route that echoes it — read it out of `server_state.jwt_secret` and `wrangler secret put JWT_SECRET`.

## Search

Maple is a Meilisearch _client_; the operator runs the instance elsewhere and configures the URL and key under Settings → Workers. `enrichment/meilisearch-client.ts` speaks the REST surface with bare `fetch` rather than the npm client, keeping the dependency small and making `globalThis.fetch` the only seam tests need. When no URL is configured every method is a no-op and `GET /api/search` falls back to the Mongo `$text` index over `asset.search_blob`; assets stay searchable, just without typo tolerance. Non-`health` methods log and swallow so a sick sidecar can never break the geocode worker or the search route.

The `meili` pipeline stage composes the search blob and upserts the document; `initializeHttpSearch()` runs at boot to health-check the instance and ensure the index settings match. Optional semantic search adds an embedder configuration on the same index. Bulk reindexing is `POST /api/admin/enrichment/backfill-meilisearch` (owner-only), with lease and failure state in dedicated collections so a backfill survives a restart.

## Observability

`otel.ts` turns the resolved observability config into a running OpenTelemetry `NodeSDK` shipping traces over OTLP/HTTP, plus HTTP and MongoDB auto-instrumentation so every request and query becomes a span. Logs take a different route: `otel-logs.ts` taps pino's output stream directly through `pino.multistream` and POSTs OTLP/JSON, because the pino instrumentation's monkey-patching is unreliable under Bun and missed everything logged before the SDK started. Metrics are plumbed through the config but not wired to an exporter.

Configuration is entirely DB-backed (`app_settings`, `_id: "observability"`) and hot-reloadable — `PUT /api/observability/config` reconfigures the running SDK without a restart. The backend ships direct to SigNoz because it holds the ingestion key; browser and native clients instead pull the resolved config from `GET /api/observability/config` and either send direct or proxy through `POST /api/observability/otlp/v1/:signal`.

## Backup ingest

`POST /api/libraries/:libraryId/backup/ingest` is a chunked, resumable upload from a PhotoKit-backed Apple device. Headers carry the resume key (device id plus PHAsset id) and the metadata needed to compute a destination path — capture date, optional GPS, filename; the body is the chunk, with `Content-Range` declaring the offset. Chunks append to `<sessionId>.part` under `MAPLE_BACKUP_TMP` and the final chunk atomically moves the file into the library. The status codes carry the protocol: `202` means send more, `200` means done and returns the created `maple_id`, `409` returns the `expected_offset` the client should resume from, and `423` means another device is uploading the same iCloud photo and returns a `retry_after_seconds`.

Startup wipes the staging directory and resets `received_bytes` on every still-open session row — without that reset a client resuming a session whose bytes were just deleted would see a `409` pointing past the end of a file that no longer exists and fall out of the upload loop.

The surrounding routes complete the picture: `/backup/exists` for dedup probes before uploading, `/backup/state` for reconciliation, `/backup/sidecar` and `/backup/rendered` for companion files, and `/backup/notify-deleted` for deletion reconciliation. All six sit behind `requireAuth` — they accept file writes and destructive deletes.

Point the staging directory at the same volume as the library folders. On `/tmp` you risk quota errors under concurrent uploads, and the final move becomes a cross-device copy instead of an O(1) rename.

## Imports

`/api/imports` copies photos from a server-local folder (an SD card mount, say) into a library. `POST /api/imports/scan` walks the source and returns buckets; `POST /api/imports` creates a pending import; the import runner in the worker child copies file by file with per-file state in `import_files`, and cancel is honoured between files. The source folder must pass the `MAPLE_ROOTS` jail and every bucket label is re-validated server-side as a safe directory segment — the UI's own check is not trusted.

## Change feed

Every catalog mutation appends to `asset_changes` with a monotonically increasing cursor. `runtime/change-feed-tailer.ts` republishes those rows onto an in-process bus so SSE clients see changes written by the worker process too. Clients either poll `GET /api/changes?since=<cursor>` or hold `GET /api/changes/subscribe`, which replays buffered events past the cursor and then streams. SSE connections carry a 10,000-event backlog cap, a 15-second keepalive comment frame, and a hard 5-minute lifetime so an expired token can't live indefinitely behind an open stream — the Apple client reconnects cleanly. `/api/events` is a separate WebSocket carrying worker status frames; it authenticates via `?token=` because browsers can't set headers on `new WebSocket()`.

## Serving the UI

`routes/static_ui.ts` is a catch-all mounted last, after every API route. In production it serves the compiled Angular bundle (`src/web/dist/maple/browser/`, overridable with `MAPLE_UI_DIST`) and falls through to `index.html` for client-side routes. With `MAPLE_DEV=1` it proxies to the Angular dev server instead. It is deliberately not auth-gated: an unauthenticated cold load has to reach `/sign-in` before it can call any `/api/auth/*` endpoint. This is why the bearer gate lives in a wrapped sub-app (`routes/authed-api.ts`) rather than on the root instance — an Elysia scoped derive on the root would leak forward into the static handler.

## Deployment

Two supported shapes, both in `src/api/`.

**Docker.** `Dockerfile` is a four-stage self-contained build; the build context must be the monorepo root. Stage 0 builds the raw-wasm blob with nightly Rust, stage 1 builds the Angular bundle (running `scripts/sync-raw-wasm.sh` rather than copying the pkg, because that script carries the nested-worker patch the thread pool needs), stage 2 builds `libraw_ffi.so` with stable Rust, and a `whisper.cpp` stage builds the statically-linked transcription CLI. The runtime image adds `ffmpeg` for video poster frames, `unzip` for the face-model bootstrap, and `libgomp1` for whisper, then smoke-runs `whisper-cli` and `ffmpeg` so a missing loader dependency fails the build instead of shipping.

```bash
docker build -f src/api/Dockerfile -t maple .
docker run -p 3000:3000 \
  -e MAPLE_MONGO_URI=mongodb://host.docker.internal:27017 \
  -v /path/to/photos:/photos -e MAPLE_ROOTS=/photos \
  -v maple_config:/app/config maple
```

`docker-compose.yml` brings up MongoDB by default, adds the server under the `app` profile, and a Cloudflare Tunnel under the `proxy` profile. The health check is `GET /api/health`.

**systemd.** `maple.service` runs `bun src/index.ts` from `/opt/maple` as a `maple` user under `ProtectSystem=strict`, with the photo library and `/var/lib/maple` in `ReadWritePaths`. `maple-deploy.timer` fires `maple-deploy.service` every minute, which runs `scripts/auto-deploy.sh` — a cheap `git fetch` that only rebuilds and restarts when `origin/main` has moved.

## Development and testing

```bash
cd src/api
bun install
bun run dev          # bun --watch src/index.ts
bun run start        # bun src/index.ts
bun run typecheck    # tsc --noEmit
bun run lint         # oxlint src
bun test             # bun test --timeout 20000
```

**Tests need a real MongoDB.** `db/test-db.test-helpers.ts` connects to `MAPLE_MONGO_URI` (default `mongodb://localhost:27017`) with 1.5-second timeouts; when nothing answers, Mongo-backed suites skip-pass rather than fail, so a machine without a database gets a green but hollow run. Suites must scope their environment overrides with `withTestEnv` / `withTestDb` and never assign `process.env.MAPLE_MONGO_DB` at module scope — Bun evaluates every module body before any test runs, so the last import would silently rename the database for every other suite and a teardown could drop one still in use.

CI (`.github/workflows/api.yml`) runs `bun test --timeout 30000` against a `mongo:7` service with `MAPLE_JWT_SECRET` set, then runs the Meilisearch integration suite separately against a `getmeili/meilisearch:v1.50.0` service pointed at by `MAPLE_MEILISEARCH_INTEGRATION_URL`. `bun run test:production-mongo` starts a server against a production-shaped database for end-to-end work.

See [testing](testing.md) for the full gate list across the repo.

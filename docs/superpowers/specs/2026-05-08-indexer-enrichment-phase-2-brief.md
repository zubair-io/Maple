# Brief — Indexer enrichment, Phase 2: geocode worker

Status: ready for Claude Code · scope: ~3-4 days · prerequisite: Phase 1 landed

## What to build

A new background worker that reverse-geocodes assets with EXIF GPS data by calling an existing self-hosted Nominatim instance over HTTP, parses the response into the `Place` schema, populates a quantized lat/lon cache to avoid duplicate API calls, and updates the asset's `enrichment.geocode` state.

The worker is the first slow-tier enrichment worker. Its shape becomes the template for face and describe workers in later phases — get the patterns right here.

The full architecture is in `docs/indexer-enrichment.md`. Read §3 (worker mechanics), §4 (geocode worker — the detailed spec), and §7 (operations) before starting.

## Scope — do this

1. **Nominatim client** (`src/api/src/enrichment/nominatim-client.ts`).
   - One method: `reverse(lat, lon): Promise<NominatimReverseResponse>`.
   - HTTP GET against `${MAPLE_NOMINATIM_URL}/reverse?lat=...&lon=...&format=jsonv2&addressdetails=1&extratags=1&namedetails=1&zoom=18`.
   - Per-call timeout `requestTimeoutMs: 5000` (configurable).
   - Token-bucket rate limiter at `rateLimitPerSec: 10` (configurable). The limit is per-process; multiple workers in the same process share it.
   - Distinguish 4xx (don't retry — bad input) from 5xx / network errors (retry).
   - Startup health check method `await client.health()` that GETs `/status` and throws on failure. The worker boot path calls this once and exits the process if it fails. This is critical: a typo in `MAPLE_NOMINATIM_URL` or a not-yet-booted Proxmox VM should fail loud at startup, not silently dead-letter every claim.

2. **Place parser** (`src/api/src/enrichment/place-parser.ts`).
   - `parseNominatimResponse(raw, lat, lon): Place` — produces the schema in `docs/indexer-enrichment.md` §4.4.
   - Map address fields: `city ?? town ?? village → rollups.locality`; `state → rollups.region`; `country_code → rollups.countryCode`; `ISO3166-2-lvl4 → stateCode` (parse the suffix after the dash).
   - Extract POIs from `extratags` and the address fields `amenity / shop / tourism / leisure / historic / natural` — each becomes a `pois[]` entry with `{ name, category, type }`.
   - Handle the "unable to geocode" case (open ocean, etc.): return a Place stub with empty address and empty pois so we don't keep retrying.
   - Set `source: "nominatim"`, `geocoderVersion: 1` (constant for now), `geocodedAt: now`.

3. **Coordinate cache** (`src/api/src/enrichment/coordinate-cache.ts`).
   - New Mongo collection `geocode_cache`. Document shape:
     ```ts
     { _id: string, place: Place, fetchedAt: Date, geocoderVersion: number }
     ```
   - `_id` is `lat:42.6526,lon:-73.7562` — quantized to 4 decimal places.
   - `quantize(lat, lon): string` — round to 4 decimals, format the key.
   - `get(lat, lon): Promise<Place | null>` — checks cache, returns hit only if `geocoderVersion` matches the current handler version.
   - `set(lat, lon, place)`: upsert.
   - No TTL on the documents. Stale invalidation is via `geocoderVersion` bump (covered by §7.3 in the design doc).

4. **Geocode worker loop** (`src/api/src/enrichment/geocode-worker.ts`).
   - Class `GeocodeWorker` with `start()` and `shutdown()` methods.
   - Loop body, exactly as §1.2 in the design doc:
     - `claim()` — `findOneAndUpdate` per §3.1, with the geocode-specific filter (`exif.gps.lat` not null, `enrichment.geocode.doneAt` null, lock free or expired).
     - If no claim, sleep `POLL_MS` (1000ms default) and continue.
     - `process(asset)` — quantize coords, hit cache, on miss call Nominatim, parse, write to cache, return `{ place }`.
     - `complete(asset, place)` — single `updateOne` setting `place`, `enrichment.geocode.doneAt: now`, version, clearing lock.
     - `fail(asset, err)` — increment `attempts`, set `lastError`, release lock immediately so the next claim retries; once `attempts >= MAX_ATTEMPTS`, set `enrichment.geocode.deadLetterAt` and don't reclaim.
   - `LEASE_MS = 5 * 60 * 1000` (5 min).
   - `MAX_ATTEMPTS = 5`.
   - Compound index for the claim query: `{ "exif.gps.lat": 1, "enrichment.geocode.doneAt": 1, "enrichment.geocode.lockedBy": 1 }`. Create on startup if missing.

5. **Circuit breaker.**
   - After K consecutive 5xx / timeout errors (default `K = 10`), pause the worker for `CIRCUIT_OPEN_MS` (default 60s). During the pause, the loop sleeps but doesn't claim new work and doesn't burn retry budget.
   - The breaker resets on the first success after re-opening.
   - Log loud messages at every state transition (closed → open, open → half-open, half-open → closed).

6. **Wire into API startup.**
   - In whatever file boots `src/api/src/main.ts` (or wherever the API process starts), instantiate the worker iff `MAPLE_GEOCODE_WORKER_ENABLED !== "false"`. Default on.
   - Run health check, fail-fast on error. Then `worker.start()` returns immediately; the loop runs in the background.
   - On `SIGTERM`, call `worker.shutdown()` (sets a flag the loop checks; awaits the current claim's `process` to finish; clears the lock; exits).

7. **Tests** — in `src/api/src/enrichment/*.test.ts`.
   - Use a mock HTTP server for Nominatim (Bun has built-in support, or use `nock` / `msw`). Don't depend on a real Nominatim being reachable from CI.
   - Cover:
     - Claim loop picks up a pending row, marks it done, writes `place`.
     - Two workers can't double-claim the same row (run two `claim()` calls in parallel; assert one wins).
     - Lease expiry: a row whose `lockedBy` is set but `leaseExpiresAt` is in the past gets re-claimed.
     - Retry: a 5xx response increments `attempts` and the row gets re-claimed on the next loop.
     - Dead-letter: after `MAX_ATTEMPTS` failures, `deadLetterAt` is set and the row is not re-claimed.
     - Circuit breaker: K consecutive failures opens the breaker; subsequent ticks don't call Nominatim.
     - Cache hit: same coords twice produces one Nominatim call.
     - No GPS: a row with `exif.gps.lat = null` is never claimed (covered by the index filter).
     - Place parser: golden test against a real Nominatim JSON response (commit a fixture).

## Scope — do NOT do this

- **Do not** compute or store the `searchBlob` field. That's Phase 3.
- **Do not** implement face or describe workers. Different phases.
- **Do not** add Meilisearch. Different phase.
- **Do not** change the fast pipeline. The fast tier is done after Phase 1.
- **Do not** add an admin/inspection HTTP route. That's Phase 4.
- **Do not** introduce a job-queue library. The "queue" is the Mongo state document; we use `findOneAndUpdate`-with-lease, not BullMQ / Redis / etc.

## Files you'll likely touch

New:
- `src/api/src/enrichment/nominatim-client.ts`
- `src/api/src/enrichment/place-parser.ts`
- `src/api/src/enrichment/coordinate-cache.ts`
- `src/api/src/enrichment/geocode-worker.ts`
- `src/api/src/enrichment/circuit-breaker.ts`
- `src/api/src/enrichment/*.test.ts` (one per file above)
- `src/api/test-fixtures/nominatim-reverse-museum.json` — golden fixture

Modified:
- `src/api/src/db/schema.ts` — `Place` type may need to be expanded if it was stubbed in Phase 1; `geocode_cache` collection name registered.
- `src/api/src/main.ts` (or wherever the API boots) — instantiate and start the worker.
- `src/api/.env.example` — add `MAPLE_NOMINATIM_URL`, `MAPLE_GEOCODE_WORKER_ENABLED`.

## Constraints

- **Single-process rate limiter is fine for v1.** If you ever run multiple worker processes against the same Nominatim, you'll need a shared rate limiter — not in scope here. Document the assumption in a comment.
- **No real Nominatim in tests.** CI must pass without network access to Proxmox. Mock all HTTP.
- **Idempotency.** `process()` must be safe to re-run. The cache makes this efficient; the schema makes it correct (`complete()` is one `updateOne` that overwrites cleanly).
- **No `any`.** Type the Nominatim response (lifted from real responses; tolerate missing fields with `?` rather than `any`).

## Acceptance

1. `cd src/api && bun test` passes, including new enrichment tests.
2. Worker process boots, hits `/status` once, logs success or fails fast.
3. Manually backfill: pick 100 assets that have GPS but no `place` (or insert test data). Start the worker. Within reasonable time all 100 have `place` populated and `enrichment.geocode.doneAt` set.
4. Inspecting the `geocode_cache` collection shows fewer documents than 100 (because clustered photos share a quantized key).
5. Killing the worker mid-claim (SIGKILL the process) and restarting it: the orphaned claim's lease expires and a fresh claim succeeds.
6. Pointing `MAPLE_NOMINATIM_URL` at an unreachable host: process exits at startup with a clear error.
7. Pointing it at a host that 5xx's repeatedly: circuit breaker opens, log shows the transition, claims pause; service recovers and breaker closes after first success.

## Out-of-scope follow-ups

- Phase 3: search (`searchBlob`, Mongo text index, search route).
- Phase 4: dead-letter inspection admin route.
- Phase 5: face worker (mirrors this worker's shape — claim loop, lease, retry, dead-letter — with ONNX inside `process`).
- Phase 6: describe worker (same shape; LLM client; cost cap).

Reference: `docs/indexer-enrichment.md` §8.

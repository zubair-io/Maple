# Indexer enrichment

Status: design · last updated 2026-05-08

This doc designs the **enrichment subsystem** that runs after the indexer's fast pipeline finishes. It covers the two-tier architecture, the per-asset state model, the geocode worker (self-hosted Nominatim against Geofabrik extracts), the search design (Albany NY / NY / Park / Musum), and the rollout plan.

Companion doc: `docs/workers-architecture.md` (the existing fast pipeline this builds on top of).

## TL;DR

The current indexer is one linear pipeline that writes the asset row only at the end. It works for hash/exif/thumb but breaks for geocoding, face detection, and image descriptions: those stages are slow, depend on external services, and have wildly different latency profiles. Forcing them through the same chain means a 2-second thumb gates an LLM call that would have been 5 seconds and the user can't see their photo until everything finishes.

The fix is **two-tier**:

1. **Fast tier (existing pipeline, slightly shortened).** `discover → hash → exif → thumb → mongo-skeleton`. Writes a skeleton asset row as soon as the cheap stuff is known. The browse UI sees the photo within a second.
2. **Slow tier (new enrichment workers).** Independent workers (`geocode`, `face`, `describe`) that each pull from Mongo, run their work, and patch the asset row. Each worker has its own pool, retry policy, and dead-letter handling. New worker types are additive — write a worker, deploy it, no pipeline changes.

Per-stage state lives on the asset document (`enrichment.geocode.doneAt`, `enrichment.face.doneAt`, etc.), so backfills are queries (`find({ "enrichment.geocode.doneAt": null })`) and restarts pick up where they left off.

For geocoding, **Maple is purely a Nominatim client**. The user already runs Nominatim as a separate service (on Proxmox in this case); Maple talks to it over HTTP via a single configurable URL. We keep a quantized lat/lon cache to dedupe the 90% case (clustered photos at one location), and store both the structured address and a denormalized `searchBlob` field. A Mongo text index on the blob covers the "Albany NY" / "NY" / "Park" cases. Typo tolerance ("Musum" → Museum) needs a Meilisearch sidecar, which is deferred to v2.

## 1. Two-tier architecture

### 1.1 Fast tier — what changes

The existing pipeline keeps `discover → hash → exif → thumb`. The mongo stage changes from "write everything" to "write a skeleton."

The skeleton has every field the browse UI needs to show the photo:

```ts
{
  _id: ObjectId,
  mapleId: string,
  folderId: ObjectId,
  absPath: string,
  filename: string,
  size: number,
  mtime: number,
  sha1Head: string,
  exif: AssetExif | null,        // EXIF block from existing parser
  thumb: { ready: true, path: string },

  // Enrichment state — workers update these
  enrichment: {
    geocode:  { doneAt: null, lockedBy: null, leaseExpiresAt: null,
                attempts: 0, lastError: null, version: null },
    face:     { doneAt: null, lockedBy: null, leaseExpiresAt: null,
                attempts: 0, lastError: null, version: null },
    describe: { doneAt: null, lockedBy: null, leaseExpiresAt: null,
                attempts: 0, lastError: null, version: null }
  },

  // Enrichment outputs (added later by workers)
  place: null,        // see §4.4
  faces: [],
  description: null
}
```

The fast pipeline's `runMongo` is the only stage that changes — instead of stuffing `faces`, `aiTags`, etc. into the upsert, it inserts the skeleton with empty enrichment state. The browse grid populates within ~200 ms of `exif` finishing instead of waiting through every external API call.

### 1.2 Slow tier — worker shape

Each enrichment worker is a small, independently deployable process that loops:

```ts
while (!shutdown) {
  const job = await claim(); // findOneAndUpdate, see §3.1
  if (!job) {
    await sleep(POLL_MS);
    continue;
  }
  try {
    const result = await process(job);
    await complete(job, result); // sets doneAt, writes outputs
  } catch (err) {
    await fail(job, err); // increments attempts, may dead-letter
  }
}
```

The same shape works for `geocode`, `face`, and `describe`. Only `process()` differs.

Workers are independent. A geocode worker can run on a tiny VM next to Nominatim. A face worker can run on a GPU box. A describe worker can run on a host with an LLM API key. None of them know about each other — they coordinate exclusively through the asset document.

## 2. Per-stage state on the asset

The `enrichment.<stage>` sub-document is the contract between the fast pipeline and a worker:

| Field            | Purpose                                                                           |
| ---------------- | --------------------------------------------------------------------------------- |
| `doneAt`         | ISO timestamp when the stage completed. `null` = pending.                         |
| `lockedBy`       | Worker id holding the claim. `null` = available.                                  |
| `leaseExpiresAt` | When the lock auto-releases. Crashed workers don't block forever.                 |
| `attempts`       | Retry count. Crossed `MAX_ATTEMPTS` → dead-letter.                                |
| `lastError`      | Last error message, for triage.                                                   |
| `version`        | Handler version that produced the output. Bumping it triggers re-runs (see §7.3). |

This is the only state that needs to exist in Mongo for the architecture to work. The previous "linear pipeline + `dead_letter` collection" scheme moves _into_ the asset document. The dead_letter collection stays for fast-tier failures (a hash that can't be computed is still a fast-tier dead letter), but slow-tier failures live on the asset.

## 3. Worker mechanics

### 3.1 Claim query (the `findOneAndUpdate` pattern)

The geocode worker's claim query:

```js
db.assets.findOneAndUpdate(
  {
    'exif.gps.lat': { $ne: null },
    'exif.gps.lon': { $ne: null },
    'enrichment.geocode.doneAt': null,
    $or: [
      { 'enrichment.geocode.lockedBy': null },
      { 'enrichment.geocode.leaseExpiresAt': { $lt: now } }, // expired lease
    ],
  },
  {
    $set: {
      'enrichment.geocode.lockedBy': workerId,
      'enrichment.geocode.leaseExpiresAt': now + LEASE_MS,
    },
  },
  { sort: { 'exif.captured_at': -1 } }, // newest first; tunable
);
```

This is atomic — Mongo guarantees only one worker wins a given claim. Lease expiry handles crashed workers. The compound index for the geocode worker is `{ "exif.gps.lat": 1, "enrichment.geocode.doneAt": 1, "enrichment.geocode.lockedBy": 1 }`; each worker type gets its own index tuned to its claim shape.

### 3.2 Polling vs change streams

Start with **polling at 1 Hz with batched claims** (claim up to N at a time, process them, repeat). Simple, no driver-level surprises, easy to reason about. Latency budget: ~1 second from `mongo-skeleton` write to first claim — fine for enrichment work that takes seconds anyway.

Evolve to **change streams** when you have a measurable reason. Mongo's change streams give near-realtime "watch a query" semantics without polling overhead. The trade-off is operational complexity (resume tokens, change-stream cursor lifetime, etc.) and version coupling to the Mongo cluster. Defer until polling actually hurts.

### 3.3 Lease and retry

`LEASE_MS = 5 minutes` for geocode (network call, should be fast). `LEASE_MS = 30 minutes` for face (GPU model, can be slow). `LEASE_MS = 10 minutes` for describe (LLM call). Workers renew the lease if their work runs long.

Retry on failure: increment `attempts`, set `leaseExpiresAt: now` so the lease releases immediately, leave `lockedBy: null`. Next claim picks it up after a backoff (the backoff happens because the worker's loop sleeps).

`MAX_ATTEMPTS = 5`. After that, set `enrichment.<stage>.deadLetterAt = now`, leave `doneAt: null`. The claim query won't pick it up again because the worker can be configured to skip dead-letter rows.

A separate "reset" admin operation can clear `deadLetterAt` and reset `attempts` to retry — useful when you fix a bug and want to re-process.

### 3.4 Idempotency

Every worker handler must be safe to re-run on the same asset. If `process()` partially writes outputs and then crashes, the next claim re-runs `process()` and the outputs get overwritten. This is fine for geocode (the result is deterministic given lat/lon), face (the result is deterministic given the thumbnail), and describe (the LLM may give a different caption, but the field gets overwritten cleanly).

What's _not_ safe is writing partial outputs across multiple Mongo updates. Each worker's `complete()` must be a single `updateOne` that sets the output and `doneAt` in one operation.

## 4. Geocode worker (the detailed spec)

### 4.1 Nominatim — external service

Maple does not run Nominatim. The operator runs it separately (in this deployment: a VM on Proxmox, loaded from a Geofabrik extract sized to the user's photo coverage). Maple consumes it as an HTTP client.

What Maple needs from the operator's instance:

- A reachable URL on the local network (e.g. `http://nominatim.lan:8080`).
- A reverse-geocode endpoint at `/reverse` supporting `addressdetails=1`, `extratags=1`, `namedetails=1`.
- A health endpoint at `/status` (Nominatim's default).
- A rate limit generous enough for backlog processing — 10–20 req/s is plenty; we self-throttle below that.

Configuration on Maple's side is a single environment variable: `MAPLE_NOMINATIM_URL`. No credentials by default (private network); add a header-based auth shim if the operator fronts Nominatim with a reverse proxy.

Decoupling Maple from Nominatim ops has real benefits:

- Nominatim re-imports (monthly OSM updates) don't touch Maple at all.
- Maple can swap providers (different self-hosted instance, public Nominatim with reduced rate, even a paid geocoder) by changing one URL.
- Different installs can point at different Nominatim instances with different extract scopes — Maple doesn't care.
- Nominatim crashes / reboots are isolated; the geocode worker dead-letters cleanly and resumes when service returns (see §4.5).

Failure-domain implications are in §4.5 — the worker treats Nominatim as a remote dependency with timeouts, retries, and a startup health check.

### 4.2 The geocode worker

The worker config:

```ts
const GEOCODE_CONFIG = {
  nominatimUrl: process.env.MAPLE_NOMINATIM_URL, // required; fail-fast at boot if missing
  requestTimeoutMs: 5_000, // remote service; tighter than localhost
  rateLimitPerSec: 10, // respectful even on a private instance
  cacheQuantizationDecimals: 4, // ~11m precision, see §4.3
  handlerVersion: 1,
};
```

On boot, the worker hits `${nominatimUrl}/status` once. If that fails, the process exits with a clear error rather than silently dead-lettering every claim. This is critical when Maple and Nominatim live on different hosts — a typo in the URL or a Proxmox VM that hasn't booted yet shouldn't look like a thousand geocode failures.

`process(job)`:

1. Read `job.exif.gps.lat`, `job.exif.gps.lon`. If either is null → `complete(job, { place: null, reason: "no-gps" })`. Done; no API call.
2. Quantize lat/lon to `cacheQuantizationDecimals` precision and check the `geocode_cache` collection. If hit → use cached result.
3. Otherwise, GET `${nominatimUrl}/reverse?lat=${lat}&lon=${lon}&format=jsonv2&addressdetails=1&extratags=1&namedetails=1&zoom=18`.
4. Parse the response into the `Place` schema (see §4.4).
5. Write to `geocode_cache` keyed by quantized coords.
6. `complete(job, { place })` updates the asset.

Rate-limiting: a token bucket per worker process. With one worker and `rateLimitPerSec: 10`, we'll hit ~36k geocodes/hour, which clears a 100k-photo library in under three hours assuming 70% cache-hit rate.

### 4.3 The coordinate cache

For a single trip, photos cluster geographically — 100 shots inside a museum all return the same address. The cache turns 100 API calls into 1.

Quantization: round lat/lon to `N` decimals before keying.

| Decimals | Precision | Notes                                                        |
| -------- | --------- | ------------------------------------------------------------ |
| 3        | ~111 m    | Coarse — groups a city block. Risk: misses neighboring POIs. |
| **4**    | **~11 m** | **Default. Same building usually shares a key.**             |
| 5        | ~1.1 m    | Almost no dedup; basically no cache.                         |

The cache document:

```ts
{
  _id: "lat:42.6526,lon:-73.7562",       // quantized coords
  place: { ... },                         // parsed Place (see §4.4)
  fetchedAt: ISODate,
  geocoderVersion: 1
}
```

TTL: indefinite. OSM addresses don't change often. Cache invalidation = bump `geocoderVersion`, cache entries with stale version are ignored.

### 4.4 The `Place` schema

This is what gets stored on `asset.place`:

```ts
interface Place {
  // Provenance
  source: 'nominatim'; // future: "google", "azure", etc.
  geocoderVersion: number; // see §7.3
  geocodedAt: ISODate;

  // Raw lat/lon (so we can re-geocode later if needed)
  lat: number;
  lon: number;

  // Nominatim's canonical name
  // e.g. "New York State Museum, 222, Madison Avenue, Albany, ..."
  displayName: string;

  // Structured components
  address: {
    houseNumber?: string;
    road?: string;
    neighbourhood?: string;
    suburb?: string;
    city?: string; // "Albany"
    town?: string;
    village?: string;
    county?: string; // "Albany County"
    state?: string; // "New York"
    stateCode?: string; // "NY" (parsed from ISO3166-2-lvl4)
    postcode?: string;
    country?: string; // "United States"
    countryCode?: string; // "us"
  };

  // POIs at this location (extracted from amenity/tourism/leisure/historic/natural)
  pois: Array<{
    name: string; // "New York State Museum"
    category: string; // "tourism"
    type: string; // "museum"
  }>;

  // Coarse rollups for browsing/grouping
  rollups: {
    locality: string | null; // city ?? town ?? village
    region: string | null; // state
    countryCode: string | null;
  };

  // Denormalized text for full-text search (see §5)
  searchBlob: string;
}
```

### 4.5 Failure modes

- **No GPS.** Job completes with `place: null`. Not a failure. The asset just has no place data; the search index won't find it geographically.
- **Nominatim down or unreachable.** Network error or 5xx from the remote service. Worker retries with backoff via the lease + retry mechanism. After `MAX_ATTEMPTS` → dead-letter. Operator can bulk-reset (§7.2) once Nominatim is back. Because Nominatim runs in a different failure domain (different host, different reboot schedule), it's worth adding a circuit breaker — pause the worker for N minutes after K consecutive 5xx/timeout failures so an outage doesn't burn through every pending asset's retry budget. The startup health check (§4.2) catches the configuration-error case where the URL is just wrong.
- **Nominatim slow.** Cold-cache reverse queries on a freshly-imported instance can take seconds. The 5s `requestTimeoutMs` is forgiving but not unlimited; tune up if your instance regularly exceeds it.
- **Coordinates over open ocean / Antarctica / etc.** Nominatim returns 200 with `error: "Unable to geocode"`. Worker treats as "geocoded but unresolvable" — `place: { lat, lon, source: "nominatim", displayName: null, address: {} }`. The asset gets a place stub so we don't keep retrying, but the search blob is empty.
- **Malformed lat/lon in EXIF.** Validate at claim time; mark as `place: null` with reason.

## 5. Search design

### 5.1 What we want

| Query       | Should match                                            |
| ----------- | ------------------------------------------------------- |
| `Albany NY` | Photos in Albany, NY                                    |
| `NY`        | All photos in New York state                            |
| `Park`      | Photos at Central Park, Battery Park, parks of any kind |
| `Musum`     | (typo) Photos at museums                                |

The first three are **exact / prefix matching on words**. The fourth needs **fuzzy / typo tolerance**. We solve the first three in v1 with Mongo text indexes and a denormalized search blob; we defer the fourth to a Meilisearch sidecar.

### 5.2 The denormalized `searchBlob`

When the geocode worker writes `asset.place`, it also computes `place.searchBlob`: a single space-separated string containing every word a search should match. Example for the museum case:

```
New York State Museum 222 Madison Avenue Albany Albany County
New York NY United States US 12230 museum tourism
```

Construction rules:

- All non-empty `address.*` values, lowercased and joined.
- The `stateCode` (`NY`), so a search for "NY" matches.
- POI names _and_ their `type` (`museum`, `park`), so a search for "Park" matches "Central Park" _and_ generic park photos, and a search for "Museum" matches museum photos by category.
- Both full and abbreviated country names if available (`United States` and `US`).

This blob lives on the asset (denormalized from `place.address` and `place.pois`) so the text index can sit on the asset collection directly. It's a few hundred bytes per asset — cheap.

### 5.3 Mongo text index

```js
db.assets.createIndex({ 'place.searchBlob': 'text' }, { default_language: 'english' });
```

Then:

```js
db.assets.find({ $text: { $search: 'Albany NY' } });
// Matches assets whose searchBlob contains BOTH "Albany" AND "NY" — exactly what we want.

db.assets.find({ $text: { $search: 'NY' } });
// Matches every asset with "NY" in the blob.

db.assets.find({ $text: { $search: 'Park' } });
// Matches "Central Park", "Battery Park", and any asset tagged with park POIs.
```

For ranking, use Mongo's text score (`$meta: "textScore"`) and combine with capture date as a secondary sort.

### 5.4 Faceted browse (orthogonal to search)

For "browse by location" (the hierarchical UI: country → state → city), separate compound indexes serve:

```js
db.assets.createIndex({
  'place.rollups.countryCode': 1,
  'place.rollups.region': 1,
  'place.rollups.locality': 1,
});
```

Aggregation pipelines (`$group` on `rollups.region`, count) populate the browse tree. This is independent of the text search and can ship simultaneously.

### 5.5 Deferred: typo tolerance via Meilisearch

For "Musum" to match "museum", we need typo-tolerant search. Mongo text indexes can't do this. Options:

1. **Meilisearch sidecar** (~20MB single binary, very fast, typo-tolerant by default). The geocode worker pushes `{ assetId, searchBlob }` to Meilisearch on completion. The search route queries Meilisearch first to get asset ids, then fetches the assets from Mongo. **Recommended for v2.**
2. **Atlas Search** — has fuzzy operators but locks Maple Self Hosted into Atlas. Reject.
3. **Postgres trigram (`pg_trgm`)** — they're already running Postgres for Nominatim. Could double-up. Couples search to the geocoding service though, and is slower than Meilisearch.

V1 ships without typo tolerance. The first time a user types "Musum" and gets nothing, it's a small UX hit — acceptable for the launch.

### 5.6 The shipped Meilisearch index

§5.5 is the original design decision; this section describes what actually runs. Option 1 shipped, plus hybrid (keyword + vector) search against a managed Ollama embedder.

**Document fields.** `MeilisearchAssetDoc` (`src/api/src/enrichment/meilisearch-client.ts`) is written by exactly two places, which must stay in lockstep: the per-asset meili stage (`workers/stages/meili.ts`) and the bulk backfill (`meilisearch-backfill-compose.ts`). Both derive the prose fields through `enrichment/asset-doc-fields.ts` so they cannot drift.

Searchable attributes, in order — **the order is ranking-significant**, because Meilisearch's `attribute` rule favours matches in earlier attributes:

```text
filename, people, transcript, ocrText, description, placeText, searchBlob
```

- `filename` first keeps exact-identifier queries (`IMG_4185.MOV`) top-1.
- `people` second: a name query wants photos _of_ that person, not a transcript that mentions them in passing. The field holds only resolved `PersonDoc.name`s — auto `Person N` clusters and merged rows are excluded upstream.
- `transcript` / `ocrText` above `description`: what was actually said or written outranks what a captioner guessed.
- `searchBlob` last. It remains searchable because it is the only home for the structured vision tokens, but at the lowest weight.

**Embedding template.** Single-sourced in `enrichment/meilisearch-embedder-template.ts` and labelled per field. It deliberately excludes `searchBlob`: that field is a lowercased, deduped, **alphabetically sorted** token bag (§5.2, `enrichment/search-blob.ts`), and a sentence embedder reads word order and repetition, so feeding it the blob delivered scrambled tokens for real transcripts while generic captions arrived as fluent prose. `transcript` is rendered last so that if the embedder's context window is reached, the truncation lands in the transcript tail rather than dropping the shorter, denser fields; `asset-doc-fields.ts` also caps it at `MAX_INDEXED_TRANSCRIPT_CHARS`.

Every `{{ doc.x }}` the template dereferences **must** have a matching key in `TEMPLATE_FIELD_DEFAULTS` in the same file. Meilisearch renders the template for every incoming document with strict Liquid lookups, so a document missing a referenced key rejects its **entire batch** with `invalid_document_fields` — hit live in #2369 by tombstone documents during a backfill.

### 5.7 Re-embedding after a document-shape change

The semantic fingerprint is `v<ASSET_DOC_SHAPE_VERSION>:<sha256>`. When the shape version changes (a new field on `MeilisearchAssetDoc`), coverage is **not** carried forward: every asset reads as un-vectorized until it has been re-upserted with the new fields.

That asymmetry is deliberate. A settings PATCH makes Meilisearch re-embed the documents already in its index, so a pure model / URL / template-wording change carries forward safely — the vectors really are rebuilt. But a shape change means the template now reads fields those indexed documents do not carry yet, so the re-embed would run against missing data. Counting it as coverage would show the operator 100% while every vector was built without, say, a transcript. See `documentShapeOf` in `enrichment/meilisearch-vector-coverage.ts`.

Two paths converge on the rebuild, and both are safe to run:

1. **Automatic** — the meili stage's `targetVersion` is bound to `ASSET_DOC_SHAPE_VERSION`, so every asset becomes eligible again and the stage re-upserts it. Slow (concurrency 2) but needs no operator action.
2. **Operator-driven** — `POST /api/admin/enrichment/backfill-meilisearch` (owner only) batches the same work at 250 documents per Meilisearch task. `?reset=true` discards prior backfill progress and re-scans from the start.

Watch Settings → Workers: `vectorizedDocumentCount` climbs back toward `indexedDocumentCount` as the re-embed proceeds.

## 6. Face and describe workers (sketch)

Same worker shape as geocode (§3). What changes:

**Face worker.**

- Claim query: `{ "thumb.ready": true, "enrichment.face.doneAt": null, ... }`.
- `process()`: open the thumbnail file, run RetinaFace + MobileFaceNet via ONNX (the `AiFace` shape in `pipeline.ts` is already the target), write `asset.faces = [...]`.
- Pool size: 1-2 (CPU-bound, expensive). 1 if you also want to run on a GPU box.
- Lease: 30 min.

**Describe worker.**

- Claim query: `{ "preview.ready": true, "enrichment.describe.doneAt": null, ... }`.
- `process()`: read the 1280-px preview JPEG (see `src/api/src/workers/stages/preview.ts`), call Ollama with the structured-JSON prompt `DEFAULT_DESCRIBE_VISION_PROMPT` (`src/api/src/enrichment/enrichment-config.repo.ts`), parse strictly with `parseVisionJson`, then write `description` (caption mirror), `description_meta`, the structured `vision` subdoc, and `vision_meta`.
- Default provider: Ollama with `qwen3-vl:8b` (requires Ollama >= 0.12.7 — the prior `qwen2.5vl:7b` generation worked on older Ollama builds, but the qwen3 family needs the newer runtime). Anthropic / OpenAI / Gemini providers remain wired but are off by default.
- `dependsOn: ["preview"]`. `targetVersion: 6` as of the qwen3-vl / prompt-v5 upgrade. `pausedOnFirstBoot: true`.
- Pool size: 1 (single-slot on the 24 GB VLM host). Network-bound providers can raise this.
- Lease: 10 min.
- Failure path: malformed model output throws `VisionParseError`; the runtime stamps the error and dead-letters at `maxAttempts`. No silent skips.

Both workers slot in without touching the geocode worker, the fast pipeline, or each other.

### 6.1 Vision (structured)

The describe stage emits a structured `VisionDoc` subdoc on the asset alongside the legacy free-text `description`. The structured fields are what enable faceted filters ("outdoor sports", "drone photos with readable text") and richer search-blob composition without needing a vector DB.

The full shape lives in `src/api/src/db/schema.ts` (search for `VisionDoc` / `VisionMeta`). Summary, in prompt v5's field order — `is_screenshot` and `nudity` are classified first because Ollama's grammar-constrained decode emits JSON properties in schema order, so putting the classification fields first lets the rest of the response condition on them:

| Field               | Meaning                                                                                                                                                                                                                           |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `is_screenshot`     | `true` for a screen capture of a phone/computer/app UI (including cropped screenshots and screenshots-of-screenshots), `false` for a photograph. When `true`, every scene field below is `null` (the "screenshot short-circuit"). |
| `nudity`            | `none` \| `suggestive` \| `explicit`. See "Nudity ladder and auto-hide" below.                                                                                                                                                    |
| `caption`           | 1–2 sentence search-oriented description. Mirrored to top-level `description`.                                                                                                                                                    |
| `subjects[]`        | Categorical subject types: `person`, `child`, `adult`, `dog`, `bird`, `vehicle`, `building`, …                                                                                                                                    |
| `scene_type`        | `indoor` \| `outdoor` \| `aerial` \| `macro` \| `studio` \| `mixed` \| `null` (screenshot).                                                                                                                                       |
| `setting`           | Specific environment (`kitchen`, `beach`, `forest`, …), `null` when unidentifiable, or `null` (screenshot).                                                                                                                       |
| `activity`          | What is happening, `null` for a static scene, or `null` (screenshot).                                                                                                                                                             |
| `time_of_day`       | `morning` \| `midday` \| `afternoon` \| `golden hour` \| `evening` \| `night` \| `unknown` \| `null` (screenshot).                                                                                                                |
| `lighting`          | `natural` \| `artificial` \| `mixed` \| `low-light` \| `backlit` \| `flash` \| `unknown` \| `null` (screenshot).                                                                                                                  |
| `weather`           | `clear` \| `cloudy` \| `rainy` \| `snowy` \| `foggy` \| `indoor` \| `unknown` \| `null` (screenshot).                                                                                                                             |
| `mood`              | 1–3 words.                                                                                                                                                                                                                        |
| `colors[]`          | Dominant colors, max 5.                                                                                                                                                                                                           |
| `composition`       | `wide shot` \| `close-up` \| `portrait` \| `landscape` \| `aerial` \| `macro` \| `null` (screenshot). `candid` left this enum in v5 — it's a shot-type concept.                                                                   |
| `text_visible`      | Readable text transcribed verbatim (case + line order preserved), or `null` when nothing is legible. Always mirrored into `ocr_text` by the describe stage.                                                                       |
| `notable_objects[]` | Distinctive objects, max 8.                                                                                                                                                                                                       |
| `shot_type`         | `action` \| `static` \| `candid` \| `posed` \| `architectural` \| `nature` \| `event` \| `null` (screenshot).                                                                                                                     |

`indoor_outdoor` (prompt v4 and earlier) was dropped in v5 — it's fully derivable from `scene_type`, and the parser's synonym map had accreted entries mopping up the model's own confusion between the two. Rows written under `prompt_version <= 4` still carry `indoor_outdoor` and a boolean `nudity_detected` instead of `nudity`; both fields stay on `VisionDoc` as deprecated-optional so readers can fall back until the `targetVersion: 6` re-run rewrites every row.

`vision_meta` carries the provenance: `provider` (`ollama` \| `anthropic` \| `openai` \| `gemini`), `model` (e.g. `qwen3-vl:8b`), `prompt_version`, `generated_at`, `raw_response_size` (bytes of the model's raw JSON response — helps spot truncation).

**Nudity ladder and auto-hide.** Prompt v4's `nudity_detected` boolean is now a three-point ladder: `explicit` (exposed genitals, buttocks, or female breasts/nipples — including in art, on statues, or on a screen within the image), `suggestive` (sexualized posing or underwear/lingerie-focused framing without exposure), and `none` (everything else, including swimwear, shirtless men, and ordinary family bath or beach photos). The describe stage's auto-hide safety net (`src/api/src/workers/stages/describe.ts`) fires only on `explicit` — `suggestive` leaves the asset visible. This preserves the old boolean's semantics: the v4 prompt's bare "contains nudity" question was written to mean what v5 calls `explicit`, so the hide threshold hasn't moved, it's just no longer conflating a nude photo with a shirtless-at-the-beach photo. `sidecar-metadata-index.ts`'s `nativeHidden` computation reads `vision.nudity === 'explicit'`, with a `vision.nudity_detected === true` fallback for stale v4 rows that haven't been re-captioned yet.

**Preview dependency.** The describe stage reads the 1280-px JPEG written by the new `preview` stage (between `thumb` and `describe`; `dependsOn: ["thumb"]`; output at `<folder>/.maple/previews/<basename>_1280.jpg`). The 512-px thumb is too small for reliable captions or OCR on a 24 MP photo; the preview is sized to give the VLM enough resolution without blowing the VRAM budget. See `src/api/src/workers/stages/preview.ts` and `src/api/src/indexer/previewer.ts`.

**Re-running on prompt or model swaps.** Two knobs drive invalidation:

- `prompt_version` (on `description_meta` / `vision_meta`). Bump the constant in `enrichment-config.repo.ts`; the runtime treats any asset whose stored `prompt_version` is below the current value as pending.
- Stage `targetVersion` on `describe`. Bumping it in `defineStage` re-queues every asset for the stage.

Either knob causes existing assets to re-run the describe stage on their own. No backfill script, no admin route — the per-asset bookkeeping in `enrichment.<stage>` does the work.

**OCR.** `ocr_text` is populated from `vision.text_visible` by the describe stage on every pass; `ocr_meta.engine === "qwen2.5-vl"` always. There is no separate OCR worker — the parallel Tesseract stage was removed in #158 because nothing consumed its per-word bboxes.

**`search_blob` fan-in.** `composeSearchBlob` in `src/api/src/enrichment/search-blob.ts` folds `vision.subjects`, `vision.setting`, `vision.activity`, and `vision.notable_objects` into the per-asset search blob. The `meili` stage threads them through, so existing typo-tolerant text search benefits without any new infrastructure. Meili `targetVersion` was bumped to invalidate prior index entries.

**Database-only.** Vision data is never written to the XMP sidecar — see `docs/xmp-canonical-format.md` § "What does not live in XMP" for the rationale.

## 7. Operations

### 7.1 Status surface

The existing indexer status route gets per-worker fields:

```json
{
  "fastPipeline": { /* existing pipeline status */ },
  "enrichment": {
    "geocode":  { workerId, claimsInFlight, completedSinceBoot, deadLetterCount,
                  oldestPendingAge, lastError },
    "face":     { ... },
    "describe": { ... }
  }
}
```

Backfill counts: `db.assets.countDocuments({ "enrichment.geocode.doneAt": null, "exif.gps.lat": { $ne: null } })` — how many photos are still waiting to be geocoded.

### 7.2 Dead-letter inspection

A `GET /api/admin/dead-letter?stage=geocode&limit=50` route returns the last 50 dead-lettered geocode jobs with their `lastError`. Operator can `POST /api/admin/dead-letter/reset?stage=geocode&assetId=...` (or `/reset-all?stage=geocode`) to clear the dead-letter and re-claim.

This is the prerequisite mentioned in `workers-architecture.md` §11 — must ship before external-dependency stages do.

### 7.3 Versioned re-runs

Each handler has a `version: number`. When you fix a parser bug or upgrade the AI model, bump the version and run:

```js
db.assets.updateMany(
  { 'enrichment.geocode.version': { $lt: 2 } },
  {
    $set: {
      'enrichment.geocode.doneAt': null,
      'enrichment.geocode.attempts': 0,
    },
  },
);
```

The worker picks up the affected assets on its next claim. No batch infrastructure needed.

## 8. Implementation plan

Phased so each phase is shippable and the user gets value before the next phase lands.

**Phase 1 — skeleton upsert.** Modify `runMongo` in the existing pipeline to write the skeleton schema. Add `enrichment` subdocument with all stages set to pending. Browse UI starts showing photos faster. No new workers yet. ~1 day.

**Phase 2 — geocode worker.** Wire the worker to the existing Nominatim instance via `MAPLE_NOMINATIM_URL`. Build the worker loop, startup health check, coordinate cache, `Place` schema, and the rate-limit / circuit-breaker controls. Deploy. Backfill existing assets. ~3-4 days (Nominatim already runs on Proxmox; Maple is just a client).

**Phase 3 — search.** Add `place.searchBlob` denormalization, the text index, the search route. Faceted browse indexes. ~2 days.

**Phase 4 — dead-letter inspection + admin routes.** ~1 day. Should land before phase 5.

**Phase 5 — face worker.** Pulls in ONNX + RetinaFace/MobileFaceNet. Independent of everything above. ~3-5 days for first cut.

**Phase 6 — describe worker.** LLM provider integration. Rate limit + cost cap. ~2-3 days.

**Phase 7 — Meilisearch for typo tolerance.** Sidecar, sync from geocode worker, search route fans out. ~2-3 days.

Total: ~3-4 weeks of focused work, deliverable in ~7 useful checkpoints.

## 9. Open questions

- **Polling rate.** Default 1 Hz feels right; revisit if first-paint enrichment lag is noticeable.
- **In-process vs out-of-process workers.** Phase 2 can be in-process (same Bun runtime as the API). Phase 5 (face) probably wants its own process for GPU access. The architecture supports both — no decision needed up front.
- **Fallback to public Nominatim if the private instance is unreachable?** Tempting (resilience) but the public Nominatim service has a 1 req/s rate-limit ToS — we'd violate it instantly while processing a backlog. Recommend NO fallback; dead-letter cleanly and surface the outage to the operator instead.
- **Should the worker live on the same host as Maple's API or near Nominatim?** Either works. Same-host is operationally simpler and the per-call latency is fine (LAN to Proxmox is ~1 ms). Co-locating with Nominatim only helps if you also move the asset-doc reads/writes there, which we don't want.
- **Meilisearch index size.** ~1KB per asset is generous; 100k assets = 100MB. Fine.
- **What gets deleted when an asset is removed?** The `place` data is on the asset doc, so it goes with the soft-delete. The cache row in `geocode_cache` survives — that's correct (other assets may reuse it). The Meilisearch entry needs explicit deletion — the soft-delete path in `runMongo` should also enqueue a Meilisearch tombstone.

## 10. References

- Existing fast pipeline: `docs/workers-architecture.md`, `src/api/src/indexer/pipeline.ts`.
- Nominatim docs: https://nominatim.org/release-docs/latest/
- Geofabrik downloads: https://download.geofabrik.de/
- Meilisearch (deferred to phase 7): https://www.meilisearch.com/

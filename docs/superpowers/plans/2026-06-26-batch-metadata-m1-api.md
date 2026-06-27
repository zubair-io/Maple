# Batch Metadata M1 — Server-side API foundation

- **Ticket:** #1580 (epic #1575)
- **Branch:** `claude/m1-batch-metadata-api`
- **Status:** Implementation plan

## What M1 builds

1. `metadata_override` schema additions to `AssetDoc`
2. Effective-metadata resolver (pure function, unit-tested)
3. Server-side XMP metadata parser (Bun-compatible, no DOMParser)
4. Polled `override-ingest` stage (reads sidecar → updates `metadata_override` → recomputes derived fields)
5. `POST /api/xmp/batch` — bulk sidecar write + dirty-mark
6. `GET /api/geocode/search?q=` — Nominatim forward geocode proxy

---

## Server-side XMP parse decision

The web `XmpParserService` uses Angular DI + browser `DOMParser`, which is **not available in Bun**
(verified: `ReferenceError: DOMParser is not defined`). There is also no XML library in
`src/api/package.json`.

**Chosen approach:** a purpose-built regex/string parser in `src/api/src/xmp/metadata-parser.ts`
that mirrors the field set and semantics of `XmpParserService.parseMetadata()`:

- Walk `rdf:Description` attributes with a regex: `/ ([\w:]+)="([^"]*)"/g`
- For nested lang-alt/seq elements: extract each block with a regex and pull the first
  `<rdf:li>` text content
- Mirror the same field mappings and decode functions (`gpsFromXmp`, `altitudeFromXmp`,
  `copyrightStatusFromMarked`) — those pure functions live in the shared
  `src/web/projects/maple-common/src/lib/xmp/xmp-metadata.ts` which IS importable (pure TS, no
  Angular DI). Rather than re-export from web (introduces a cross-project import that would
  break bundling), we **copy the small decode functions** (`gpsFromXmp`, `altitudeFromXmp`,
  `altitudeFromXmp`, `copyrightStatusFromMarked`) into the API module verbatim — they are
  ~30 lines total and byte-stable pure math that has a test. A comment records the canonical
  source location.

This keeps zero new runtime dependencies. The parser is tested with real XMP strings.

---

## File map

```
src/api/src/
  xmp/
    metadata-parser.ts          NEW  server-side XMP metadata parse (regex, no DOMParser)
    metadata-parser.test.ts     NEW  unit tests (TDD)
  metadata/
    override-resolver.ts        NEW  effective resolver + captured_year/month recompute
    override-resolver.test.ts   NEW  unit tests (TDD)
  workers/stages/
    override-ingest.ts          NEW  polled stage: sidecar → metadata_override → dirty geocode
    override-ingest.test.ts     NEW  unit tests (TDD, no Mongo)
  routes/
    xmp-batch.ts                NEW  POST /api/xmp/batch
    xmp-batch.test.ts           NEW  integration tests (temp dir + in-mem Mongo)
    geocode-search.ts           NEW  GET /api/geocode/search?q=
    geocode-search.test.ts      NEW  unit tests (mock Nominatim)
  db/schema.ts                  EDIT add MetadataOverride interface + AssetDoc.metadata_override
  workers/stages/manifest.ts    EDIT add override-ingest stage
  index.ts                      EDIT register xmm-batch and geocode-search routes
```

---

## Tasks (TDD order)

### Task 1 — schema: `metadata_override` + `MetadataOverride` interface

**File:** `src/api/src/db/schema.ts`

Add to `AssetDoc`:

```typescript
export interface MetadataOverride {
  edited_at: string; // ISO 8601
  touched_fields: string[];
  gps?: { lat: number; lng: number; alt?: number } | null;
  captured_at?: string | null;
  time_zone?: string | null;
  place_text?: {
    sublocation?: string | null;
    city?: string | null;
    state?: string | null;
    country?: string | null;
    country_code?: string | null;
  } | null;
  keywords?: string[] | null;
  title?: string | null;
  caption?: string | null;
  headline?: string | null;
  instructions?: string | null;
  creator?: string | null;
  creator_job_title?: string | null;
  copyright_notice?: string | null;
  copyright_status?: 'unknown' | 'copyrighted' | 'public-domain' | null;
  usage_terms?: string | null;
  credit?: string | null;
  source?: string | null;
}
```

And on `AssetDoc`:

```typescript
metadata_override?: MetadataOverride | null;
```

No migration needed — sparse subdoc, absent until written by `override-ingest`.

---

### Task 2 — server-side XMP metadata parser

**Files:** `src/api/src/xmp/metadata-parser.ts`, `metadata-parser.test.ts`

`parseXmpMetadata(xml: string): XmpMetadataResult`

where `XmpMetadataResult` mirrors `XmpMetadata` from the web layer (same field names, same decode
semantics), plus `keywords: string[]`.

**Algorithm:**

1. Extract `rdf:Description` element (or the whole XML if no wrapper) — regex on `<rdf:Description[^>]*>`.
2. Pull attribute string from the opening tag: regex `/ ([\w:.-]+)="([^"]*)"/g`
3. Map attribute names → field values using the same lookup table as the web parser.
4. For nested elements (dc:title, dc:creator, dc:description, dc:rights, xmpRights:UsageTerms):
   regex `/<(dc:title|dc:creator|...) *>.*?<rdf:li[^>]*>(.*?)<\/rdf:li>/s`
5. For keywords (dc:subject bag): regex to extract all `<rdf:li>` inside `<dc:subject>`.

**Decode functions copied from `xmp-metadata.ts`:** `gpsFromXmp`, `altitudeFromXmp`, `copyrightStatusFromMarked`.

**Test cases (minimal, exact XMP snippets):**

- GPS latitude/longitude/altitude round-trip
- dateTimeOriginal, timeZone (papp:TimeZone)
- Sublocation, city, state, country, countryCode (IPTC text attrs)
- dc:title lang-alt block
- dc:creator seq block
- dc:description lang-alt
- dc:rights + xmpRights:UsageTerms lang-alt
- xmpRights:Marked → copyrightStatus
- Keywords bag
- Empty / missing fields → undefined
- Malformed XML → returns empty object

---

### Task 3 — effective resolver

**Files:** `src/api/src/metadata/override-resolver.ts`, `override-resolver.test.ts`

```typescript
export interface EffectiveMetadata {
  captured_at: string | null;
  captured_year: number | null;
  captured_month: number | null;
  gps: { lat: number; lng: number } | null;
  time_zone: string | null;
  place_text: MetadataOverride['place_text'];
}

export function effectiveMetadata(
  doc: Pick<AssetDoc, 'exif' | 'metadata_override'>,
): EffectiveMetadata;
```

Rule: `override.field ?? exif.field ?? null`.

`captured_year`/`captured_month` recomputed from effective `captured_at` (UTC year/month from ISO
string). GPS uses `{lat, lng}` only (altitude stays in the override for the batch editor, not in
`exif.gps`).

**Test cases:**

- No override: returns exif values
- Override GPS: returns override GPS, exif captured_at
- Override captured_at: returns new year/month derived from it
- Partial override: only touched fields win
- Override with null GPS: GPS becomes null (explicit clear)
- No exif, no override: all nulls

---

### Task 4 — server-side metadata parser integration tests

Extend Task 2 tests with a full round-trip: `xmp-serializer → metadata-parser → assert fields`.
Use the serializer output from the web layer's test fixture XMP strings copied here.

---

### Task 5 — `override-ingest` stage

**Files:** `src/api/src/workers/stages/override-ingest.ts`, `override-ingest.test.ts`

```typescript
export const OVERRIDE_INGEST_VERSION = 1;

const overrideIngestStage = defineStage({
  name: 'override-ingest',
  targetVersion: OVERRIDE_INGEST_VERSION,
  dependsOn: ['exif'],
  defaults: {
    concurrency: 4,
    maxAttempts: 3,
    paused: false,
    last_seen_target_version: 0,
    pausedOnFirstBoot: false,
  },
  handler: overrideIngestHandler,
});
```

**Handler algorithm:**

1. Resolve asset's sidecar path via `assetAbsPath` + `xmpSidecarPath`.
2. Read sidecar (ENOENT → `{ skip: 'no-sidecar' }`).
3. Parse with `parseXmpMetadata`.
4. If no metadata fields present → `{ skip: 'no-metadata' }`.
5. Build `MetadataOverride` from parsed fields. Set `edited_at = new Date().toISOString()`, `touched_fields` = array of non-null field keys.
6. Build patch: `{ metadata_override: override }`.
7. If GPS changed: set `stages.geocode.version = 0` to re-trigger geocode (the `patch` cannot set `stages.*` — call a targeted `$set` on geocode stage instead via a separate `updateOne`).
8. Recompute `captured_year`/`captured_month` from effective captured_at, include in patch.
9. Return `{ patch }`.

**Stage dirty-mark:** the `POST /api/xmp/batch` route uses a targeted `$set` to reset
`stages.override-ingest.version = 0` for each asset, which the claim query picks up as "needs processing".

**Unit tests (no Mongo):** test the handler logic in isolation by injecting fake docs and asserting the returned patch.

---

### Task 6 — `POST /api/xmp/batch`

**File:** `src/api/src/routes/xmp-batch.ts`

```
POST /api/xmp/batch
Body: JSON { entries: Array<{ path: string; metadata: XmpMetadataInput }> }
```

Where `XmpMetadataInput` is `XmpMetadata & { keywords?: { op: 'add'|'remove'|'replace'; values: string[] } }`.

**Per-entry algorithm:**

1. `resolveAndAuthorizePath(entry.path)` — reuse the same helper from `routes/xmp.ts` (extract to
   shared module `routes/xmp-path-auth.ts` or import directly).
2. Read existing sidecar (or start with empty stub).
3. Parse existing metadata + culling; merge in the new fields; re-serialize the full XMP using the
   existing serializer approach (for the batch route, we write ONLY the metadata attributes: we
   build the metadata attr string and nested blocks and inject them into the existing sidecar, or
   create a minimal stub sidecar if none exists).
4. `writeXmpAtomic` (atomic temp+rename).
5. Find asset in DB by path (query `fileinfo.path` + `fileinfo.library_id`): mark override-ingest
   stage dirty (`$set: { 'stages.override-ingest.version': 0 }`).

**Response:** `{ results: Array<{ path: string; ok: boolean; error?: string }> }` — per-asset
status; partial failures don't roll back successes.

**Integration tests:** use a temp dir with a real `.xmp` file, in-mem MongoDB (mongodb-memory-server
is in devDeps), assert sidecar written + stage marked dirty.

---

### Task 7 — `GET /api/geocode/search?q=`

**File:** `src/api/src/routes/geocode-search.ts`

```
GET /api/geocode/search?q=<query string>
```

Proxies Nominatim `/search?q=...&format=jsonv2&addressdetails=1&limit=5`.

Add `search(q: string): Promise<NominatimSearchResult[]>` method to `NominatimClient`.

Response shape:

```typescript
interface GeocodeSuggestion {
  displayName: string;
  lat: number;
  lon: number;
  address: NominatimAddress; // same shape as place-parser's PlaceAddress
}
```

Rate-limited via the same token-bucket. Requires nominatim URL configured. Returns 503 when
nominatim not configured; empty array when no results. No caching on search (forward search is for
UI typeahead, not a hot path).

**Unit tests:** mock fetchImpl; assert URL built correctly, results mapped, rate limit honoured.

---

## Registration

- `manifest.ts`: add `overrideIngestStage` to `stageManifest` + `ALL_STAGE_NAMES`.
- `index.ts`: import + use `xmpBatchRoutes` and `geocodeSearchRoutes`.

---

## Exact test commands

```bash
# Unit tests only (fast, no MongoDB needed):
cd src/api && bun test src/xmp/metadata-parser.test.ts
cd src/api && bun test src/metadata/override-resolver.test.ts
cd src/api && bun test src/workers/stages/override-ingest.test.ts
cd src/api && bun test src/routes/geocode-search.test.ts

# Integration tests (spins mongodb-memory-server):
cd src/api && bun test src/routes/xmp-batch.test.ts

# Full suite (gate: ≥ same pass count as baseline, no NEW tsc errors):
cd src/api && bun test
```

---

## Notes

- 600-line file budget: `override-ingest.ts` should stay under 200 lines; split handler helpers
  into `override-ingest-helpers.ts` if needed.
- `resolveAndAuthorizePath` is duplicated in `routes/xmp.ts`. The batch route imports it from
  there or we extract a shared helper — prefer extraction to `src/routes/xmp-path-auth.ts` to
  avoid a circular dep and keep each file under budget.
- The `override-ingest` stage does NOT depend on `geocode` — it runs first and then triggers
  geocode re-run. `dependsOn: ['exif']` is correct.
- GPS change detection for geocode re-trigger: compare the parsed lat/lng from the sidecar against
  `doc.metadata_override?.gps` — if different, reset geocode stage. On first run (no existing
  override) always trigger geocode if GPS is present.

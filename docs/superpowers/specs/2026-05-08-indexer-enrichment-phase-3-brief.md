# Brief — Indexer enrichment, Phase 3: search

Status: ready for Claude Code · scope: ~2-3 days · prerequisite: Phase 2 landed

## What to build

Make assets searchable by location text (`Albany NY`, `NY`, `Park`) and browsable as a faceted location tree (country → state → city). Implementation: denormalize a `searchBlob` field on each asset's `place`, put a Mongo text index on it, add compound indexes for faceted browse, and expose a `/api/search` route plus a `/api/places/tree` route.

This phase does NOT include typo tolerance — `Musum` won't match `Museum` until Phase 7 adds Meilisearch. Everything else from the user's stated requirements (`Albany NY`, `NY`, `Park`) works after this phase.

The full design is in `docs/indexer-enrichment.md` §5. Read it first.

## Scope — do this

1. **`buildSearchBlob(place)` function** (`src/api/src/enrichment/search-blob.ts`).
   - Input: `Place` (the schema in §4.4).
   - Output: a single space-separated lowercase string containing every word a search should match.
   - Construction rules (from §5.2):
     - All non-empty `address.*` values, lowercased.
     - The `stateCode` (e.g. `NY`).
     - The `countryCode` upper-cased AND the `country` full name (so both `US` and `United States` match).
     - For each entry in `pois[]`: the `name`, the `category`, and the `type` — all three. So a museum asset's blob includes `museum tourism New York State Museum`, which matches both `Museum` (category) and the proper name.
     - Deduplicate words; trim; collapse whitespace.
   - Pure function. Unit tests against fixed `Place` inputs producing fixed `searchBlob` strings.

2. **Wire into the geocode worker.**
   - In `geocode-worker.ts`'s `complete()`: also write `place.searchBlob = buildSearchBlob(place)` in the same `updateOne` that sets `place` and `enrichment.geocode.doneAt`. One write, not two.
   - Don't create a new stage. The `searchBlob` is part of the geocode worker's output, not its own enrichment step.

3. **Indexes.** In whichever file owns Mongo index management (or create one if missing):
   - Text index: `db.assets.createIndex({ "place.searchBlob": "text" }, { default_language: "english", name: "place_searchBlob_text" })`.
   - Faceted browse compound index: `{ "place.rollups.countryCode": 1, "place.rollups.region": 1, "place.rollups.locality": 1 }`. Name: `place_rollups_facets`.
   - Run on startup if missing. Idempotent — `createIndex` is safe to re-run.

4. **Backfill route or script.** Existing geocoded assets (from Phase 2 backfill) have `place` set but no `searchBlob` — they need one.
   - Implement `POST /api/admin/enrichment/backfill-search-blob` (auth-gated; same auth pattern as the existing admin routes).
   - It iterates `db.assets.find({ "place": { $ne: null }, "place.searchBlob": { $exists: false } })` and runs `buildSearchBlob` for each, in batches of 500. Reports progress in the response.
   - Idempotent — re-running is a no-op once everything is backfilled.

5. **Search route** — `GET /api/search`.
   - Query params: `q` (required string), `limit` (default 50, max 200), `offset` (default 0), optionally `folderId` to scope.
   - Mongo query:
     ```ts
     db.assets.find(
       { $text: { $search: q }, /* optional folderId, soft-delete filter */ },
       { score: { $meta: "textScore" } }
     )
     .sort({ score: { $meta: "textScore" }, "exif.captured_at": -1 })
     .skip(offset).limit(limit)
     ```
   - Response: `{ results: AssetSummary[], total: number, hasMore: boolean }`. `AssetSummary` is whatever shape the existing browse routes return — reuse, don't invent.
   - Empty `q` → return empty results, not all assets, not error.
   - Tests cover: `Albany NY` matches Albany-NY assets; `NY` matches all NY-state assets including those without "Albany" in the address; `Park` matches assets at parks AND assets near parks via POI; `Musum` returns empty (typo tolerance is Phase 7); pagination works; soft-deleted assets are excluded.

6. **Faceted browse route** — `GET /api/places/tree`.
   - Query params: `country?` (ISO code), `region?` (state name). Hierarchical drill-down.
   - No `country` → group by `countryCode`, return `[{ countryCode, count }]`.
   - With `country` → filter by countryCode, group by `region`, return `[{ region, count }]`.
   - With `country` + `region` → filter both, group by `locality`, return `[{ locality, count }]`.
   - Use Mongo aggregation `$match` + `$group` + `$sort`. The compound index from step 3 is the access path.
   - Excludes soft-deleted assets and assets with `place: null`.

7. **Tests.**
   - Unit tests for `buildSearchBlob` against several `Place` shapes (museum, just a road, no POIs, no city, etc.).
   - Integration tests for the search route with seeded asset data covering the four query examples.
   - Integration tests for the faceted-browse route at each drill-down level.
   - The backfill route test: insert geocoded assets without `searchBlob`, hit the route, verify they all have one.

## Scope — do NOT do this

- **Do not implement Meilisearch or typo tolerance.** Phase 7. The `Musum` query returning empty is correct behavior for Phase 3.
- **Do not change the geocode worker's structure.** The only change there is calling `buildSearchBlob` inside `complete()`.
- **Do not implement a search UI.** This is API-layer only.
- **Do not add new POI extraction logic to the place-parser.** If something the user wants to search for isn't in the blob, it's because the parser didn't extract it — fix that in `place-parser.ts` if needed, but resist scope creep into "let's also extract Wikipedia tags" and similar.

## Files you'll likely touch

New:
- `src/api/src/enrichment/search-blob.ts`
- `src/api/src/enrichment/search-blob.test.ts`
- `src/api/src/routes/search.ts` (and corresponding test file)
- `src/api/src/routes/places-tree.ts` (and test)
- `src/api/src/routes/admin-backfill-search-blob.ts` (and test)

Modified:
- `src/api/src/enrichment/geocode-worker.ts` — call `buildSearchBlob` in `complete()`.
- The Elysia router wiring file — register the new routes.
- The index management file — add the two new indexes to whatever startup-ensures-indexes function exists.

## Constraints

- **Index creation must be idempotent.** Code that runs on every API boot — do not crash if the index is already there.
- **Search must scope to non-deleted assets.** Match whatever soft-delete filter the existing browse routes use.
- **Pagination consistency.** When the user paginates, the result order must be stable. Use a tie-breaker (e.g. `_id`) in the sort if `score` and `captured_at` collide.
- **The text index has one limit:** Mongo allows only ONE text index per collection. Don't try to add a second on a different field; if you need to also search filenames, fold them into `searchBlob` (not in scope here, just a note).

## Acceptance

1. `cd src/api && bun test` passes.
2. With seeded data: `GET /api/search?q=Albany+NY` returns Albany-NY photos. `GET /api/search?q=NY` returns all NY-state photos. `GET /api/search?q=Park` returns photos at parks. `GET /api/search?q=Musum` returns nothing (expected; Phase 7 fixes this).
3. `GET /api/places/tree` returns a list of countries with counts. Drilling in (`?country=US`) returns states with counts. Drilling further (`?country=US&region=New+York`) returns localities.
4. Backfill route: against a DB with geocoded assets missing `searchBlob`, one POST populates them all. Re-running is a no-op.
5. The text index and the compound index appear in `db.assets.getIndexes()`.

## Out-of-scope follow-ups

- Phase 4: dead-letter inspection admin route.
- Phase 5: face worker.
- Phase 6: describe worker.
- Phase 7: Meilisearch sidecar for typo tolerance.

Reference: `docs/indexer-enrichment.md` §8.

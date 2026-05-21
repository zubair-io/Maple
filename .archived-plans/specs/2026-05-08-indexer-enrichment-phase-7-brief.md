# Brief — Indexer enrichment, Phase 7: Meilisearch sidecar

Status: ready for Claude Code · scope: ~2-3 days · prerequisite: Phase 3 landed

## What to build

Add typo-tolerant search by running Meilisearch as a sidecar service alongside Maple. The geocode worker pushes `{ assetId, searchBlob, ...facets }` to Meilisearch when it finishes geocoding; the search route queries Meilisearch first, with a graceful fallback to the existing Mongo text-index path if Meilisearch is unconfigured or unreachable.

After this phase, `Musum` matches `Museum`, `Pak` matches `Park`, etc. The Mongo text-index path from Phase 3 stays intact as a fallback.

Background: `docs/indexer-enrichment.md` §5.5. The sidecar deployment shape mirrors Nominatim — operator runs Meilisearch elsewhere (Proxmox VM, Docker container, separate host), Maple is purely a client.

## Scope — do this

1. **Meilisearch deployment.** Document but do not perform.
   - Add `docs/operations/meilisearch.md` with: how to run Meilisearch (single binary or Docker; `meilisearch --master-key=...`); what to set `MAPLE_MEILISEARCH_URL` to; how to obtain and configure the API key; minimum version (latest stable v1.x at time of writing).
   - The doc should also cover the index settings the client expects (typo tolerance is on by default; we tune `searchableAttributes` and `filterableAttributes`).

2. **Meilisearch client** (`src/api/src/enrichment/meilisearch-client.ts`).
   - Wraps the official Meilisearch JS client (or fetch directly — pick whichever has the cleanest type story; the official client is fine).
   - Methods:
     - `health(): Promise<boolean>` — boot-time check.
     - `ensureIndex(): Promise<void>` — creates `assets` index if missing; sets `searchableAttributes: ["searchBlob"]`, `filterableAttributes: ["folderId", "deletedAt"]`, `sortableAttributes: ["capturedAt"]`. Idempotent.
     - `upsert(doc): Promise<void>` — `{ id, searchBlob, folderId, capturedAt, deletedAt }`. The `id` is the asset's mapleId.
     - `tombstone(id): Promise<void>` — used on soft-delete.
     - `search(q, opts): Promise<{ ids: string[], estimatedTotal: number }>` — returns asset ids only; the route fetches asset summaries from Mongo.
   - Configurable `MAPLE_MEILISEARCH_URL` and `MAPLE_MEILISEARCH_API_KEY`. If `URL` is unset, every method is a no-op (returns success/empty). This is the "Meilisearch is optional" fallback.

3. **Sync from geocode worker.**
   - In `geocode-worker.ts`'s `complete()`, after the `updateOne`, call `meilisearchClient.upsert({ id: asset.mapleId, searchBlob: place.searchBlob, folderId, capturedAt, deletedAt: null })`.
   - Failures here do NOT fail the geocode job. Log the error, continue. The asset is still searchable via Mongo text index.
   - This is fire-and-forget: don't block the worker on Meilisearch latency.

4. **Sync on soft-delete.** Find the existing soft-delete code path in the indexer or asset routes (it sets `deletedAt`). After it runs, call `meilisearchClient.tombstone(mapleId)`. Same fire-and-forget semantics.

5. **Search route.** Modify the existing `/api/search` route from Phase 3:
   - If Meilisearch is configured AND healthy: query Meilisearch with `q`, get back ids, fetch asset summaries from Mongo with `db.assets.find({ mapleId: { $in: ids } })`, preserve Meilisearch's order.
   - If Meilisearch is unconfigured OR the call fails: fall back to the existing Mongo text-index path. Log the fallback at warn level so operators see it.
   - Pagination: pass `offset` / `limit` to Meilisearch's `offset` / `limit`. Meilisearch's `estimatedTotalHits` becomes our `total`.
   - Filters: `folderId` and "exclude soft-deleted" go through Meilisearch's filter syntax (`folderId = "..." AND deletedAt IS NULL`).

6. **Backfill route.**
   - `POST /api/admin/enrichment/backfill-meilisearch` — iterates assets with `place.searchBlob` set, batches 1000 at a time, upserts to Meilisearch. Idempotent.
   - For seeding a fresh Meilisearch instance from an existing Mongo population.
   - Run the backfill as part of the rollout; the route also lets operators re-seed after Meilisearch data loss.

7. **Tests.**
   - Mock Meilisearch in tests (don't depend on a real instance running). The official client supports a fake transport, or fetch-mock.
   - Cover:
     - `MAPLE_MEILISEARCH_URL` unset → all client methods no-op, search route falls back to Mongo cleanly.
     - Meilisearch healthy → search route uses Meili, returns ids in Meili's order.
     - Meilisearch errors → search route logs, falls back to Mongo, request still succeeds.
     - `Musum` query against a mocked Meilisearch returns the mocked museum doc; against the Mongo fallback returns empty.
     - Geocode worker `complete()` writes to both Mongo and Meilisearch; if Meili upsert fails, the Mongo update still succeeds.
     - Soft-delete tombstones in Meilisearch.
     - Backfill route hits every asset with a `searchBlob`.

## Scope — do NOT do this

- **Do not deploy Meilisearch.** Operations is the operator's job; the deliverable here is the client + sync + route + docs, not a running instance.
- **Do not remove the Mongo text index.** It stays as the fallback. The whole point of "optional Meilisearch" is that Maple keeps working without it.
- **Do not** add Meilisearch-specific features (faceting via Meilisearch, geographic search via Meilisearch's geo features, etc.). Phase 7 is strictly typo-tolerant text search. Geo-faceting stays on the Mongo path from Phase 3.
- **Do not** make Meilisearch the source of truth. Mongo is canonical. Meilisearch is a derived index.

## Files you'll likely touch

New:
- `src/api/src/enrichment/meilisearch-client.ts`
- `src/api/src/enrichment/meilisearch-client.test.ts`
- `src/api/src/routes/admin-backfill-meilisearch.ts` (and test)
- `docs/operations/meilisearch.md`

Modified:
- `src/api/src/enrichment/geocode-worker.ts` — fire-and-forget Meilisearch upsert in `complete()`.
- The asset soft-delete code path (find via grep for `deletedAt`) — call `tombstone` after the Mongo update.
- `src/api/src/routes/search.ts` — try Meilisearch first, fall back on miss/error.
- `src/api/src/main.ts` — call `meilisearchClient.health()` and `ensureIndex()` at boot if URL is set; warn (don't fail) if health check fails.
- `src/api/.env.example` — `MAPLE_MEILISEARCH_URL`, `MAPLE_MEILISEARCH_API_KEY`.

## Constraints

- **Failure must not propagate.** A Meilisearch outage degrades search to Mongo-text quality; it does not break the API. Every Meilisearch call is wrapped to log-and-swallow except for `health()` (which returns a boolean) and the explicit backfill route (where errors should surface to the operator).
- **Eventually consistent is fine.** A few seconds of lag between Mongo write and Meilisearch index is acceptable.
- **Don't put PII in Meilisearch beyond what's already in `searchBlob`.** The blob is location text — addresses are public. If anyone later wants to add filenames or descriptions to the blob, separately review the privacy/exfiltration model.
- **Index size is small.** Estimate: ~1KB per asset, ~100MB for 100k assets. Meilisearch handles this trivially. Don't over-engineer for scale.

## Acceptance

1. `cd src/api && bun test` passes.
2. With `MAPLE_MEILISEARCH_URL` unset: API behaves identically to Phase 3. All existing tests still pass. `GET /api/search?q=Park` works via Mongo.
3. With a running Meilisearch and the backfill route hit once: `GET /api/search?q=Musum` returns museum results. `GET /api/search?q=Pak` returns park results.
4. Stop Meilisearch (kill the process). The API logs a fallback warning; `GET /api/search?q=Park` still works via Mongo. Restart Meilisearch; subsequent searches go back to Meilisearch.
5. Soft-delete an asset; within a few seconds it disappears from Meilisearch results.
6. `docs/operations/meilisearch.md` is sufficient for an operator to stand the service up without reading any code.

## Out-of-scope follow-ups

After Phase 7, the enrichment subsystem is feature-complete for v1. Possible next directions, none in scope here:
- Real-time search via Meilisearch's update events (probably not worth it).
- Multi-language analyzers if photo locations span languages (Meili supports this).
- Search-as-you-type endpoint with `<= 100ms` budget (Meili can do it; route layer needs trimming).

Reference: `docs/indexer-enrichment.md` §5.5 and §8.

# Brief — Indexer enrichment, Phase 1: skeleton mongo upsert

Status: ready for Claude Code · scope: ~1 day · prerequisite for Phases 2+

## What to build

Refactor the existing indexer pipeline's `mongo` stage so it writes an asset "skeleton" row as soon as `exif`/`thumb` finish, instead of accumulating every field in a `PipelineJob` and writing only at the end.

After this change, a freshly-discovered photo appears in the browse API within roughly 200 ms of EXIF parsing, instead of waiting through every (future) external API call. The slow-tier enrichment workers (Phases 2+) will patch the row later via separate processes.

The full architecture is in `docs/indexer-enrichment.md`. Read it first. Phase 1 is described in §1.1 and §8 Phase 1; the asset schema is in §1.1; the per-stage enrichment state contract is in §2.

## Scope — do this

1. **Asset schema.** Add an `enrichment` subdocument to the asset shape:

   ```ts
   interface EnrichmentStageState {
     doneAt: Date | null;
     lockedBy: string | null;
     leaseExpiresAt: Date | null;
     attempts: number;
     lastError: string | null;
     version: number | null;
     deadLetterAt: Date | null;
   }

   interface Enrichment {
     geocode:  EnrichmentStageState;
     face:     EnrichmentStageState;
     describe: EnrichmentStageState;
   }
   ```

   Add `place: Place | null`, `faces: AiFace[]`, `description: string | null` as nullable/empty defaults on the asset.

2. **`runMongo` writes the skeleton.** When inserting a brand-new asset, populate the skeleton with all enrichment stages in pending state (`{ doneAt: null, lockedBy: null, leaseExpiresAt: null, attempts: 0, lastError: null, version: null, deadLetterAt: null }`) and `place: null`, `faces: []`, `description: null`.

3. **Re-upserts must not clobber enrichment state.** If a row already exists with `enrichment.geocode.doneAt` set, a subsequent re-upsert from the indexer (e.g. file mtime changed, watcher re-triggered) must NOT reset `enrichment` or any of the output fields (`place`, `faces`, `description`). It should update only the fast-tier fields (`size`, `mtime`, `sha1Head`, `exif`, etc.). The simplest correct way is `$setOnInsert` for the enrichment + output fields, `$set` for the fast-tier fields.

4. **Backward compat.** Existing rows in production may pre-date the `enrichment` subdocument. The browse-API read path must treat a missing/partial `enrichment` field as "all stages pending" without crashing or returning garbage. Either migrate on read (compute defaults at fetch time) or run a one-time backfill query. Document the choice in the commit message.

5. **Tests.** Round-trip tests against the real Mongo test setup (whatever pattern the existing indexer tests use — don't introduce a new mocking strategy). Cover:
   - Fresh asset → skeleton schema appears with all enrichment stages pending.
   - Re-upsert of an asset whose `enrichment.geocode.doneAt` is set → that field survives unchanged.
   - Re-upsert of an asset whose `place` is non-null → it survives unchanged.
   - Re-upsert updates `mtime` and `sha1Head` if they changed.
   - Read path returns sane defaults when an old row has no `enrichment` field.

## Scope — do NOT do this

- **Do not implement the geocode worker** or any enrichment worker. Phase 2 work.
- **Do not change** the bounded channels, pool sizes, retry/backoff logic, dead-letter mechanism for the fast pipeline, or the watcher.
- **Do not remove** unused fields from `PipelineJob`. The `faces`, `aiTags` fields can stay on the job type (they're written nowhere now); leaving them in place keeps the diff small and Phase 2's diff cleaner.
- **Do not introduce** Meilisearch, change streams, or any new dependency. Phase 1 is pure refactor + schema.

## Files you'll likely touch

- `src/api/src/indexer/pipeline.ts` — `runMongo` and the `defaultUpsert` it calls.
- `src/api/src/indexer/images.repo.ts` — `upsertByMapleId` (or a new variant). This is the function that needs the `$setOnInsert`-vs-`$set` split.
- `src/api/src/db/schema.ts` — add the `Enrichment`, `EnrichmentStageState`, and `Place` types. `Place` should match the schema in `docs/indexer-enrichment.md` §4.4 — declare it now even though it stays `null` until Phase 2.
- The browse-API route handlers (find them via the routes folder) — verify they handle missing/partial `enrichment`. Update read mappers if needed.
- The relevant test files in `src/api/src/indexer/`.

## Constraints

- The fast-pipeline performance characteristics must not regress. The skeleton upsert should be one Mongo operation per asset, not multiple.
- Test pattern: follow the existing indexer test pattern. The repo's `CLAUDE.md` is explicit about preferring real round-trips over mocks where it makes sense — apply that judgment here.
- Type safety: no `any`. The `Enrichment` shape gets used by Phase 2's worker code, so getting the types right now saves work later.

## Acceptance

1. `cd src/api && bun test` passes.
2. After running the indexer end-to-end against a small fixture folder, the resulting asset documents in Mongo match the skeleton schema in `docs/indexer-enrichment.md` §1.1.
3. Re-running the indexer against the same folder does not modify any `enrichment.*.doneAt`, `place`, `faces`, or `description` field on the existing rows.
4. The browse-API route still serves a request for the indexed assets (run it manually or via the existing route test) and returns the new schema with sane defaults for old rows.
5. The diff is contained to the indexer + repo + schema + browse-route mapper + tests. No other subsystem is touched.

## Out-of-scope follow-ups (next prompts)

After Phase 1 lands, the next prompts will cover:

- Phase 2: geocode worker (Nominatim client, coordinate cache, `Place` schema population, claim loop, lease, retry, circuit breaker).
- Phase 3: search (denormalized `searchBlob`, Mongo text index, faceted browse indexes, search route).
- Phase 4: dead-letter inspection admin route.
- Phases 5+: face worker, describe worker, Meilisearch sidecar.

Reference: `docs/indexer-enrichment.md` §8.

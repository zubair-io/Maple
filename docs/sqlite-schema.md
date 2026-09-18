# SQLite schema for the Self Hosted backend

The relational schema that replaces the MongoDB collections in `src/api`. This
document is the design record and the query-to-index map; the DDL itself lives
in `src/api/src/db/sqlite/ddl/` and the migration runner in
`src/api/src/db/sqlite/migrate.ts`.

Schema only. No repository code is ported here and no data is imported — those
are separate pieces of work.

## How it works, in five sentences

An asset is one narrow row in `assets` carrying the fields that browse, search
and facet queries filter, sort or group on. Its three arrays became their own
tables — `asset_locations` for the on-disk copies, `faces` for detections and
`asset_phasset_links` for the Apple Photos links — so "any location matching" is
an ordinary join rather than a rule you have to remember. Per-stage pipeline
bookkeeping moved out of `stages.<name>` on the document into one `stage_state`
table keyed by asset and stage name, which is what collapses 24 near-identical
indexes into 2. The bulky describe-stage payloads live in `asset_detail`, a 1:1
side table a grid page never touches, and the small ones that queries reach into
(`exif`, `place`) stay as JSON on the asset row with generated columns over the
paths that are actually indexed. The synthesised `search_blob` moved to
`asset_search` with an FTS5 index over it, replacing the single Mongo text
index.

## Why narrowness is the whole point

Measured against production on 2026-09-17: the `assets` collection holds 335,377
documents averaging 8 KB, p90 28 KB, max 261 KB, occupying 8.8 GB against a
1.5 GB WiredTiger cache. Anything that touches the whole collection therefore
reads from disk every time, which is why a facet count takes about five seconds
warm or cold.

Porting that document into a single JSON column per row would reproduce the
problem exactly: every filtered query would decode 8 KB per row and the result
would be slower than Mongo, not faster. The win depends on the grid and filter
fields being real columns, so the working set stays in the page cache.

Three rules follow, and they are the ones to push back on in review:

1. A field a query filters, sorts or groups on is a column — either stored, or
   `GENERATED ALWAYS AS (json_extract(...)) VIRTUAL` with an index. An indexed
   generated column materialises its value inside the index, so a facet never
   parses JSON.
2. A payload only ever read back whole lives in `asset_detail`, not on the asset
   row.
3. The two JSON columns that stay on `assets` are declared last. SQLite reads a
   row's columns in declaration order and stops once it has what the statement
   asked for, so a narrow `SELECT` never follows the overflow pages they can
   spill onto.

## Primary keys are TEXT, holding the existing ObjectId hex

Every client-visible primary key is `TEXT PRIMARY KEY` storing the same
24-character lowercase hex string MongoDB produces today, and every foreign key
referencing one is TEXT too.

This is not a preference. `src/api/src/db/assets.transform.ts` emits
`id: doc._id.toHexString()` and `folder_id: …toHexString()` into the DTOs the
HTTP API returns, so those strings are already part of the public contract.
Apple, Web and Windows clients hold them, compare them and derive cache keys
from them — `src/web/projects/maple-common/src/lib/trash/trash.service.ts` has a
`resolveMongoId()` path. The migration's stated non-goal is that clients change,
so the identifiers survive unchanged.

Rows created after the migration need identifiers of the same shape, so
`src/api/src/db/sqlite/object-id.ts` mints them: MongoDB's 12-byte layout
(4-byte seconds, 5-byte per-process random, 3-byte counter) rendered as hex, so
values stay sortable by creation time and `ObjectId.isValid` keeps accepting
them for as long as any mixed-mode path exists. `INTEGER PRIMARY KEY` rowid
aliases are used freely for the internal tables whose ids never reach a client:
`asset_locations`, `faces`, `asset_phasset_links`, `import_files`,
`indexer_queue`, `discover_frontier` and `mirror_queue`.

## Tables

| Table                                                                                                                                                                  | Replaces                                                                                                                      | Notes                                                                             |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `assets`                                                                                                                                                               | `assets` document root                                                                                                        | Narrow. Scalars plus `exif` / `place` JSON and 14 generated columns.              |
| `asset_locations`                                                                                                                                                      | `fileinfo[]`                                                                                                                  | `ordinal` keeps the array position; `ordinal = 0` is the canonical entry.         |
| `asset_detail`                                                                                                                                                         | `vision`, `description`, `ocr_*`, `transcript`, `video_description*`, `metadata_override`, `derivative_audit`, `geo_inferred` | 1:1, `WITHOUT ROWID`. The bulk of the old document.                               |
| `asset_search` + `assets_fts`                                                                                                                                          | `search_blob` + `search_blob_text`                                                                                            | FTS5 in external-content mode.                                                    |
| `asset_phasset_links`                                                                                                                                                  | `phasset_links[]`                                                                                                             | Indexed on `(device_id, phasset_local_id)` — the index that does not exist today. |
| `faces`                                                                                                                                                                | `faces[]`                                                                                                                     | `face_index` keeps the array position, which is on the wire.                      |
| `stage_state`                                                                                                                                                          | `stages.<name>.*`                                                                                                             | `(asset_id, stage)`, `WITHOUT ROWID`, one row per asset per stage.                |
| `enrichment_state`                                                                                                                                                     | `enrichment.<stage>.*`                                                                                                        | The older lease-based claim for `geocode` / `face` / `describe`.                  |
| `people`, `person_merge_dismissals`                                                                                                                                    | same                                                                                                                          | `cover_bbox` and the merge-suggestion head flattened to columns.                  |
| `folders`, `asset_changes`, `server_state`, `mirror_queue`, `geocode_cache`, `presets`                                                                                 | same                                                                                                                          |                                                                                   |
| `jobs`, `imports`, `import_files`, `indexer_queue`, `discover_frontier`, `worker_config`, `stage_handlers`, `backup_sessions`, `upload_sessions`, `apns_device_tokens` | same                                                                                                                          | Queues and configuration.                                                         |
| `users`, `credentials`, `invites`, `refresh_tokens`, `service_api_keys`, `challenges`, `native_auth_codes`, `lan_handoff_codes`, `image_access_tokens`                 | same                                                                                                                          |                                                                                   |
| `app_settings`                                                                                                                                                         | same                                                                                                                          | One JSON document per settings domain — see below.                                |
| `indexer_checkpoints`, `managed_certificates`, `generated_searches`, `video_geo_backfill_audit`                                                                        | same                                                                                                                          | Added by migration `0002`.                                                        |
| `schema_migrations`                                                                                                                                                    | `migrations`                                                                                                                  | The runner's sentinel.                                                            |

### `app_settings` is the one table that is a document, and why

Every other table follows the rule that a field a query filters on is a
column. `app_settings` is the exception, because nothing ever filters it:
all twenty-odd `*-config.repo.ts` modules read one row by its id and write a
flat `$set` back. The documents have nothing in common — the observability row
holds an OTLP endpoint, the describe row a model name and a spend cap, the
migration row a map of per-migration enable flags — so columns would mean
either a table per settings domain or a wide table of mutually exclusive
nullable fields that every new knob has to migrate.

One JSON document per id keeps the storage as boring as the access pattern,
and `json_set` keeps the partial update atomic rather than a read-modify-write:
a concurrent save to a different key survives, and the function creates the
intermediate objects a dotted Mongo path like
`migrations.refile-backups.enabled` needs.

### Migrations after the initial schema

A shipped migration id is frozen, so a table the initial schema got wrong is
corrected by a later migration rather than by an edit to `0001` — a database
that already recorded `0001-initial-schema` would never re-run it, and new
installs would silently diverge from existing ones.

| Migration                         | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0002-settings-and-audit-tables`  | Adds the five tables `0001` did not enumerate, and rebuilds `image_access_tokens`, which was modelled from its name: the row the code writes is keyed by the 64-character token hash and carries the bound `path` and a `purpose`, not a `user_id`.                                                                                                                                                                                                            |
| `0003-worker-config-partial-rows` | Relaxes `worker_config`'s `NOT NULL` scalars, because `WorkerConfigRepo.patch` upserts a partial — a stage's first write can create a row holding only a name and a `paused` flag. A defaulted `paused = 0` was the subtler half: it is indistinguishable from an operator resume, so it would tell `bootConfig` a stage is running and suppress the `pausedOnFirstBoot` parking `geocode` relies on. Also adds the discover worker's `sweep_dir_interval_ms`. |

### The live-asset predicate

"Live" means the same thing every browse, search and facet surface already
means by it: not soft-deleted, and holding at least one location whose file is
still there. It is spelled exactly this way, everywhere:

```sql
deleted_at IS NULL AND live_location_count > 0
```

The repetition is deliberate. SQLite only uses a partial index when the query's
own `WHERE` provably implies the index's, and the implication test is textual
enough that a paraphrase loses the index. Repo modules must use this spelling.

## Every query pattern in `src/api/src/db/`, and the index that serves it

Sources: `assets.repo.ts`, `assets.trash.ts`, `changes.repo.ts`, `media-kind.ts`,
`relocate-cache-reset.ts`, `migrations.ts`, `migrations.merge-duplicates.ts`,
`migrations.person-face-count.ts`, `backup-sessions.repo.ts`, plus the facet,
search, people and backup call sites those files' helpers serve.

### Reads on one asset

| Call site                            | Mongo filter                                      | SQLite                                | Index                                         |
| ------------------------------------ | ------------------------------------------------- | ------------------------------------- | --------------------------------------------- |
| `findDetailById`, `findCoreInfoById` | `{ _id: id }`                                     | `WHERE id = ?`                        | `assets` primary key                          |
| `findDetailsByIds`                   | `{ _id: { $in: ids } }`                           | `WHERE id IN (…)`                     | `assets` primary key                          |
| `findDetailByAddress`                | `fileinfo.$elemMatch{library_id, path, filename}` | one row of `asset_locations`          | `asset_locations_lib_path_name` (UNIQUE)      |
| detail DTO's `fileinfo` array        | the array itself                                  | `WHERE asset_id = ? ORDER BY ordinal` | `asset_locations` `UNIQUE(asset_id, ordinal)` |
| detail DTO's faces + person names    | `faces[]` + a `people` `$in`                      | join `faces` → `people`               | `faces_person`, `people` primary key          |

### Browse, search and the grid

| Call site                            | Mongo                                                          | SQLite                                                                 | Index                                                    |
| ------------------------------------ | -------------------------------------------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------- |
| `findListItems`                      | `{ deleted_at: null, … }`, limit 1000                          | live predicate + optional `rating`, `has_xmp`, `captured_at` residuals | `assets_live_captured`                                   |
| default search sort                  | `{ 'fileinfo.library_id': 1, 'exif.captured_at': -1, _id: 1 }` | ordered scan of `assets`, semi-join for the library                    | `assets_live_captured` + `asset_locations_primary_entry` |
| `name` sort                          | `fileinfo_filename_1`                                          | `ORDER BY filename`                                                    | `asset_locations_filename`                               |
| library scope                        | `'fileinfo.library_id'` dotted                                 | `EXISTS (… l.library_id = ?)`                                          | `asset_locations_library_live`                           |
| free-text `q` regex on filename/path | `$or` of two regexes over `fileinfo`                           | `LIKE` over `asset_locations`                                          | `asset_locations_filename` (prefix only)                 |
| `scope=people`                       | `'faces.0': { $exists: true }`                                 | `EXISTS (SELECT 1 FROM faces …)`                                       | `faces_person` / `faces_unassigned`                      |
| person filter                        | `faces.$elemMatch{person_id ∈ …}`                              | `EXISTS (… f.person_id IN (…))`                                        | `faces_person`                                           |
| excluded people                      | `faces: { $not: { $elemMatch … } }`                            | `NOT EXISTS (…)`                                                       | `faces_person`                                           |

The grid query is written as a semi-join, not an inner join, and the shape is
load-bearing. An inner join lets the planner lead with `asset_locations`, scan a
whole library and sort every row to find 200; `EXISTS` keeps `assets` as the
outer loop so the ordered partial index terminates at the limit. Measured on 60k
generated assets: 51.3 ms as an inner join, 0.36 ms as a semi-join.

### Facets and counts

| Call site                                                              | Mongo                                                     | SQLite                                                  | Index                                                                      |
| ---------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------- |
| facet total, Meili live count, generated-search preview, buckets total | `countDocuments(live)`                                    | `COUNT(*) WHERE live`                                   | `assets_live`                                                              |
| camera facet                                                           | `$group { exif.camera_make, exif.camera_model }`          | `GROUP BY camera_make, camera_model`                    | `assets_facet_camera`                                                      |
| lens facet                                                             | `$group '$exif.lens'`                                     | `GROUP BY lens`                                         | `assets_facet_lens`                                                        |
| places facet                                                           | `$group { place.rollups.locality, place.rollups.region }` | `GROUP BY place_locality, place_region`                 | `assets_facet_place_label`                                                 |
| country drill-down                                                     | the `place_rollups` index's purpose                       | `GROUP BY place_country_code`                           | `assets_facet_place`                                                       |
| timeline buckets                                                       | `$group { exif.captured_year, exif.captured_month }`      | `GROUP BY captured_year, captured_month`                | `assets_live_captured_ym`                                                  |
| screenshot tri-state                                                   | `$cond` bucket over `is_screenshot`                       | `GROUP BY is_screenshot`                                | `assets_facet_screenshot`                                                  |
| scene / activity facets                                                | `$group '$vision.scene_type'` / `'$vision.activity'`      | `GROUP BY vision_scene_type` / `vision_activity`        | `asset_detail_scene_type`, `asset_detail_activity` (new — unindexed today) |
| capture range, ISO range                                               | `$min` / `$max`                                           | `MIN` / `MAX`                                           | `assets_live_captured`, table scan for ISO                                 |
| extension facet                                                        | `$split` on `fileinfo.filename`                           | `GROUP BY` a suffix expression                          | `asset_locations_filename` scan                                            |
| people facet                                                           | `$setUnion` over `faces` then `$unwind`                   | `SELECT person_id, COUNT(DISTINCT asset_id) FROM faces` | `faces_person`                                                             |
| Meili vector coverage                                                  | `LIVE_ASSET_FILTER` + `semantic_vector_fingerprint`       | `WHERE live AND semantic_vector_fingerprint = ?`        | `assets_vector_fingerprint` (new — unindexed today)                        |

### Pipeline, workers and maintenance

| Call site                         | Mongo                                                     | SQLite                                                                        | Index                                                    |
| --------------------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------- |
| stage claim                       | `stages.<name>.version < target`, `dead != true`, backoff | `WHERE stage = ? AND version < ? AND dead = 0 AND …`                          | `stage_claim`                                            |
| stage dead count and list         | `stage_<name>_dead` partial index                         | `WHERE stage = ? AND dead = 1`                                                | `stage_dead`                                             |
| legacy enrichment claim           | `enrichment.<stage>.done_at: null` + lease                | `WHERE stage = ? AND done_at IS NULL`                                         | `enrichment_claim`                                       |
| `listEnrichmentDeadLetter`        | `enrichment.<stage>.dead_letter_at != null`, sorted       | `WHERE stage = ? AND dead_letter_at IS NOT NULL ORDER BY dead_letter_at DESC` | `enrichment_dead_letter` (new — a collection scan today) |
| damaged list and count            | `'damaged.since': { $type: 'string' }`                    | `WHERE damaged_since IS NOT NULL`                                             | `assets_damaged`                                         |
| missing-reaper sweep              | `'fileinfo.missing_since'` partial                        | `WHERE missing_since IS NOT NULL`                                             | `asset_locations_missing`                                |
| deduplicate candidates and badge  | `fileinfo.1` partial + `$expr`/`$filter`                  | `GROUP BY asset_id HAVING COUNT(*) >= 2` over live entries                    | `asset_locations_live_by_asset`                          |
| trash GC sweep                    | `deleted_at` partial                                      | `WHERE deleted_at < ?`                                                        | `assets_trashed`                                         |
| content dedup                     | `maple_id_gt_1` unique partial                            | `WHERE maple_id = ?`                                                          | `assets_maple_id` (UNIQUE partial)                       |
| dedup fallback                    | `sha1_head_1` sparse                                      | `WHERE sha1_head = ?`                                                         | `assets_sha1_head`                                       |
| hidden review list and badge      | `hidden_pending` partial                                  | `WHERE hidden = 1 AND hidden_ack = 0`                                         | `assets_hidden_pending`                                  |
| video/audio claims and migrations | `media_kind_av` partial                                   | `WHERE media_kind IN ('video','audio')`                                       | `assets_media_kind_av`                                   |
| map bbox clusters                 | `exif_gps_bbox` partial                                   | `WHERE gps_lat BETWEEN ? AND ? AND gps_lng BETWEEN ? AND ?`                   | `assets_gps_bbox`                                        |
| geo-backfill donor lookup         | `exif_captured_at_gps_lat` partial                        | `WHERE captured_at BETWEEN ? AND ? AND gps_lat IS NOT NULL`                   | `assets_gps_captured`                                    |
| refile-backups sweep              | `backup_layout_version` partial                           | `WHERE backup_layout_version IS NOT ?`                                        | `assets_backup_layout`                                   |
| `mergeDuplicateAssets`            | `$group '$maple_id'` having count > 1                     | `GROUP BY maple_id HAVING COUNT(*) > 1`                                       | `assets_maple_id`                                        |
| `backfillPersonFaceCount`         | `$unwind` + `$group '$faces.person_id'`                   | `GROUP BY person_id` over live assets                                         | `faces_person`                                           |
| `relocateCacheStageReset`         | `stages.thumb.*` / `stages.preview.*` reset               | `UPDATE stage_state … WHERE asset_id = ? AND stage IN ('thumb','preview')`    | `stage_state` primary key                                |

### Backup and File Provider

| Call site                 | Mongo                                                                               | SQLite                                            | Index                              |
| ------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------- | ---------------------------------- |
| backup-sidecar fallback   | `'phasset_links.device_id'` + `'phasset_links.phasset_local_id'`, dotted, unindexed | `WHERE device_id = ? AND phasset_local_id = ?`    | `asset_phasset_links_device_local` |
| backup-state delta        | `phasset_links.$elemMatch{device_id, first_seen ≥ …}`                               | `WHERE device_id = ? AND first_seen >= ?`         | `asset_phasset_links_device_seen`  |
| notify-deleted            | `phasset_links.$elemMatch{device_id, phasset_local_id ∈ …}`                         | `WHERE device_id = ? AND phasset_local_id IN (…)` | `asset_phasset_links_device_local` |
| cross-device timeline     | `phasset_cloud_id`                                                                  | `WHERE phasset_cloud_id = ?`                      | `asset_phasset_links_cloud`        |
| `listChangesSince`        | `{ cursor: { $gt: … } }` sorted                                                     | `WHERE cursor > ? ORDER BY cursor`                | `asset_changes` primary key        |
| `highestCursor`           | `sort({ cursor: -1 }).limit(1)`                                                     | `SELECT MAX(cursor)`                              | `asset_changes` primary key        |
| per-folder change routing | `{ folder_id, cursor }`                                                             | same                                              | `asset_changes_folder_cursor`      |
| `upsertProgress`          | `{ library_id, device_id }` upsert                                                  | `ON CONFLICT (library_id, device_id)`             | `backup_sessions` UNIQUE           |

### Full-text search

`$text` has two real query call sites, not the 45 the ticket estimates — that
count came from a grep whose hits are mostly prose in doc comments. The two are
`routes/search/query.ts` (the `placeQuery` filter) and
`routes/service-asset-search.ts` (which sorts by `{ $meta: 'textScore' }`).
Both become `assets_fts MATCH ?`, with `bm25(assets_fts)` in place of the text
score. The `porter unicode61` tokenizer gives the English stemming the Mongo
index got from `default_language: 'english'`.

### Index count

|                                 | Mongo                                                                          | SQLite                                                  |
| ------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------- |
| Per-stage indexes on `assets`   | 24 (12 stages × 2), plus stale ones for retired stages that were never dropped | 2, and they do not grow with the stage list             |
| Other named indexes on `assets` | 26                                                                             | 33 across `assets` and the six tables its arrays became |
| Registering a new stage         | two more index definitions, rebuilt on the next boot                           | an insert                                               |

The ticket's "28 of 54" counts production's live index list, which carries
indexes for stages that no longer exist; 24 of 50 is what the current source
declares.

## What changed behaviourally

Four differences a reviewer should know about, rather than discover.

**Same-entry matching is now structural.** MongoDB gives two different answers
for an array of subdocuments: `$elemMatch` requires one entry to satisfy every
condition, while dotted paths let different entries satisfy different
conditions. Getting that wrong is a live bug — `routes/backup-sidecar.ts` matches
the device and the local id as dotted paths, so an asset linked to
`(deviceA, id1)` and `(deviceB, id2)` answers a lookup for `(deviceA, id2)`.
Every sibling route uses `$elemMatch`. As rows, the mismatch cannot be written.

**`live_location_count` stays, but is derived.** What the ticket retires is the
hand-maintained version — a denormalised number updated at every liveness
mutation site, which could drift. Triggers on `asset_locations` derive it now, so
it cannot. It survives because "live" is the base predicate of every facet, and
written as an `EXISTS` sub-select it costs one B-tree probe per candidate row.
Measured on 600,000 generated assets, the same count is 7.3 ms against the
roll-up column and 285 ms via `EXISTS`. As a column it folds into the partial
index's `WHERE`; as a sub-select it cannot.

**TTL indexes become a sweep.** Six collections rely on Mongo's TTL monitor to
delete expired rows. SQLite has no TTL monitor, so expiry becomes an explicit
periodic `DELETE … WHERE expires_at < ?`, and each table carries an index on
`expires_at` to make that a range scan. `EXPIRY_INDEX_DDL` in `ddl/auth.ts` is
the list, and `upload_sessions` is a seventh table in the same position.
Nothing gets less safe: every one of these tables
already had to check expiry at read time, because Mongo's monitor only runs once
a minute and an expired document is fully readable until it fires.

The sweep itself is `sweepExpiredAuthRows` in
`db/sqlite/repos/auth.expiry.ts`, and it is garbage collection rather than
enforcement — each repository's own `expires_at > ?` predicate is what refuses
an expired row, whether or not the sweep has run. One table's failure therefore
does not abort the pass; the result reports what it removed and what it could
not.

**A write cannot return rows, so a claim is a compare-and-swap.** The pool's
`write` reports `{ changes, lastInsertRowid }` and nothing else, and `read` runs
on a read-only connection, so `UPDATE … RETURNING` is unavailable in both
directions. Every Mongo `findOneAndUpdate` therefore becomes an `UPDATE` whose
`WHERE` carries the whole filter, with `changes === 1` as the proof that this
caller won — identical safety, because the winner is established by the write
rather than by a preceding read. Where the caller does not already know the
row's key (claiming the oldest free row of a queue), it reads a short list of
candidate ids first and CASes them in order; a candidate another worker took in
between simply reports zero rows changed and the next one is tried.

**Stage rows are seeded, not lazy.** On Mongo a missing `stages.<name>` subdoc
is claimable, because BSON orders a missing field below any number so
`{ version: { $lt: target } }` matches it. The SQL equivalent of that is an
anti-join against `assets`, which cannot use an index on `stage_state` at all.
So every asset gets one row per registered stage at `version = 0` when it is
created, and the claim becomes a plain index range scan — 0.05 ms for 500
candidates over 12 million rows. Registering a thirteenth stage is then one
`INSERT … SELECT id, 'new-stage' FROM assets`.

**Foreign keys need a pragma.** SQLite parses foreign-key clauses always but
enforces them only when `PRAGMA foreign_keys = ON` is set, per connection, and
it is off by default. Without it every `ON DELETE CASCADE` in this schema is
decoration. `SCHEMA_PRAGMAS` in `ddl/index.ts` is the list a connection owner
applies.

## The migration runner

`src/api/src/db/sqlite/migrate.ts`, the engine-agnostic successor to
`db/migrations.ts`. The sentinel table `schema_migrations` records one row per
applied migration id, so a boot that has already migrated short-circuits.

Two things improve on the Mongo runner. SQLite runs DDL inside transactions, so
a migration and its sentinel row commit together — the Mongo version had to
accept a rare double-run when the process died in between, and that window does
not exist here. And `BEGIN IMMEDIATE` takes the write lock up front, so two
processes booting against the same file serialise; the loser re-reads the
sentinel inside its own transaction and skips, rather than racing into a
duplicate-key error it has to swallow.

`assertMigrationOrder` refuses a list whose ids are duplicated or out of lexical
order. The failure it catches is silent and permanent: a migration inserted
above an id that has already shipped never runs on a database that recorded the
later id, and two installs diverge with no error anywhere.

Connection management is not the runner's business. It talks to a `MigrationDb`
— three methods, sync or async — which a `bun:sqlite` handle satisfies directly
and the worker-backed pool can satisfy with its read / write / transaction
primitives. The only requirement is that every call lands on the same
connection with writes serialised, or `BEGIN` means nothing.

## Measured

Generated libraries at three sizes, on an M-series Mac, SQLite 3.54.0 under Bun
1.4.3. Sizes are `dbstat` byte counts per b-tree, not estimates. Timings are the
median of five runs after re-opening the database, so SQLite's own page cache
starts empty.

| assets    | db file  | `assets` | `asset_locations` | facet + grid index set | `stage_state` + its indexes | `asset_detail` |
| --------- | -------- | -------- | ----------------- | ---------------------- | --------------------------- | -------------- |
| 335,377   | 1,777 MB | 307 MB   | 29 MB             | **194 MB**             | 484 MB                      | 477 MB         |
| 600,000   | 3,173 MB | 549 MB   | 53 MB             | **347 MB**             | 866 MB                      | 852 MB         |
| 1,000,000 | 5,280 MB | 914 MB   | 88 MB             | **578 MB**             | 1,440 MB                    | 1,418 MB       |

The bolded column is the set every browse, search and facet query actually
touches: the 18 partial indexes on `assets` plus the six on `asset_locations`.
At production's row count it is 194 MB, against the 8.8 GB Mongo collection that
does not fit a 1.5 GB cache. `asset_detail` is the largest object in the
database and no hot query reads it, which is the whole reason it is a separate
table.

| query                               | 335,377   | 600,000   | 1,000,000 |
| ----------------------------------- | --------- | --------- | --------- |
| count live assets                   | 3.7 ms    | 7.3 ms    | 13.4 ms   |
| facet: camera make + model          | 15.5 ms   | 29.3 ms   | 47.1 ms   |
| facet: place country code           | 5.5 ms    | 12.7 ms   | 20.2 ms   |
| facet: place locality + region      | 12.9 ms   | 26.9 ms   | 45.2 ms   |
| facet: lens                         | 12.7 ms   | 22.3 ms   | 36.7 ms   |
| facet: timeline buckets             | 10.0 ms   | 20.3 ms   | 34.4 ms   |
| grid page, 200 rows                 | 0.4 ms    | 0.4 ms    | 0.5 ms    |
| duplicate candidates                | 21.1 ms   | 38.3 ms   | 63.2 ms   |
| backup sidecar lookup               | < 0.01 ms | < 0.01 ms | < 0.01 ms |
| stage claim, 500 candidates         | 0.03 ms   | 0.05 ms   | 0.05 ms   |
| full-text search, selective term    | 0.1 ms    | 0.3 ms    | 0.5 ms    |
| count live assets via `EXISTS`      | 151 ms    | 285 ms    | 460 ms    |
| full-text search, term in most rows | 226 ms    | 431 ms    | 896 ms    |

The two slow rows are there deliberately. The `EXISTS` count is the version
without the derived `live_location_count` column, and it is why that column
stays. The broad-term search is the worst case for any inverted index — a token
present in nearly every document, where the work is ranking the matches rather
than finding them; a selective term, which is what a person types, is three
orders of magnitude faster.

## Reproducing the measurements

```bash
cd src/api
bun scripts/sqlite-bench/run.ts                 # 335k, 600k and 1M assets
bun scripts/sqlite-bench/run.ts 335377 --keep   # one size, leave the file behind
```

The generator is seeded, so a re-run reproduces the same library. It touches
nothing outside its own temporary database. Sizes come from SQLite's `dbstat`
virtual table in aggregate mode, which reports bytes per b-tree, so every table
and index in the tables below is a real measurement rather than an estimate.

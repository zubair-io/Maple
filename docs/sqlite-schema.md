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
   `GENERATED ALWAYS AS (json_extract(...))` with an index. An indexed generated
   column materialises its value inside the index, so a facet over it reads a
   small B-tree rather than a pass over every JSON payload. (SQLite never prints
   `COVERING` for such an index, because a generated column counts as an
   expression; on a rowid table it nevertheless answers from the index, and the
   measurements below are what that is worth.)
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

| Table                                                                                                                                                                  | Replaces                                                                                                                      | Notes                                                                                  |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `assets`                                                                                                                                                               | `assets` document root                                                                                                        | Narrow. Scalars plus `exif` / `place` JSON and 14 generated columns.                   |
| `asset_locations`                                                                                                                                                      | `fileinfo[]`                                                                                                                  | `ordinal` keeps the array position; `ordinal = 0` is the canonical entry.              |
| `asset_detail`                                                                                                                                                         | `vision`, `description`, `ocr_*`, `transcript`, `video_description*`, `metadata_override`, `derivative_audit`, `geo_inferred` | 1:1. The bulk of the old document. A rowid table, deliberately — see the facets below. |
| `asset_search` + `assets_fts`                                                                                                                                          | `search_blob` + `search_blob_text`                                                                                            | FTS5 in external-content mode.                                                         |
| `asset_phasset_links`                                                                                                                                                  | `phasset_links[]`                                                                                                             | Indexed on `(device_id, phasset_local_id)` — the index that does not exist today.      |
| `faces`                                                                                                                                                                | `faces[]`                                                                                                                     | `face_index` keeps the array position, which is on the wire.                           |
| `stage_state`                                                                                                                                                          | `stages.<name>.*`                                                                                                             | `(asset_id, stage)`, `WITHOUT ROWID`, one row per asset per stage.                     |
| `enrichment_state`                                                                                                                                                     | `enrichment.<stage>.*`                                                                                                        | The older lease-based claim for `geocode` / `face` / `describe`.                       |
| `people`, `person_merge_dismissals`                                                                                                                                    | same                                                                                                                          | `cover_bbox` and the merge-suggestion head flattened to columns.                       |
| `folders`, `asset_changes`, `server_state`, `mirror_queue`, `geocode_cache`, `presets`                                                                                 | same                                                                                                                          |                                                                                        |
| `jobs`, `imports`, `import_files`, `indexer_queue`, `discover_frontier`, `worker_config`, `stage_handlers`, `backup_sessions`, `upload_sessions`, `apns_device_tokens` | same                                                                                                                          | Queues and configuration.                                                              |
| `app_settings`                                                                                                                                                         | same                                                                                                                          | One JSON document per settings domain, keyed by the id the `_id` carries today.        |
| `worker_status`, `managed_certificates`, `meilisearch_backfill_state`, `meilisearch_backfill_leases`                                                                   | same                                                                                                                          | Single-row singletons; the id is pinned by a CHECK.                                    |
| `indexer_checkpoints`, `generated_searches`, `video_geo_backfill_audit`, `meilisearch_backfill_failures`                                                               | same                                                                                                                          | Worker bookkeeping. See `ddl/settings.ts`.                                             |
| `users`, `credentials`, `invites`, `refresh_tokens`, `service_api_keys`, `challenges`, `native_auth_codes`, `lan_handoff_codes`, `image_access_tokens`                 | same                                                                                                                          |                                                                                        |
| `schema_migrations`                                                                                                                                                    | `migrations`                                                                                                                  | The runner's sentinel.                                                                 |

Every collection `src/api` opens has a table here; `src/api/src/db/sqlite/schema.indexes.test.ts`
fails if one stops being true. The nine in the three rows above were missing
from the first draft of this schema, `app_settings` most consequentially: it is
where every DB-backed setting lives, which is where Maple's operator-facing
configuration belongs by policy.

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

One more term rides along with it on every browse, search and facet query:
`buildFilter` emits `hidden: { $ne: true }` unless the caller asks for hidden
assets, which is `hidden = 0` here. It is a trailing **column** of the indexes
below rather than part of their `WHERE`, because `hidden=only` and `hidden=all`
are real wire values and a partial index on `hidden = 0` would lose both. As a
column it keeps the group keys leading, so the scan stays index-only and still
streams its groups.

### The implication test is textual, and that has bitten twice

A partial index whose predicate the query cannot be proved to imply is not
"slightly less useful" — it is unused, silently. `maple_id = ?` implies
`maple_id IS NOT NULL`; it does not imply `maple_id <> ''`, because the bound
value is unknown when the statement is planned. So the dedup probe against an
index declared `WHERE maple_id IS NOT NULL AND maple_id <> ''` planned as
`SCAN assets` — a full pass per discovered file.

MongoDB taught the same lesson on the same column: `maple_id_1` carried
`partialFilterExpression: { maple_id: { $type: 'string' } }`, which its planner
would not match against a literal-string equality either, and
`swap-maple-id-partial-filter-2026-05-23` rebuilt the index as `{ $gt: '' }` to
fix it. The SQLite translation copied the `$gt: ''` spelling and reintroduced
the bug in a planner that reasons differently. Here the two halves are split:
`IS NOT NULL` is the index predicate, and "non-empty" is a CHECK on the column,
so the guarantee survives without standing between the query and the index.

The rule that follows: a partial index's predicate holds only what an ordinary
query's `WHERE` will contain verbatim. Anything else belongs in a CHECK.

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

The grid query is written as a semi-join rather than an inner join. What the
shape guarantees is which table leads: `EXISTS` gives the planner nothing to
return from `asset_locations`, so `assets` stays the outer loop and the ordered
partial index terminates at the `LIMIT` instead of a whole library being scanned
and sorted to find 200 rows.

An earlier draft of this document claimed 51.3 ms against 0.36 ms for that pair.
The benchmark now runs both shapes at every size, against a generator that
spreads assets over four library roots — a single root made every
library-scoped query match 100% of the rows, which is the one case a library
scope never has to discriminate in. With a real scope and `ordinal = 0` in the
join condition, the planner leads with `assets` either way and the two are
within a millisecond of each other (both rows are in the table at the end of
this document). The semi-join is kept because it is the shape that cannot
regress into leading with `asset_locations` when statistics shift, not because
it measures faster today. The withdrawn number is called out rather than
quietly deleted: it was the kind of claim this document exists to make
checkable.

### Facets and counts

Every row below carries `live AND hidden = 0` as its `WHERE`; only the part
that differs is written out.

| Call site                                                              | Mongo                                                     | SQLite                                                                      | Index                                               |
| ---------------------------------------------------------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------- |
| facet total, Meili live count, generated-search preview, buckets total | `countDocuments(live)`                                    | `COUNT(*)`                                                                  | `assets_live`                                       |
| camera facet                                                           | `$group { exif.camera_make, exif.camera_model }`          | `GROUP BY camera_make, camera_model`                                        | `assets_facet_camera`                               |
| lens facet                                                             | `$group '$exif.lens'`                                     | `GROUP BY lens`                                                             | `assets_facet_lens`                                 |
| places facet                                                           | `$group { place.rollups.locality, place.rollups.region }` | `GROUP BY place_locality, place_region`                                     | `assets_facet_place_label`                          |
| country drill-down                                                     | the `place_rollups` index's purpose                       | `GROUP BY place_country_code`                                               | `assets_facet_place`                                |
| timeline buckets                                                       | `$group { exif.captured_year, exif.captured_month }`      | `GROUP BY captured_year, captured_month`                                    | `assets_live_captured_ym`                           |
| screenshot tri-state                                                   | `$cond` bucket over `is_screenshot`                       | `GROUP BY is_screenshot`                                                    | `assets_facet_screenshot`                           |
| scene / activity facets                                                | `$group '$vision.scene_type'`, `{ $nin: [null, ''] }`     | `JOIN assets` + `WHERE vision_scene_type IS NOT NULL AND <> '' GROUP BY` it | `asset_detail_scene_type`, `asset_detail_activity`  |
| capture range, ISO range                                               | `$min` / `$max`                                           | `MIN` / `MAX`                                                               | `assets_live_captured`, table scan for ISO          |
| extension facet                                                        | `$split` on `fileinfo.filename`                           | `GROUP BY` a suffix expression                                              | `asset_locations_filename` scan                     |
| people facet                                                           | `$setUnion` over `faces` then `$unwind`                   | `SELECT person_id, COUNT(DISTINCT asset_id) FROM faces`                     | `faces_person`                                      |
| Meili vector coverage                                                  | `LIVE_ASSET_FILTER` + `semantic_vector_fingerprint`       | `WHERE semantic_vector_fingerprint = ?`                                     | `assets_vector_fingerprint` (new — unindexed today) |

The vision facets are the one row where the exclusion is load-bearing rather
than decorative. A bare `GROUP BY vision_scene_type` implies nothing about
null, so it plans as a full scan of `asset_detail` — the biggest object in the
database and the one that table exists to keep out of a facet. The route
already excludes null and the empty string, which implies the index predicate;
the map now says so, and a test asserts both halves.

Two further things had to be true before that index did anything at all, and
neither is visible in the SQL. `asset_detail` is a rowid table, because SQLite
will not answer from an index over a generated column on a `WITHOUT ROWID`
table — measured at 30,000 rows, the same grouping is 69.8 ms against
`WITHOUT ROWID` and 1.0 ms against a rowid table. And the two facet columns are
`STORED` and declared first, so a lookup that does visit the row stops before
the `vision` payload instead of re-parsing it: 2.4x, at no cost in table size.

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
| content dedup                     | `maple_id_gt_1` unique partial                            | `WHERE maple_id = ?`                                                          | `assets_maple_id` (UNIQUE, partial on `IS NOT NULL`)     |
| dedup fallback                    | `sha1_head_1` sparse                                      | `WHERE sha1_head = ?`                                                         | `assets_sha1_head`                                       |
| hidden review list and badge      | `hidden_pending` partial                                  | `WHERE hidden = 1 AND hidden_ack = 0`                                         | `assets_hidden_pending`                                  |
| video/audio claims and migrations | `media_kind_av` partial                                   | `WHERE media_kind IN ('video','audio')`                                       | `assets_media_kind_av`                                   |
| map bbox clusters                 | `exif_gps_bbox` partial                                   | `WHERE gps_lat BETWEEN ? AND ? AND gps_lng BETWEEN ? AND ?`                   | `assets_gps_bbox`                                        |
| geo-backfill donor lookup         | `exif_captured_at_gps_lat` partial                        | `WHERE captured_at BETWEEN ? AND ? AND gps_lat IS NOT NULL`                   | `assets_gps_captured`                                    |
| refile-backups sweep              | `backup_layout_version` partial                           | `WHERE backup_layout_version IS NOT ?`                                        | `assets_backup_layout`                                   |
| `mergeDuplicateAssets`            | `$group '$maple_id'` having count > 1                     | `WHERE maple_id IS NOT NULL GROUP BY maple_id HAVING COUNT(*) > 1`            | `assets_maple_id`, covering                              |
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

Differences a reviewer should know about, rather than discover.

**The change feed holds ids, not references.** `asset_changes.asset_id` and
`folder_id` are plain TEXT with no foreign key. The rows are an append-only
ledger of things that have already happened, and the most important of them is
a deletion: `routes/assets/trash.ts` and `routes/folders.ts` both hard-delete
the asset and then record `{ kind: 'delete', asset_id }`. A foreign key breaks
that in both directions it could be written — `REFERENCES assets (id)` rejects
the insert, and because the change-row writer is best-effort the error is
swallowed and the event is lost, while `ON DELETE SET NULL` accepts it and then
blanks the one field a File Provider client needs to know what to drop.

**`is_screenshot` keeps three states.** `AssetDetailDto.is_screenshot` is typed
`boolean | null` and emitted as `doc.is_screenshot ?? null`, so "never
classified" is already on the wire and distinct from "classified, not a
screenshot" — the describe stage is what tells them apart. The column is
nullable to match (#3761). `hidden` and `hidden_ack` do not get the same
treatment, although their DTO keys are optional too: their filter semantics are
already two-valued, since `hidden: { $ne: true }` matches absent and false
identically and every client reads an absent key as false. Making them nullable
would put `(hidden = 0 OR hidden IS NULL)` into every browse, search and facet
query, and lose the index.

**Case-insensitive names collate on the column, not the index.** `people.name`,
`presets.name` and `users.email` are declared `COLLATE NOCASE`. Declared only on
the index — `CREATE INDEX … (name COLLATE NOCASE)` — the index is built NOCASE
while `WHERE name = ?` still compares BINARY, so the two never meet and the
lookup scans. For `people` that was more than slow: `findByNameCI` is what
decides whether renaming a person merges into an existing cluster, so a missed
match would send the caller into an insert that the unique index then rejects,
turning a merge into a `UNIQUE constraint failed`. NOCASE is ASCII-only where
Mongo's `{ locale: 'en', strength: 2 }` folds accents too; that narrower
equality is tracked on #3767, and it is a uniqueness question rather than a
lookup one.

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
Measured on 600,000 generated assets, the same count is 11.5 ms against the
roll-up column and 271 ms via `EXISTS`. As a column it folds into the partial
index's `WHERE`; as a sub-select it cannot.

**TTL indexes become a sweep.** Six collections rely on Mongo's TTL monitor to
delete expired rows. SQLite has no TTL monitor, so expiry becomes an explicit
periodic `DELETE … WHERE expires_at < ?`, and each table carries an index on
`expires_at` to make that a range scan. `EXPIRY_INDEX_DDL` in `ddl/auth.ts` is
the list, and `upload_sessions` is a seventh table in the same position.
Nothing gets less safe: every one of these tables
already had to check expiry at read time, because Mongo's monitor only runs once
a minute and an expired document is fully readable until it fires.

**Stage rows are seeded, not lazy.** On Mongo a missing `stages.<name>` subdoc
is claimable, because BSON orders a missing field below any number so
`{ version: { $lt: target } }` matches it. The SQL equivalent of that is an
anti-join against `assets`, which cannot use an index on `stage_state` at all.
So every asset gets one row per registered stage at `version = 0` when it is
created, and the claim becomes a plain index range scan — 0.06 ms for 500
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

The write lock is taken only for migrations that are actually pending. The
runner reads the applied set once, before the loop, so a boot with nothing to
do issues two reads and stops. Taking the lock per declared migration instead
would cost one exclusive lock and one fsync each, per process role, on every
boot — with three roles and a list that grows for the life of the product, all
of it serialised against the other roles doing the same. `BEGIN IMMEDIATE` also
sits inside the per-migration error guard, so a lock-contention failure
("database is locked", when the connection owner set no `busy_timeout` or the
other role's migration outran it) names the migration it was waiting for.

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
1.4.3. Sizes are `dbstat` byte counts per b-tree, not estimates.

| assets    | db file  | `assets` | `asset_locations` | facet + grid index set | `stage_state` + its indexes | `asset_detail` |
| --------- | -------- | -------- | ----------------- | ---------------------- | --------------------------- | -------------- |
| 335,377   | 1,563 MB | 306 MB   | 29 MB             | **209 MB**             | 484 MB                      | 262 MB         |
| 600,000   | 2,791 MB | 548 MB   | 53 MB             | **374 MB**             | 866 MB                      | 468 MB         |
| 1,000,000 | 4,646 MB | 913 MB   | 88 MB             | **621 MB**             | 1,443 MB                    | 780 MB         |

The bolded column is the set every browse, search and facet query actually
touches: the 18 partial indexes on `assets` plus the six on `asset_locations`
and the latter's uniqueness index. At production's row count it is 209 MB,
against the 8.8 GB Mongo collection that does not fit a 1.5 GB cache. It grew
from 194 MB when `hidden` was appended to eight of those indexes, which is the
cheapest 15 MB in the schema: without it every facet fetches each candidate row
to test a column it could have read from the index. `asset_detail` is the
largest single object after `stage_state` and no hot query reads it, which is
the whole reason it is a separate table.

Timings are milliseconds, **cold / warm**. Each query is measured on its own
freshly opened read-only connection, so its first run — the cold figure — meets
an empty SQLite page cache; the warm figure is the median of the five runs after
it. (The operating system's file cache is not emptied and cannot be from inside
the process, so cold is "a query this server has not run before", not "a query
against a cold disk".) An earlier version of this table timed every query on one
shared connection and called all of it cold, which only the first row was.

| query                                      | 335,377       | 600,000       | 1,000,000       |
| ------------------------------------------ | ------------- | ------------- | --------------- |
| count live assets                          | 7.7 / 6.7     | 13.1 / 11.5   | 22.8 / 23.1     |
| facet: camera make + model                 | 18.1 / 17.5   | 32.2 / 31.8   | 52.6 / 53.1     |
| facet: place country code                  | 9.1 / 7.0     | 15.3 / 14.9   | 27.2 / 27.1     |
| facet: place locality + region             | 17.5 / 15.1   | 30.7 / 31.7   | 52.1 / 55.3     |
| facet: lens                                | 16.2 / 15.7   | 27.1 / 26.5   | 50.6 / 49.3     |
| facet: timeline buckets                    | 13.6 / 12.2   | 24.1 / 23.7   | 42.6 / 41.8     |
| facet: vision scene type                   | 291.7 / 289.2 | 515.7 / 518.9 | 4328.2 / 1923.8 |
| facet: vision scene type, no liveness join | 10.0 / 9.0    | 17.6 / 15.1   | 45.5 / 35.6     |
| grid page, 200 rows, library-scoped        | 4.3 / 1.4     | 4.0 / 1.5     | 8.5 / 6.5       |
| grid page, same page as an inner join      | 2.8 / 0.9     | 2.6 / 0.5     | 2891.8 / 2165.2 |
| duplicate candidates                       | 22.4 / 22.3   | 37.5 / 39.3   | 79.2 / 94.1     |
| backup sidecar lookup                      | 0.01 / < 0.01 | 0.01 / < 0.01 | 0.02 / < 0.01   |
| stage claim, 500 candidates                | 0.08 / 0.03   | 0.08 / 0.04   | 0.12 / 0.06     |
| full-text search, selective term           | 0.6 / 0.2     | 1.1 / 0.2     | 3.1 / 1.0       |
| count live assets via `EXISTS`             | 160.5 / 163.2 | 270.2 / 271.0 | 494.7 / 670.6   |
| full-text search, term in most rows        | 256.4 / 330.5 | 522.5 / 527.2 | 1185.6 / 1246.7 |

Five rows are there to be slower than the ones above them, and each says
something the fast rows cannot.

**The inner-join grid page** is the shape this schema avoids, and it only
misbehaves at scale: at 335k and 600k the planner leads with `assets` for both
shapes and they are within a millisecond, and at 1M it flips to leading with
`asset_locations`, scanning a whole library and sorting it to return 200 rows —
2,165 ms against 6.5 ms. That flip is the argument for the semi-join. It is also
why the pair is measured rather than asserted: at two of the three sizes there
is nothing to see.

**The vision scene facet** is the schema's weakest surface and the numbers say
so. Grouping the facet index alone costs 35.6 ms at a million assets; adding the
join to `assets` that restricts it to live, non-hidden rows costs 1,923 ms, in
every join shape tried. The facet index works — that took a rowid table and two
`STORED` columns, both measured above — but liveness is not visible from
`asset_detail`, so each candidate is a probe into `assets`. Making it visible is
a denormalisation with a maintenance cost, so it belongs to whichever port has a
caller to justify it, not to the schema on spec.

**The `EXISTS` count** is the live-asset count without the derived
`live_location_count` column, and it is why that column stays: 271 ms against
11.5 ms at 600,000 assets.

**The broad-term search** is the worst case for any inverted index — a token in
nearly every document, where the work is ranking matches rather than finding
them. A selective term, which is what a person types, is three orders of
magnitude faster.

## Reproducing the measurements

```bash
cd src/api
bun scripts/sqlite-bench/run.ts                 # 335k, 600k and 1M assets
bun scripts/sqlite-bench/run.ts 335377 --keep   # one size, leave the file behind
```

The generator is seeded, so a re-run reproduces the same library, spread over
four library roots so a library-scoped query has something to discriminate.
It touches nothing outside its own output directory, which it creates — SQLite
creates a database file but not its parent, so a first run on a machine that
has never run the benchmark used to fail with `SQLITE_CANTOPEN` instead of
producing the numbers this document rests on. `SQLITE_BENCH_DIR` moves it;
the default is `/tmp/maple-sqlite-bench`, and `report.json` there carries every
timing, every table and index size, and the `EXPLAIN QUERY PLAN` output for
each measured query.

Sizes come from SQLite's `dbstat` virtual table in aggregate mode, which
reports bytes per b-tree, so every table and index above is a real measurement
rather than an estimate. `dbstat` needs a SQLite built with
`SQLITE_ENABLE_DBSTAT_VTAB`; Bun's is.

The plans behind the query-to-index map are asserted in
`src/api/src/db/sqlite/schema.indexes.test.ts`, which runs in `bun test` and
needs no fixtures. That is the part of this document that cannot go stale
quietly: three of its mappings were wrong when it was first written, and a
mapping the planner ignores looks exactly like one it honours until someone
runs `EXPLAIN QUERY PLAN`.

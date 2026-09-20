# SQLite schema for the Self Hosted backend

The schema behind the Self Hosted library database — one SQLite file, and the
only datastore the API has. This document is the design record and the
query-to-index map; the DDL itself lives in `src/api/src/db/sqlite/ddl/` and the
migration runner in `src/api/src/db/sqlite/migrate.ts`.

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
paths that are actually indexed. The synthesised `search_blob` lives in
`asset_search`, with an FTS5 index over it.

## Why narrowness is the whole point

A library of 335,377 assets carries roughly 8 KB of metadata each — p90 28 KB,
max 261 KB. Keeping all of that in one JSON payload per row would mean every
filtered query decoding 8 KB per row it examines, so a facet count would read
the whole library from disk every time. The win depends on the grid and filter
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

## Primary keys are TEXT, holding a 24-character hex id

Every client-visible primary key is `TEXT PRIMARY KEY` storing a 24-character
lowercase hex string, and every foreign key referencing one is TEXT too.

This is not a preference. Those strings are part of the public contract:
`src/api/src/db/assets.transform.ts` emits `id` and `folder_id` into the DTOs
the HTTP API returns, and Apple, Web and Windows clients hold them, compare them
and derive cache keys from them. Changing the format would break every client's
stored state, so it does not change.

`src/api/src/db/object-id.ts` mints them — 4 bytes of seconds, 5 of
per-process randomness and a 3-byte counter, rendered as hex — so ids stay
sortable by creation time. `INTEGER PRIMARY KEY` rowid aliases are used freely
for the internal tables whose ids never reach a client:
`asset_locations`, `faces`, `asset_phasset_links`, `import_files`,
`indexer_queue`, `discover_frontier` and `mirror_queue`.

## Tables

| Table                                                                                                                                                                  | Notes                                                                                                                                  |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `assets`                                                                                                                                                               | Narrow. Scalars plus `exif` / `place` JSON and 14 generated columns.                                                                   |
| `asset_locations`                                                                                                                                                      | One row per on-disk copy. `ordinal` keeps the order; `ordinal = 0` is the canonical entry.                                             |
| `asset_detail`                                                                                                                                                         | 1:1 side table for the bulky describe-stage payloads — vision, caption, OCR, transcript. A rowid table, deliberately — see the facets. |
| `asset_search` + `assets_fts`                                                                                                                                          | The synthesised search text and the FTS5 index over it, in external-content mode.                                                      |
| `asset_phasset_links`                                                                                                                                                  | Apple Photos links, indexed on `(device_id, phasset_local_id)`.                                                                        |
| `faces`                                                                                                                                                                | One row per detection. `face_index` keeps the position, which is on the wire.                                                          |
| `stage_state`                                                                                                                                                          | `(asset_id, stage)`, `WITHOUT ROWID`, one row per asset per stage.                                                                     |
| `enrichment_state`                                                                                                                                                     | The older lease-based claim for `geocode` / `face` / `describe`.                                                                       |
| `people`, `person_merge_dismissals`                                                                                                                                    | `cover_bbox` and the merge-suggestion head flattened to columns.                                                                       |
| `folders`, `asset_changes`, `server_state`, `mirror_queue`, `geocode_cache`, `presets`                                                                                 |                                                                                                                                        |
| `jobs`, `imports`, `import_files`, `indexer_queue`, `discover_frontier`, `worker_config`, `stage_handlers`, `backup_sessions`, `upload_sessions`, `apns_device_tokens` | Queues and configuration.                                                                                                              |
| `app_settings`                                                                                                                                                         | One JSON document per settings domain, keyed by name.                                                                                  |
| `worker_status`, `managed_certificates`, `meilisearch_backfill_state`, `meilisearch_backfill_leases`                                                                   | Single-row singletons; the id is pinned by a CHECK.                                                                                    |
| `indexer_checkpoints`, `generated_searches`, `video_geo_backfill_audit`, `meilisearch_backfill_failures`                                                               | Worker bookkeeping. See `ddl/settings.ts`.                                                                                             |
| `users`, `credentials`, `invites`, `refresh_tokens`, `service_api_keys`, `challenges`, `native_auth_codes`, `lan_handoff_codes`, `image_access_tokens`                 |                                                                                                                                        |
| `schema_migrations`                                                                                                                                                    | The migration runner's sentinel.                                                                                                       |

Every table the API opens is declared here, and
`src/api/src/db/sqlite/schema.indexes.test.ts` fails if that stops being true.

### `app_settings` is the one table that is a document, and why

Every other table follows the rule that a field a query filters on is a
column. `app_settings` is the exception, because nothing ever filters it:
all twenty-odd `*-config.repo.ts` modules read one row by its id and write a
flat update back. The rows have nothing in common — the observability row
holds an OTLP endpoint, the describe row a model name and a spend cap, the
migration row a map of per-migration enable flags — so columns would mean
either a table per settings domain or a wide table of mutually exclusive
nullable fields that every new knob has to migrate.

One JSON document per id keeps the storage as boring as the access pattern,
and `json_set` keeps the partial update atomic rather than a read-modify-write:
a concurrent save to a different key survives, and the function creates the
intermediate objects a nested path like `migrations.refile-backups.enabled`
needs.

### Migrations, and where the freeze starts

A shipped migration id is frozen: the runner skips a recorded id without
looking at what it now declares, so a database that already ran
`0001-initial-schema` would never re-run it and an edit there would reach new
installs only. That is what makes a correction a new migration rather than an
edit — **after** the schema has shipped.

Nothing in this epic shipped while it was being built. Three port slices each
found the initial schema wrong about a table they were porting, and each wrote
a `0002` or `0003` to correct it on top; integrating them collapsed all three
back into `0001`, because a fresh install creating a table and immediately
rebuilding it twice is ceremony, not safety.

The freeze starts at the cutover (#3752). `0002-stage-state-media-kind` (#3795)
was the first change on the far side of it and `0003-facet-state` (#3768) is
the second — and the second was written as a `0002` and renumbered when the
first merged ahead of it, which is the whole cost of the rule. Two branches
that both shipped a `0002` would leave two installs recording the same id for
different schemas, and nothing downstream could tell them apart.

`0003` adds the mirrored facet columns, the `asset_subjects` table, the indexes
over both and the triggers that maintain them, and it backfills before it
indexes so each index is built once over final values. On a 335,377-asset
library it takes about fifteen seconds, almost all of it the one pass over
`asset_detail` — a table whose rows average several kilobytes, so setting two
columns rewrites them. A fresh install therefore creates two `asset_detail`
indexes in `0001` and rebuilds them in `0003`, which is the cost of the freeze
and is worth it: both kinds of database end up with the same schema, which is
the only property that matters.

**The boot applies pending migrations before anything reads a column.**
`migrateAtBoot` returns before `openSqlitePool` is called and before any route,
worker or repository exists to issue a query, and on the already-cutover branch
it now runs the migration list rather than skipping straight past it. That
ordering is what lets a live database take `0003`: the marker says the data is
here, the migration list says what shape it is in, and the two are no longer
read as the same answer.

The corrections themselves survive, in the DDL rather than on top of it:

| Table                 | What the first draft got wrong                                                                                                                                                                                                                                                                                                                                         |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `image_access_tokens` | Modelled from its name alone. The row the code writes is keyed by the 64-character token hash and carries the bound `path` and a `purpose`, not a `user_id`.                                                                                                                                                                                                           |
| `worker_config`       | Every scalar was `NOT NULL`, but `WorkerConfigRepo.patch` upserts a partial — a stage's first write can create a row holding only a name and a `paused` flag. A defaulted `paused = 0` is the subtler half: indistinguishable from an operator resume, it would tell `bootConfig` a stage is running and suppress the `pausedOnFirstBoot` parking `geocode` relies on. |
| `asset_changes`       | Carried foreign keys to `assets` and `folders`. The most important row in this table is a `delete`, written _after_ the asset row is gone, so a key either rejects that insert or blanks the id the event exists to carry.                                                                                                                                             |
| `people`              | Uniqueness leaned on `COLLATE NOCASE`, which folds A–Z and nothing else, so `josé` and `JOSÉ` were two people and a rename silently failed to merge. A stored `name_key` holds the folded spelling instead.                                                                                                                                                            |

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

`findListItems` — the `GET /api/assets` working-set enumerator — used to mean
something narrower by "live", excluding only soft-deleted assets and so
returning ones whose every location had been tagged `missing_since`. It now uses
the predicate above, in line with every other live surface, which is also what
makes `assets_live_captured` usable for it; `assets.list.test.ts` pins the exact
row the two definitions disagree about.

One more term rides along with it on every browse, search and facet query:
hidden assets are excluded unless the caller asks for them, which is
`hidden = 0`. It is a trailing **column** of the indexes
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

The first draft of this index carried both halves in its predicate and so was
never used. Here the two are split: `IS NOT NULL` is the index predicate, and
"non-empty" is a CHECK on the column, so the guarantee survives without standing
between the query and the index.

The rule that follows: a partial index's predicate holds only what an ordinary
query's `WHERE` will contain verbatim. Anything else belongs in a CHECK.

### What the list page's sort costs

`findListItems` orders by `captured_at DESC, id`. That is what lets the ordered
partial index serve the page, and it makes the endpoint pageable and stable
across calls, which an unsorted limited read is not. It also means an asset with
no EXIF capture date — the
generated column is NULL, since `indexer/exif.ts` derives it from
`DateTimeOriginal ?? CreateDate` with no fallback — sorts behind every dated
row, so a page smaller than the live set never reaches one. #3779 carries the
fix: a `COALESCE(captured_at, indexed_at)` generated column and a partial index
over it, which is DDL rather than a repo change.

## Every query pattern in `src/api/src/db/`, and the index that serves it

Sources: `assets.repo.ts`, `assets.trash.ts`, `changes.repo.ts` and
`backup-sessions.repo.ts`, plus the repository modules under `db/repos/` and the
facet, search, people, worker and backup call sites they serve.

### Reads on one asset

| Call site                            | SQLite                                | Index                                         |
| ------------------------------------ | ------------------------------------- | --------------------------------------------- |
| `findDetailById`, `findCoreInfoById` | `WHERE id = ?`                        | `assets` primary key                          |
| `findDetailsByIds`                   | `WHERE id IN (…)`                     | `assets` primary key                          |
| `findDetailByAddress`                | one row of `asset_locations`          | `asset_locations_lib_path_name` (UNIQUE)      |
| detail DTO's `fileinfo` array        | `WHERE asset_id = ? ORDER BY ordinal` | `asset_locations` `UNIQUE(asset_id, ordinal)` |
| detail DTO's faces + person names    | join `faces` → `people`               | `faces_person`, `people` primary key          |

### Browse, search and the grid

| Call site                      | SQLite                                                                 | Index                                                    |
| ------------------------------ | ---------------------------------------------------------------------- | -------------------------------------------------------- |
| `findListItems`                | live predicate + optional `rating`, `has_xmp`, `captured_at` residuals | `assets_live_captured`                                   |
| default search sort            | ordered scan of `assets`, semi-join for the library                    | `assets_live_captured` + `asset_locations_primary_entry` |
| `name` sort                    | `ORDER BY filename`                                                    | `asset_locations_filename`                               |
| library scope                  | `EXISTS (… l.library_id = ?)`                                          | `asset_locations_library_live`                           |
| free-text `q` on filename/path | `LIKE` over `asset_locations`                                          | `asset_locations_filename` (prefix only)                 |
| timeline subtree scope         | `l.path = ?` or `substr(l.path, 1, length(?)) = ?`                     | `UNIQUE(asset_id, ordinal)`, `path` a residual           |
| `scope=people`                 | `EXISTS (SELECT 1 FROM faces …)`                                       | `faces_person` / `faces_unassigned`                      |
| person filter                  | `EXISTS (… f.person_id IN (…))`                                        | `faces_person`                                           |
| excluded people                | `NOT EXISTS (…)`                                                       | `faces_person`                                           |

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

The subtree scope reads `substr` rather than a prefix `LIKE`, because SQLite's
`LIKE` is case-insensitive for ASCII whatever the column's collation while `=`
is not — so the two arms of the predicate disagreed with each other, and the
descendant arm disagreed with the regex it replaces. `substr` compares under the
column's own collation, and it costs nothing: the plans are identical and, over
335,377 generated assets, a 200-row page scoped to a subtree measures 55.1 ms
against 59.4 ms.

### Facets and counts

Every index in this section carries `hidden` as its last column, and that is
load-bearing rather than tidy. Hidden assets are excluded unless the caller opts
in, so `buildFilter` puts `hidden: { $ne: true }` on literally every query.
Without the column the index serves the group key and then fetches each
candidate row to test it, which reads the whole `assets` table — measured during
#3750 at 28.9 ms against 1.1 ms for the count, and 84.6 ms against 2.5 ms for
the camera facet, over 60,000 assets. It goes last because it is not a group
key: appending it leaves the leading columns in the order each `GROUP BY` wants.
Putting it in the partial index's `WHERE` instead would be smaller and wrong,
because `hidden=only` and `hidden=all` are real wire values that would then lose
the index entirely.

Every row below carries `live AND hidden = 0` as its `WHERE`; only the part
that differs is written out.

| Call site                                                              | SQLite                                                                      | Index                                               |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------- |
| facet total, Meili live count, generated-search preview, buckets total | `COUNT(*)`                                                                  | `assets_live`                                       |
| camera facet                                                           | `GROUP BY camera_make, camera_model`                                        | `assets_facet_camera`                               |
| lens facet                                                             | `GROUP BY lens`                                                             | `assets_facet_lens`                                 |
| places facet                                                           | `GROUP BY place_locality, place_region`                                     | `assets_facet_place_label`                          |
| country drill-down                                                     | `GROUP BY place_country_code`                                               | `assets_facet_place`                                |
| timeline buckets                                                       | `GROUP BY captured_year, captured_month`                                    | `assets_live_captured_ym`                           |
| screenshot tri-state                                                   | `GROUP BY is_screenshot`                                                    | `assets_facet_screenshot`                           |
| scene / activity facets                                                | `JOIN assets` + `WHERE vision_scene_type IS NOT NULL AND <> '' GROUP BY` it | `asset_detail_scene_type`, `asset_detail_activity`  |
| capture range, ISO range                                               | `MIN` / `MAX`                                                               | `assets_live_captured`, table scan for ISO          |
| extension facet                                                        | `GROUP BY` a suffix expression                                              | `asset_locations_filename` scan                     |
| people facet                                                           | `SELECT person_id, COUNT(DISTINCT asset_id) FROM faces`                     | `faces_person`                                      |
| Meili vector coverage                                                  | `WHERE semantic_vector_fingerprint = ?`                                     | `assets_vector_fingerprint` (new — unindexed today) |

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

### The mirrored facet state (#3768, #3783)

Six facets group a table that is not `assets`, and for each of them the schema
above got the group key right and stopped one step short. `asset_detail` holds
scene type and activity, `asset_locations` holds the filename an extension
comes from, `faces` holds the people, and `vision.subjects` held nothing
indexable at all. Every one of them answered its own index cheaply and then had
to ask `assets` one question per candidate row — is this asset live, and is it
hidden — and that probe was the entire cost. Grouping the scene-type index
alone measures 10 ms at 335,377 assets; the same grouping with the liveness
join measured 264 ms, and making the probe index-only (see `assets_live_id`
below) took it to 81 ms and no further. The probe itself is the floor, because
the answer is not in the grouped table.

It is now. Each of those four tables carries two mirrored columns:

| column         | mirrors                                          |
| -------------- | ------------------------------------------------ |
| `asset_live`   | `deleted_at IS NULL AND live_location_count > 0` |
| `asset_hidden` | `assets.hidden`                                  |

`asset_live` goes in each facet index's `WHERE`, because no caller can ask for
dead assets. `asset_hidden` is a _column_ of the index, for the same reason
`hidden` is a column on the `assets` facet indexes: `hidden=only` and
`hidden=all` are real wire values, and a partial index over `asset_hidden = 0`
would lose the index for both.

**Nothing but a trigger writes them**, which is the difference between this and
the denormalised `people.face_count` the schema deleted. One trigger on
`assets` pushes a change out to the four satellites, guarded by a `WHEN` that
fires only when liveness or visibility actually flips — without it every
discovered file would fan out into four keyed updates, because
`live_location_count` is itself rewritten by a trigger on every location insert.
One trigger per satellite seeds a new row from its asset. Both halves are
needed: an asset can be hidden long after its faces were detected, and a face
can be detected long after its asset was hidden. `FACET_STATE_RECOMPUTE_SQL`
rebuilds all of it in one pass for the importer's triggerless bulk load, and
`facet-state.test.ts` asserts that the pass lands on exactly what the triggers
would have written.

`asset_subjects` is the same idea applied to an array SQLite cannot index. It
is derived from `asset_detail.vision` by trigger rather than written by the
describe stage, so the table cannot disagree with the payload it comes from,
and `subjects=` filters read the same table the facet groups — which they could
not while one parsed JSON and the other did not. One row per (asset, subject):
the shipped statement counted `json_each` rows, so an asset listing the same
subject twice counted twice in its own bucket while the filter returned it
once.

**A row count is no longer a row count on those statements.** `bun:sqlite`
reports every row a statement wrote, trigger writes included — `hardDelete` has
said so since the cutover — and an update that changes `deleted_at`, `hidden`
or `live_location_count` now writes to four more tables. Anything reading
`changes` off such a statement has to say what it means: `matchedOne` in
`repos/db-handle.ts` for the by-id updates, and a deliberate counting statement
in `repos/assets.folder-hidden.ts`, which needs a real count for an
operator-facing log line and takes it before the flip, under the same
predicate, on a column no trigger watches.

**What it costs.** At 335,377 assets the database grows from 1,646 MB to
1,815 MB — about 10%, and more than half of it is subjects:

| object                            | before  | after   |
| --------------------------------- | ------- | ------- |
| `asset_subjects` + its index      | —       | 79.0 MB |
| `faces_facet_person`              | —       | 16.2 MB |
| `asset_locations_facet_extension` | —       | 14.1 MB |
| `asset_detail_scene_type`         | 4.0 MB  | 10.8 MB |
| `asset_detail_activity`           | 3.6 MB  | 9.4 MB  |
| `assets_facet_iso`                | —       | 4.2 MB  |
| `assets_live_id`                  | 12.3 MB | 12.7 MB |

The two `asset_detail` indexes grew because they gained `asset_hidden` and
`asset_id`; the mirrored columns themselves cost nothing there, since they fit
in pages the multi-kilobyte rows already occupied. `asset_locations` and
`faces` each grew under a megabyte for their two columns.

### Pipeline, workers and maintenance

| Call site                         | SQLite                                                                        | Index                                                |
| --------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------- |
| stage claim                       | `WHERE stage = ? AND version < ? AND dead = 0 AND …`                          | `stage_claim`                                        |
| stage claim, video/audio only     | the same, plus `stage_state.media_kind IN ('video','audio')`                  | `stage_claim_media`                                  |
| stage dead count and list         | `WHERE stage = ? AND dead = 1`                                                | `stage_dead`                                         |
| legacy enrichment claim           | `WHERE stage = ? AND done_at IS NULL`                                         | `enrichment_claim`                                   |
| `listEnrichmentDeadLetter`        | `WHERE stage = ? AND dead_letter_at IS NOT NULL ORDER BY dead_letter_at DESC` | `enrichment_dead_letter`                             |
| damaged list and count            | `WHERE damaged_since IS NOT NULL`                                             | `assets_damaged`                                     |
| missing-reaper sweep              | `WHERE missing_since IS NOT NULL`                                             | `asset_locations_missing`                            |
| deduplicate candidates and badge  | `GROUP BY asset_id HAVING COUNT(*) >= 2` over live entries                    | `asset_locations_live_by_asset`                      |
| trash GC sweep                    | `WHERE deleted_at < ?`                                                        | `assets_trashed`                                     |
| content dedup                     | `WHERE maple_id = ?`                                                          | `assets_maple_id` (UNIQUE, partial on `IS NOT NULL`) |
| dedup fallback                    | `WHERE sha1_head = ?`                                                         | `assets_sha1_head`                                   |
| hidden review list and badge      | `WHERE hidden = 1 AND hidden_ack = 0`                                         | `assets_hidden_pending`                              |
| video/audio claims and migrations | `WHERE media_kind IN ('video','audio')`                                       | `assets_media_kind_av`                               |
| map bbox clusters                 | `WHERE gps_lat BETWEEN ? AND ? AND gps_lng BETWEEN ? AND ?`                   | `assets_gps_bbox`                                    |
| geo-backfill donor lookup         | `WHERE captured_at BETWEEN ? AND ? AND gps_lat IS NOT NULL`                   | `assets_gps_captured`                                |
| refile-backups sweep              | `WHERE backup_layout_version IS NOT ?`                                        | `assets_backup_layout`                               |
| `mergeDuplicateAssets`            | `WHERE maple_id IS NOT NULL GROUP BY maple_id HAVING COUNT(*) > 1`            | `assets_maple_id`, covering                          |
| `backfillPersonFaceCount`         | `GROUP BY person_id` over live assets                                         | `faces_person`                                       |
| `relocateCacheStageReset`         | `UPDATE stage_state … WHERE asset_id = ? AND stage IN ('thumb','preview')`    | `stage_state` primary key                            |

### Backup and File Provider

| Call site                 | SQLite                                            | Index                              |
| ------------------------- | ------------------------------------------------- | ---------------------------------- |
| backup-sidecar fallback   | `WHERE device_id = ? AND phasset_local_id = ?`    | `asset_phasset_links_device_local` |
| backup-state delta        | `WHERE device_id = ? AND first_seen >= ?`         | `asset_phasset_links_device_seen`  |
| notify-deleted            | `WHERE device_id = ? AND phasset_local_id IN (…)` | `asset_phasset_links_device_local` |
| cross-device timeline     | `WHERE phasset_cloud_id = ?`                      | `asset_phasset_links_cloud`        |
| `listChangesSince`        | `WHERE cursor > ? ORDER BY cursor`                | `asset_changes` primary key        |
| `highestCursor`           | `SELECT MAX(cursor)`                              | `asset_changes` primary key        |
| per-folder change routing | same                                              | `asset_changes_folder_cursor`      |
| `upsertProgress`          | `ON CONFLICT (library_id, device_id)`             | `backup_sessions` UNIQUE           |

### Full-text search

Two call sites run a free-text query: `routes/search/query.ts` (the `placeQuery`
filter) and `routes/service-asset-search.ts` (which ranks by relevance). Both
are `assets_fts MATCH ?`, ranked by `bm25(assets_fts)`. The `porter unicode61`
tokenizer supplies English stemming, and folds accents and case.

A user's string cannot be forwarded to `MATCH` as it stands. `MATCH` takes a
query expression in which `*`, `:`, `^`, `-`, parentheses and the bare words
`AND` / `OR` / `NOT` / `NEAR` are operators, and a syntax error there raises
rather than matching nothing — so `C++ (2019)` would 500 the search route.
`db/repos/search.fts.ts` re-emits every term as a quoted FTS5 string, splitting
bare terms on punctuation so `harbour.dng` stays two OR'd terms rather than
becoming a two-word phrase.

Ranking sorts the other way from a conventional relevance score: `bm25()`
returns a negative number whose magnitude grows with relevance, so the best
match is the smallest value and the sort is ascending. `FTS_RANK_SQL` and
`FTS_RANK_ORDER` are the pair that keeps that straight.

The translation answers one of three things, and the third is the one that is
easy to get wrong. A blank query carries no text filter. A query with terms
becomes an expression. A query whose terms all cancel — `???`, `-boat`, `((((`
— is a filter that matches nothing, which is not the same as having no filter:
collapsing the two would answer the whole live library for a query the user
typed to narrow it. There is no length
cap here; the term cap bounds the cost, and refusing a long query outright was
itself a way of answering the whole library for a pasted caption. An unmatchable
query becomes the constant `0`, which SQLite folds before planning — the
statements cost 0.01 ms against 6.51 ms for the same count over 335,377 assets —
and the statements that would otherwise name an index drop the hint, because an
`INDEXED BY` over a folded `WHERE` fails to prepare at all.

### Index count

Two indexes carry every stage, and they do not grow when the stage list does —
registering a stage is an insert, not a pair of new index definitions. Another
33 named indexes span `assets` and the six tables its arrays became.

## Design decisions worth knowing

Things a reviewer should know about, rather than discover.

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
turning a merge into a `UNIQUE constraint failed`. NOCASE is ASCII-only, so it
does not fold accents; that narrower equality is tracked on #3767, and it is a
uniqueness question rather than a lookup one.

**Same-entry matching is structural.** A lookup that has to match two things
about the _same_ location or link — this device and this local id, not this
device on one link and this id on another — is one row's two columns here, so
the mismatch cannot be written. The backup-sidecar fallback in particular used
to answer a lookup for `(deviceA, id2)` on an asset linked to `(deviceA, id1)`
and `(deviceB, id2)`.

**One file path, one location row.** `asset_locations_lib_path_name` is UNIQUE
over `(library_id, path, filename)`, which is what makes a relocate safe: a file
whose content changed has its old row released rather than tagged, because a
tagged row would occupy the key.

**`live_location_count` is derived, not maintained.** Triggers on
`asset_locations` keep it, rather than every liveness mutation site remembering
to, so it cannot drift. It exists at all because "live" is the base predicate of
every facet: written as an `EXISTS` sub-select it costs one B-tree probe per
candidate row, and on 600,000 generated assets the same count is 11.5 ms against
the roll-up column and 271 ms via `EXISTS`. As a column it folds into the
partial index's `WHERE`; as a sub-select it cannot.

**Expiry is a sweep, not a background collector.** SQLite deletes nothing on its
own, so rows with an `expires_at` are removed by an explicit periodic
`DELETE … WHERE expires_at < ?`, and each such table carries an index on
`expires_at` to make that a range scan. `EXPIRY_INDEX_DDL` in `ddl/auth.ts` is
the list, and `upload_sessions` is a seventh table in the same position.

The sweep itself is `sweepExpiredAuthRows` in
`db/repos/auth.expiry.ts`, and it is garbage collection rather than
enforcement — each repository's own `expires_at > ?` predicate is what refuses
an expired row, whether or not the sweep has run. One table's failure therefore
does not abort the pass; the result reports what it removed and what it could
not.

**A write cannot return rows, so a claim is a compare-and-swap.** The pool's
`write` reports `{ changes, lastInsertRowid }` and nothing else, and `read` runs
on a read-only connection, so `UPDATE … RETURNING` is unavailable in both
directions. So a claim is an `UPDATE` whose `WHERE` carries the whole filter,
with `changes === 1` as the proof that this caller won — the winner is
established by the write itself rather than by a preceding read, which is what
makes it safe. Where the caller does not already know the
row's key (claiming the oldest free row of a queue), it reads a short list of
candidate ids first and CASes them in order; a candidate another worker took in
between simply reports zero rows changed and the next one is tried.

**Stage rows are seeded, not lazy.** Leaving a stage's row absent until its
first attempt would make the claim an anti-join against `assets`, which cannot
use an index on `stage_state` at all. So every asset gets one row per registered
stage at `version = 0` when it is created, and the claim becomes a plain index
range scan — 0.06 ms for 500
candidates over 12 million rows. Registering a thirteenth stage is then one
`INSERT … SELECT id, 'new-stage' FROM assets`.

**A stage that applies to a subset needs that subset in the index.** The scan
above is a range over `version < target`, so its length is the stage's backlog.
For `transcribe` and `video-describe` — 15,790 eligible assets out of 335,419 —
the backlog is the whole photo library, and saying so with an `EXISTS` over
`assets` narrows nothing, because a residual can only be applied to a candidate
the scan has already produced. Once each stage had caught up on the media it
could claim, every poll tick walked 323,000 rows and found nothing: 418 ms of
CPU per second per stage, which starved the reader pool until requests timed
out (#3795). `stage_state.media_kind` is that narrowing, denormalised from
`assets` and carried by `stage_claim_media`, a partial index over the two
minority kinds. Two triggers own the column — nothing else writes it — because
`media_kind` is itself derived from an asset's locations and changes when they
do. The residual keeps its `EXISTS` as the authoritative test and merely leads
with the narrowing term, so the assets a stage claims are provably unchanged.

**A count is the claim without the `LIMIT`, and that changes what it can
afford.** The Workers page's `pending` and `ready` ask the claim's question of
the whole backlog rather than of five candidates, so two things the claim pays
for once per tick were being paid for 324,000 times per stage per refresh: a
keyed probe into `assets` for the liveness and damaged gates, which has to read
the asset row because `assets_live_id` is partial on liveness alone, and a probe
into the `stage_state` primary key for each `dependsOn` edge, which on a
`WITHOUT ROWID` table means descending a B-tree that carries every row body.
Twelve stages, sequentially, came to 5.6 s per refresh (#3804).

`stage_state.asset_claimable` removes the first: the same three columns
mirrored onto the stage row by triggers, carried as a trailing member of
`stage_claim` so the count never leaves the index. Unlike `media_kind` it is
authoritative for the count rather than a narrowing, because almost every asset
is live and a narrowing would leave the probe running anyway — the claim itself
is untouched and still asks `assets`, so a drifted mirror could only misreport a
number on a settings page. `stage_dep` removes the second: `(stage, asset_id,
version)`, covering, 167 MB whose hot region is the one dependency stage's 13 MB
rather than the table's 324 MB. It is deliberately not partial on the four
stages that are dependencies today, because `stage` is free-form data precisely
so registering a stage is an insert, and an index listing the dependency graph
would silently stop covering the first edge added outside the list.

The pass falls to 0.96 s — pending 2,092 ms to 87, ready 3,518 ms to 876 — which
matters more than the ratio: the refresher rests
for three times the last pass's duration with a 5 s floor, so anything slower
than 1.67 s holds a reader continuously AND refreshes the page more slowly than
the page asked for.

One consequence worth knowing before writing a repository function.
`bun:sqlite` counts a trigger's writes in the row count of the statement that
fired it, so any `UPDATE assets` that changes `deleted_at`, `damaged_since` or
`live_location_count` now reports roughly a dozen rows per asset. A statement
keyed on one id can clamp (`oneIfChanged`); a multi-row one has to count what it
means some other way, which `clearDamagedAssets` and `repairLiveLocationCounts`
each do differently and say why.

**Foreign keys need a pragma.** SQLite parses foreign-key clauses always but
enforces them only when `PRAGMA foreign_keys = ON` is set, per connection, and
it is off by default. Without it every `ON DELETE CASCADE` in this schema is
decoration. `SCHEMA_PRAGMAS` in `ddl/index.ts` is the list a connection owner
applies.

**Case-insensitive uniqueness is a stored key, not a collation** (#3749).
`people_name_unique` is what makes naming two clusters the same thing a merge,
and SQLite's `NOCASE` is not equal to the job: it folds ASCII `A`–`Z` and
nothing else, so under it "josé" and "JOSÉ" are two names, the lookup misses,
the index permits the second row and the merge silently does not happen. `bun:sqlite`
cannot register a collation of our own, so `people` carries a `name_key` column
folded by `caseFoldKey` (`db/sqlite/case-fold.ts`, NFKC then `toLowerCase`) and
the unique index is built over that. Every comparison in `repos/people.sql.ts`
is against `name_key`, and the repo's own "is this the same name" check folds
through the same function, so the code and the constraint cannot disagree.
`presets_name_unique` and `users_email_unique` still carry the original
spelling and are tracked by #3781 — each lands with the slice that ports its
repo, since a NOT NULL key column with no writer proves nothing.

**A person's face count is derived, not stored** (#3749). `PersonDoc.face_count`
is a denormalised number adjusted by hand at every membership change — assign,
unassign, hide, merge — and then rewritten wholesale once per clustering pass by
a block whose own comment says it is there to heal the drift those incremental
sites cause. As rows it is one `COUNT(*)` over `faces_person` joined to `assets`
for liveness, so the
column does not exist and neither do the adjust and heal helpers. The count is
computed where it is read, in `repos/people.face-count.ts`, and the drift cannot
be reintroduced by a write path forgetting to call something.

Deriving it is not free, and two things keep the cost where it belongs. The
liveness probe runs `INDEXED BY assets_live_id`, a partial index keyed on `id`
that answers "is this asset live" without reading the asset row — 591 ms
against 175 ms for the whole-library count on a generated 335,377-asset library,
and the planner only picks it unaided once `ANALYZE` has run. And a caller that
knows which people it needs names them, so the Hidden and Excluded listings seek
a dozen people rather than walking every assigned face in the library; the grid,
which asks for all of them, takes the grouped scan.

**The clustering worker gets a path, not a connection** (#3749). The clustering
pass runs on its own thread and writes — `recomputeCentroids` persists refreshed
centroids before the seeds are read back. Letting it open its own writable
handle would mean a second SQLite writer, which is exactly what the pool exists
to prevent. Instead the worker opens the file `readonly` for its own queries, so the
embeddings stay on its thread, and sends every write to the host, which runs it
on the pool's single writer. `db/sqlite/worker-db.ts` carries the argument,
including why the write-then-reload path in the clustering pass still observes
its own write.

**A stage claim holds a lease, and the lease is in the row.** Keeping the set
of assets a runner is working on in process memory would protect that process
from itself and nothing from a second one — another API process or the same
process across a restart. The claim writes `next_attempt_at` a fixed interval
ahead instead, so the exclusion travels with the data. That column already means "the earliest
this row may be claimed again", so the claim and the retry backoff share one
gate rather than needing a second column, and the writeback overwrites it on
every terminal path: cleared on success, replaced by the real backoff on
failure. A lease therefore only outlives its attempt when the process died
holding it, which is exactly when the row should become claimable again.

A lease that expires only helps if everything else respects it, so three things
go together. Every write to the claimed row carries `AND next_attempt_at = ?`
against the lease it was granted, which means a handler that finishes after its
lease was taken over updates nothing instead of releasing a claim someone else
now holds. `renewStageLease` pushes the lease out for a handler that
legitimately runs longer than one — `transcribe` runs the length of a video —
and returns null when the claim is already gone, which is how that handler
learns to drop its work rather than write it. And the version-bump reset leaves
`next_attempt_at` alone: a restart across a
bump has the outgoing process still draining handlers while the incoming one
boots and re-queues, and clearing the column there would drop the leases those
handlers hold. Nothing is stranded by leaving it, because every path that parks
a row already nulls the column itself.

The claim is a compare-and-swap, because a write cannot return rows: the pool's
`write` reports `{ changes, lastInsertRowid }` and `read` runs on a read-only
connection, so `UPDATE … RETURNING` is unavailable in both directions. It reads
a short candidate list and then swaps each candidate, with `changes === 1` as
the proof that this caller won, and the whole batch goes in one
`BEGIN IMMEDIATE`. Each swap re-asks every gate the scan asked, not only the
three that carry exclusivity, because the scan takes no lock — an asset can be
trashed, tagged damaged or have an upstream stage invalidated in the window
between being scanned and being taken. All of them are keyed probes against one
already-identified row, and the measurement below does not separate their cost
from run-to-run noise.

The extra round trip that costs is measured rather than assumed:
`bun scripts/sqlite-bench/stage-claim-roundtrip.ts` puts it at ~0.02 ms — the
empty-read figure — against a whole claim of 0.28–0.64 ms over five runs on
60,000 assets, of which 0.05–0.06 ms is the scan and 0.13–0.19 ms the swap. A
few percent of a claim, well inside the spread between runs, and a claim is
spent once per tick against a handler that then runs for seconds — so a
returning-capable primitive is not worth adding to the pool for it.

## The migration runner

`src/api/src/db/sqlite/migrate.ts`, run at boot by
`db/sqlite/boot-schema.ts` before the pool opens. The sentinel table
`schema_migrations` records one row per applied migration id, so a boot that has
already migrated short-circuits, and a migration that fails stops the boot
rather than serving a half-changed schema.

Two properties make it safe. SQLite runs DDL inside transactions, so a
migration and its sentinel row commit together and a process that dies partway
through leaves nothing behind. And `BEGIN IMMEDIATE` takes the write lock up
front, so two processes booting against the same file serialise; the loser
re-reads the sentinel inside its own transaction and skips.

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
and the latter's uniqueness index. At production's row count it is 209 MB — a
working set that fits in page cache, which is the whole point of the narrow
row. It grew
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

**The vision scene facet** was the schema's weakest surface and the numbers say
why. Grouping the facet index alone costs 35.6 ms at a million assets; adding
the join to `assets` that restricts it to live, non-hidden rows costs 1,923 ms,
in every join shape tried. The facet index works — that took a rowid table and
two `STORED` columns, both measured above — but liveness was not visible from
`asset_detail`, so each candidate was a probe into `assets`. Both rows are kept
as they were measured, because they are the argument for the denormalisation
that #3768 then made: liveness _is_ visible from `asset_detail` now, and the
unfiltered facet reads the first row's index without the second row's join.

**The `EXISTS` count** is the live-asset count without the derived
`live_location_count` column, and it is why that column stays: 271 ms against
11.5 ms at 600,000 assets.

**The broad-term search** is the worst case for any inverted index — a token in
nearly every document, where the work is ranking matches rather than finding
them. A selective term, which is what a person types, is three orders of
magnitude faster.

### The same facets through the ported route (#3750, #3768)

The table above times the queries the schema was designed around. These time the
statements `db/repos/search.sql.ts` actually generates for an unfiltered
`GET /api/search/facets`, which differ in one way that turned out to matter: they
all carry the always-on `hidden = 0` filter. At 335,377 assets:

The script that produced these numbers, `scripts/sqlite-bench/search-compare.ts`,
went with the rest of the MongoDB comparison harness (#3785). A SQLite-only
replacement is tracked by #3807; until it lands these figures cannot be
re-measured, and a plan regression on any of the six rewritten facets would go
unnoticed. `scripts/sqlite-bench/run.ts` still covers the five older facets.

The first seven are the ones every index in this schema was built for, and they
are where its case lies. The last six each have to leave the `assets` row to
answer, and none of them has an index that covers what it needs; the schema
already flagged the scene, activity and ISO cases as unindexed, and the ported
measurement puts numbers on them. Closing that gap is #3768.

## Reproducing the measurements

```bash
cd src/api
bun scripts/sqlite-bench/run.ts                 # 335k, 600k and 1M assets
bun scripts/sqlite-bench/run.ts 335377 --keep   # one size, leave the file behind

# Stage-claim round trips and the media-narrowed claim
bun scripts/sqlite-bench/stage-claim-roundtrip.ts
bun scripts/sqlite-bench/stage-claim-media.ts
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

The mirrored facet state has a second test beside it,
`src/api/src/db/sqlite/facet-state.test.ts`, because a plan cannot catch what
goes wrong with a denormalisation. It drives the writes that change liveness
and visibility — hide, un-hide, trash, restore, lose a file, find it again,
re-describe, merge a duplicate — and asserts the facets afterwards, where a
stale mirror shows up as a bucket disagreeing with the total beside it. The
last case runs `FACET_STATE_RECOMPUTE_SQL` over a library the triggers built
and asserts that nothing moves, which is what the importer's triggerless bulk
load depends on.

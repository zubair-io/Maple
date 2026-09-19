# Moving an existing library from MongoDB to SQLite

The one-shot importer that lets an operator upgrade a running Self Hosted
install without losing their library. The schema it writes into is
`docs/sqlite-schema.md`; the code is `src/api/src/db/sqlite/import/` with the
operator entry point at `src/api/scripts/mongo-to-sqlite.ts`.

## How it works, in five sentences

The importer walks a fixed plan of source collections in foreign-key order,
turns each MongoDB document into the rows it becomes, and commits a batch of
rows together with the checkpoint that describes them in one transaction — so a
run that dies part-way can continue from exactly where it stopped. Identifiers
survive unchanged: every client-visible key is the same 24-character hex string
MongoDB produced, because those strings are already on the wire. The derived
structures are switched off for the load and rebuilt once at the end — the three
triggers that maintain `assets.live_location_count`, the three that maintain the
FTS5 index, the two that maintain `stage_state.media_kind` — which is the
difference between eight statements and several million.
References MongoDB could not enforce are resolved in one pass afterwards, with
every nulled reference and dropped row counted and reported. Verification is
then a separate step with its own verdict: row counts per table against the
source, row-presence and field-level checks on a sample, `PRAGMA
foreign_key_check`, and a reject list that fails the run on a single entry.

## At boot, which is how it actually runs in production (#3752)

The command below stays, and is what a rehearsal against a copy uses. On a real
deploy nobody types it: the API process runs the same importer itself, before it
serves, and the operator's only job is the two environment variables below.

The sequence on the deploy that lands the cutover:

1. The deploy timer picks up `main` and restarts the service.
2. The API opens the database named by `MAPLE_SQLITE_PATH`. If that database
   records a completed cutover, it goes straight to step 5.
3. Otherwise it connects to MongoDB and runs this importer to completion,
   logging progress per batch. **It is not serving during this.**
4. It records the completion in `server_state`, so the next restart skips it.
5. It opens the pool, spawns the worker child, and starts serving.

For the production library — roughly 335,000 assets — step 3 is single-digit
minutes. That is the downtime; it happens once, and it is in the log rather than
inferred.

Three properties are load-bearing, and `db/sqlite/boot-migration.test.ts` drives
each of them:

- **It fails closed.** A migration that does not finish and verify stops the
  boot rather than serving. Every other phase of this server's boot logs its
  failure and continues, because a degraded subsystem beats no server; this one
  is the exception, because a half-imported library is indistinguishable over the
  API from a deleted one and the File Provider clients would act on the
  difference.
- **It resumes.** The checkpoints are per batch, so a boot killed halfway
  continues where it stopped. An unfinished database is therefore kept, not
  discarded — discarding it would make every interrupted cutover start from zero.
- **Only one process migrates.** The worker tier is a separate child with its own
  connection. It never migrates, and the API does not spawn it until the
  migration has returned, so nothing claims a stage against a half-built library.

Once the cutover is recorded, MongoDB is never contacted again.

### What an operator adds to the deploy script, by hand

Production does not use `src/api/docker-compose.yml`; it runs a hand-written
script on the box with every port and variable spelled out. Two variables go in:

| Variable            | Value                                                                                                                                                                                                                                                                                          |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MAPLE_SQLITE_PATH` | Absolute path to the library database, e.g. `/var/lib/maple/maple.db`. On a persistent volume, and backed up the way the Mongo dump was — this file now _is_ the library. Defaults to `./data/maple.sqlite`, which is relative to the working directory and not what a service should rely on. |
| `MAPLE_MONGO_URI`   | Already set. Keep it: the migrating boot reads it, and reverting the cutover needs it. `MAPLE_MONGO_DB` likewise.                                                                                                                                                                              |

Nothing else changes, and nothing is removed — deleting MongoDB from the
configuration is #3785, after production is confirmed healthy.

## Running it by hand

For a rehearsal against a copy, or to build the database ahead of the deploy so
the boot finds it already migrated. The importer only ever reads MongoDB, so a
copy of the library is a safe rehearsal and the original stays available as the
rollback. Stop the server first.

```bash
cd src/api
bun scripts/mongo-to-sqlite.ts --out /var/lib/maple/maple.db
```

| Flag                | Default                                              | What it does                                       |
| ------------------- | ---------------------------------------------------- | -------------------------------------------------- |
| `--out <path>`      | required                                             | Destination SQLite file.                           |
| `--mongo-uri <uri>` | `$MAPLE_MONGO_URI`, else `mongodb://localhost:27017` | Source connection string.                          |
| `--mongo-db <name>` | `$MAPLE_MONGO_DB`, else `maple`                      | Source database.                                   |
| `--batch <n>`       | 500                                                  | Documents per transaction.                         |
| `--changes-window`  | 100000                                               | Newest `asset_changes` rows to carry, or `all`.    |
| `--verify-sample`   | 200                                                  | Documents sampled per collection for field checks. |
| `--no-verify`       | off                                                  | Import without the verification pass.              |
| `--restart`         | off                                                  | Delete the destination and start over.             |

Re-running the same command after an interruption resumes. The process exits
non-zero when verification fails.

## Resumption

Batches are keyed on `_id` ascending, and the checkpoint row — collection, last
committed `_id`, document count, reject count — is written inside the same
transaction as the rows of that batch. There is therefore no window in which
rows exist without the checkpoint that describes them, or a checkpoint ahead of
its rows, which is what makes "continue from `_id > last`" exactly correct
rather than approximately correct. A skip/limit pager would have neither
property: an offset shifts under any concurrent write, and a crash between the
page and the bookkeeping loses or repeats a page.

Three importer-owned tables live in the destination alongside the library:
`import_checkpoint`, `import_rejects` and `import_meta`. They describe one
migration event rather than the library, so an operator can drop all three after
a successful cutover. They are deliberately not part of the schema migration.

## Verification

"The import finished" and "the import is correct" are different claims. The
second one has four pieces of evidence, and each covers something the others
cannot see.

**Row counts, per table, against the source.** Wherever one document fans out
the source side is an aggregation rather than a document count —
`asset_locations` is the number of usable `fileinfo` entries, `stage_state` the
union of the canonical stage names with whatever the document carries. Catches a
batch lost to a rolled-back transaction, and a mapper that skips a row shape.

**Row presence, per sampled document.** Every row the mapper produces is looked
up with null-safe equality on all of its columns, so it has to be present
verbatim. Catches a misaligned column list and a value SQLite coerced on the way
in.

**Field-level probes on sampled assets**, stated independently of the mapper —
identifiers, the nested arrays and their positions, the JSON payloads and the
generated columns read out of them. A check that uses the mapper as its own
definition of correctness cannot catch a mapper that is wrong. The sample is
chosen over a projection of `_id` alone and only the chosen documents are
fetched, so the cost scales with the sample rather than with the library: the
previous version walked an unprojected cursor and pulled roughly 2 GB of BSON
across the wire to use two hundred documents of it.

**`PRAGMA foreign_key_check`, the reject list, and the derived-state marker.**
The first confirms the file is safe to open with foreign keys on. The second
lists documents that could not be written at all; a single entry fails the
verdict. The third refuses a file whose load-time triggers were never put back.

## Measured

A generated library at production's row count — 335,377 assets averaging
6.3 KB, 2,107 MB of MongoDB collection — on an M-series Mac, SQLite 3.54.0
under Bun 1.4.3, with MongoDB on the same machine.

| Phase                                  | Wall clock |
| -------------------------------------- | ---------- |
| Everything before the assets           | 0.9 s      |
| Assets and their seven fan-out tables  | 42.3 s     |
| Import total                           | 46.3 s     |
| Import plus the full verification pass | 58.9 s     |

That is the operator's downtime, and it produced a 2,136 MB database holding
335,377 asset rows, 335,377 locations, 151,117 faces, 335,377 detail and search
rows, 4,024,524 stage rows and 1,006,131 enrichment rows, with every table count
matching the source, 16,466 field checks passing and `foreign_key_check` clean.

Resumption was measured the same way: the same import was `kill -9`ed 25 seconds
in, having committed 187,500 of the 335,377 assets, and re-run with the same
command. The second run skipped the nine already-complete collections, finished
the assets in 42.6 seconds, passed the same verification, and produced an
`assets` table byte-identical to the uninterrupted import — same SHA-256 over
every row, and no difference in any of the 35 table counts.

## Decisions worth knowing

### The change log is windowed, not imported whole

`asset_changes` is around 176 million rows on production, roughly 525 per asset,
and every one exists to answer "what changed since cursor N?" for a File
Provider client that has been away. The rows are not the library — they are a
replication journal over it, and the library is the authority any client can
fall back to by re-enumerating.

So the importer carries the newest 100,000 rows by default and lets anything
older re-enumerate. A client that synced recently keeps its incremental path; one
that has been offline long enough to fall off the window pays one enumeration,
once. Importing all 176 million would dominate both the operator's downtime and
the resulting file to buy back a fast path for clients already on the slow one.
`--changes-window all` is there for an operator who would rather pay the time,
and #3741's retention sweep shrinks the collection on the Mongo side
independently.

Two things make the window safe rather than merely cheap. The cursor counter in
`server_state` is imported verbatim, so newly allocated cursors continue above
the imported rows and none is ever reused. And the floor is persisted on first
use, so a resumed run imports the same set even if the source moved on.

One residual gap is named rather than buried: `GET /api/changes` has no
too-old-cursor check today — it answers `cursor > since` with whatever it finds —
so a client below the floor would be told it is up to date instead of being sent
to re-enumerate. The SSE path does return 409. Closing that on the polling route
belongs with the repository port that rewrites it.

### A field the types do not mention is the one a mapper drops

`description_meta` is written by the describe stage and read back by
`assets.transform.ts` through a `Record<string, unknown>`, so it reaches
clients — but it is not declared on the `AssetDoc` interface, because it was
added after that interface froze. The first version of this importer was
written from the interface and discarded the field for the whole library,
silently, until review caught it.

That is why the field-level probes in `verify-assets.ts` read the source
document rather than going through the mapper, and why `DETAIL_SOURCE_FIELDS`
is a list the mapper and the expected-count query both read. The other two
undeclared reads in the API (`toCoreInfo`'s `maple_id` and `original_path`,
and the browse listing's `deleted_at`) are all declared fields accessed
loosely, so they were already covered.

### Identifiers are preserved, never remapped

`db/assets.transform.ts` emits `doc._id.toHexString()` into the DTOs the HTTP API
returns, and Apple, Web and Windows clients hold those strings, compare them and
derive cache keys from them. Preserving them is both the smaller change and the
only one that keeps the migration's stated non-goal — that clients do not change
— true.

### Foreign keys are off during the load, and repaired afterwards

Not for speed. The source has a genuine reference cycle: a face points at a
person, and a person's cover points at an asset, so no ordering of collections
satisfies every constraint at insert time. Enforcement moves to one pass at the
end, which applies the schema's own stated intent — a nullable reference
declares `ON DELETE SET NULL`, so a dangling one becomes null; a NOT NULL
reference has no such escape, so the row goes, which is the same verdict every
MongoDB read path already reaches by walking past it. Both are counted and
printed, because silently dropping rows during a migration is exactly what an
operator should hear about.

### Stage rows are seeded densely

Every asset gets one row per canonical stage, even one that has never been
through any stage, because the schema's claim query depends on those rows
existing (see `docs/sqlite-schema.md` § "Stage rows are seeded, not lazy").
Retired stage names a document still carries — `hash`, `face` — are carried over
too rather than dropped: the `stage` column is free-form, no claim query asks for
those names, and dropping them would discard the only record that the work was
done. The run reports which non-canonical names it saw.

### Every source collection is either imported or declared

Before it writes a row, a run asks MongoDB what collections the database
actually holds and subtracts what the plan imports and what
`plan/coverage.ts` declares. Anything left stops the run. That check exists
because the list below used to be five entries short of the truth —
`managed_certificates`, `indexer_checkpoints` and the three
`meilisearch_backfill_*` tables had no plan, no entry and no mention — and
nothing about running the importer could have revealed it. A list of "things
deliberately left behind" is only worth reading if it is exhaustive, and the
only way to keep it exhaustive is to have the source contradict it. It has
since earned that twice over, on the first boot against a real library.

The check also has a test that does not need a live database, and it is the
inventory in `plan/coverage.test.ts` that carries the weight: a list of every
collection the owner's production library holds, read off it rather than
written from the plan. The earlier cases all handed the check names taken from
the plan, so a collection the plan had never heard of was one the test had
never heard of either, and the two agreed with each other all the way to that
boot. Entries are added to the inventory by reading a real database; copying
them from the plan turns the test back into the tautology it exists to break.

| Collection                    | Why not                                                                                                     |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `migrations`                  | Mongo migration ids describing Mongo-shaped backfills. The SQLite runner keeps its own `schema_migrations`. |
| `worker_status`               | One cached status snapshot, rewritten by the workers within a poll cycle of the first boot.                 |
| `generated_searches`          | AI-generated search suggestions, regenerated by their worker.                                               |
| `video_geo_backfill_audit`    | The audit log of a one-shot migration that has already run.                                                 |
| `image_access_tokens`         | Capability tokens that live for minutes. See below.                                                         |
| `meilisearch_backfill_leases` | A single-runner claim held by a process the cutover ends. See below.                                        |
| `indexer_config`              | The retired indexer's pool sizes, superseded by `worker_config`. See below.                                 |
| `indexer_dead_letter`         | The same pipeline's redrive queue, keyed by a stage vocabulary that is gone. See below.                     |
| `probe`                       | A connectivity ping, not data.                                                                              |

### Three that used to be on that list, and why they are not (#3797)

`managed_certificates`, `indexer_checkpoints` and `meilisearch_backfill_state`
were skipped on the same reasoning three times: something downstream
re-derives them. Re-deriving turned out to be the expensive part of the
cutover rather than the cheap one, and in the first case it did not happen at
all.

The certificate was the one that hurt. The server was expected to re-issue on
first boot; instead issuance failed, the settings page showed a generic
Cloudflare error, nothing was logged, and the LAN hostname stayed down for
hours. The document holds the ACME account key, so carrying it means the new
database starts from a registered account and an already-issued certificate
rather than from a fresh registration against Let's Encrypt's
duplicate-certificate rate limit.

That document is also the only one in the import that carries secrets — the
ACME account key and the certificate's own private key. They are bound as
statement parameters and never interpolated into a string: no mapper in
`plan/settings.ts` throws with a value in its message, the reject list records
an id and a reason, and the verifier's field checks report `present` or
`missing` rather than contents. The test fixtures use obviously synthetic keys,
because a fixture is the one place a real key would live forever and in plain
sight.

The backfill cursor is the expensive one. "A fresh backfill restarts from the
top" is true, and on an install with semantic search and a `bge-m3` embedder
it means re-embedding every asset in the library — 335,419 of them on the one
this was written against. The indexer's resume points are the same shape of
cost: the sweep that "re-derives them" walked 216,000 assets immediately after
the cutover.

`meilisearch_backfill_failures` came across with the cursor rather than on its
own merits. The backfill advances past a row it fails on — a durable cursor
that never revisits a dead-lettered row is what stops one bad asset stalling
the migration — and the only thing that ever comes back for those assets is
the end-of-run redrive pass reading that list. Carry the cursor and drop the
list and those assets are absent from search permanently, with nothing left
pointing at them.

`meilisearch_backfill_leases` is the one of the four that stayed behind, and
it is worth separating from the others because the reason is different in
kind. The row is an owner id and an expiry: a claim by a running backfill
worker, deleted when it lets go. That process does not survive the cutover, so
the claim is false the moment it is copied, and the only thing the copy can do
is make the new install's first runner wait out somebody else's expiry. There
is no work state in it to lose — the cursor and the counters are in
`meilisearch_backfill_state` and the redrive list is in
`meilisearch_backfill_failures`, both of which are imported.

The rule those three replace is "skip anything that can be argued to be
re-derivable". The rule that replaces it is **copy it unless copying is
actively harmful**, which is a much higher bar and the only reason the lease
above still clears it.

The `indexer_*` pair below are what the first boot against a real production library added
(#3786), and they are the reason to trust the check rather than the list. Both
belong to the bounded-channel indexer that ran `discover → hash → exif → thumb
→ ai → mongo` in memory, and the code that wrote them was deleted when that
pipeline was retired — so they appear in no `db.collection(…)` call site, in no
schema, and in nothing the plan could have been derived from, while sitting in
every database that ever ran it.

`indexer_config` is one document per install holding that pipeline's per-stage
pool sizes. It looks exactly like operator tuning being discarded, which is why
it is worth being precise: per-stage concurrency lives in `worker_config` now,
one row per worker, written from Settings → Workers and read by the worker tier
on every poll tick — and `worker_config` is imported in full. The production
library shows the two apart rather than in agreement. Its `indexer_config` was
last written on 2026-05-09 and says every stage is 32; its twenty
`worker_config` rows, the oldest created the next day and the newest in
September, say thumb 100, preview 50, exif 10, describe 3, face paused. The
live tuning is the one being carried across, and carrying the old document too
could only mean writing over it.

`indexer_dead_letter` held one document per (file, stage) that failed three
times. The concept survives and the rows do not: a per-asset stage that
exhausts its retries marks `dead` on that asset's own stage row, and the
slow-tier enrichment stages record theirs in `enrichment_state`, both of which
travel with the asset. Nothing could re-drive a row keyed by an absolute path
and a stage name — `hash`, `mongo` — that no longer exists. Production's copy
is empty, which is a consequence of the retirement rather than the reason this
is safe.

`image_access_tokens` are capability tokens for thumbnail and preview URLs with
a lifetime measured in minutes. The cutover's own downtime is longer than they
live, and a client that finds one rejected mints another on its next request.

### `app_settings` comes from #3751's migration, not from this one

The collection has no accessor in `db/client.ts` — a dozen `*-config.repo.ts`
modules open it by name — so it was missed when the initial schema was
enumerated from that file. Without it a cutover silently drops the operator's
Cloudflare R2 credentials, map and pano configuration, network and observability
settings and every worker tunable. The importer writes one row per settings key
with the source document stored whole, so a key this server version does not
recognise survives too.

The table itself belongs to the remaining-collections port (#3751, PR #3763),
which creates it in migration `0002-settings-and-audit-tables` alongside four
others. This branch first invented a second migration for the same table under
a different filename, which git would have merged without a conflict into two
`CREATE TABLE app_settings` statements and a fresh install that fails on the
second. The importer now depends on #3763's table, and carries that migration
under #3763's own id and path so the collision is one git reports rather than
one it hides.

Worth recording, because the original reasoning was wrong: that second
migration argued it could not edit `0001` "because `0001` has shipped". Nothing
in this epic is merged and no database carries it. Editing the initial schema
directly was available all along and is what #3747, #3749 and #3750 each did.
Migrations become the only option at cutover, not before.

### The repair record accumulates, because re-running is normal

Verification subtracts the rows the repair pass dropped from the count the
source reports, which is what stops a legitimately-repaired library looking
like a shortfall. That subtraction has to survive the second run of the same
command — the one this document tells an operator to make after an
interruption. The first pass drops K rows and records K; the second finds
nothing dangling, because the first already dealt with it, and an empty answer
overwriting the first made verification expect K rows that were never supposed
to exist. So the tally adds rather than replaces, and each foreign key's count,
statement and record commit in one transaction, for the same reason a batch
commits with its checkpoint.

### Only a verdict on the document becomes a reject

A batch that SQLite refuses is replayed one document at a time so a single
stale document cannot end a six-hour import. That is the right answer for a
constraint, a datatype or a size refusal and the wrong one for everything else:
a full disk, a lock that never cleared or a missing table fails all five hundred
documents identically, and recording five hundred rejects would bury the real
error AND move the checkpoint past documents nothing ever examined — a resumed
run reads `_id > last_id` and never sees them again. So the failure is
classified: `SQLITE_CONSTRAINT*`, `SQLITE_MISMATCH` and `SQLITE_TOOBIG` become
rejects, and anything else stops the run with its own error and leaves the
checkpoint where it was.

### An unfinished file says so

The load drops eight triggers and puts them back at the end. In between, the
file opens cleanly, answers every query, and maintains none of the FTS5 index,
`assets.live_location_count` or `stage_state.media_kind` — so a server pointed
at it finds nothing new in search, shows every newly-located asset as dead, and
never transcribes an imported video. A run killed in the middle
used to leave exactly that file with nothing to mark it. The state is now
written to `import_meta`, verification fails on it, and the report says the file
is not one to point a server at. Re-running the same command restores it.

### `--restart` will not delete a file it did not produce

After a successful cutover the live database is at the same path the operator
would type. A database this importer produced carries `import_checkpoint`,
`import_rejects` and `import_meta` beside the library; a file carrying none of
them is either live or not ours, and `--restart` refuses it instead of deleting
it. The `-wal` and `-shm` siblings go with a file that is deleted.

## Tests

```bash
cd src/api
bun test src/db/sqlite/import/
```

They run against a throwaway `mongod` on port 27077 and skip-pass when one is
not running, like every other Mongo-backed suite here. Never point them at
:27017 — that is a developer's real library.

The seeded library is small and deliberately awkward: multi-location assets, a
location under a library root that is not registered, one whose `library_id`
was never an ObjectId, faces both assigned and unassigned, duplicate Apple
Photos links, a large vision payload with an `ObjectId` nested inside it, a
legacy row with no `fileinfo` and no `indexed_at`, an import that still holds
its per-file entries inline, retired stage names, a soft-deleted row and a
damaged one. A library of identical well-formed documents would satisfy the row
counts and prove nothing.

| File                         | What it holds to                                                              |
| ---------------------------- | ----------------------------------------------------------------------------- |
| `import.test.ts`             | A full import: per-table counts, the fan-out, identifiers, the whole verdict. |
| `import-fields.test.ts`      | The asset row: JSON payloads, generated columns, and the nested arrays.       |
| `import-collections.test.ts` | The detail payloads and every collection that is not an asset.                |
| `import-resume.test.ts`      | A real interruption mid-assets, then convergence on an uninterrupted import.  |
| `import-changes.test.ts`     | The change-log window, and that its floor holds across a resume.              |
| `import-guards.test.ts`      | The refusals: an undeclared collection, `--restart` on a foreign file.        |
| `writer.test.ts`             | Which failures may become a reject and which must stop the run. No database.  |
| `values.test.ts`             | The BSON types that convert, and the ones that are refused. No database.      |
| `cli.test.ts`                | Argument parsing and report rendering, which need no database.                |

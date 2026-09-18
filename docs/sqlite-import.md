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
FTS5 index — which is the difference between six statements and several million.
References MongoDB could not enforce are resolved in one pass afterwards, with
every nulled reference and dropped row counted and reported. Verification is
then a separate step with its own verdict: row counts per table against the
source, row-presence and field-level checks on a sample, `PRAGMA
foreign_key_check`, and a reject list that fails the run on a single entry.

## Running it

Stop the server first. The importer only ever reads MongoDB, so a copy of the
library is a safe rehearsal and the original stays available as the rollback.

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
`asset_locations` is the sum of the `fileinfo` array lengths, `stage_state` the
union of the canonical stage names with whatever the document carries. Catches a
batch lost to a rolled-back transaction, and a mapper that skips a row shape.

**Row presence, per sampled document.** Every row the mapper produces is looked
up with null-safe equality on all of its columns, so it has to be present
verbatim. Catches a misaligned column list and a value SQLite coerced on the way
in.

**Field-level probes on sampled assets**, stated independently of the mapper —
identifiers, the nested arrays and their positions, the JSON payloads and the
generated columns read out of them. A check that uses the mapper as its own
definition of correctness cannot catch a mapper that is wrong.

**`PRAGMA foreign_key_check` and the reject list.** The first confirms the file
is safe to open with foreign keys on. The second lists documents that could not
be written at all; a single entry fails the verdict.

## Measured

A generated library at production's row count — 335,377 assets averaging
6.3 KB, 2,107 MB of MongoDB collection — on an M-series Mac, SQLite 3.54.0
under Bun 1.4.3, with MongoDB on the same machine.

| Phase                                  | Wall clock |
| -------------------------------------- | ---------- |
| Everything before the assets           | 0.9 s      |
| Assets and their seven fan-out tables  | 46.4 s     |
| Import total                           | 51.6 s     |
| Import plus the full verification pass | 64.4 s     |

That is the operator's downtime, and it produced a 2,136 MB database holding
335,377 asset rows, 335,377 locations, 151,117 faces, 335,377 detail and search
rows, 4,024,524 stage rows and 1,006,131 enrichment rows, with every table count
matching the source, 16,066 field checks passing and `foreign_key_check` clean.

Resumption was measured the same way: the same import was `kill -9`ed 25 seconds
in, having committed 190,000 of the 335,377 assets, and re-run with the same
command. The second run skipped the nine already-complete collections, finished
the assets in 42 seconds, and produced an `assets` table byte-identical to the
uninterrupted import — same SHA-256 over every row, and no difference in any of
the 35 table counts.

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

### Collections deliberately not imported

| Collection                 | Why not                                                                                                     |
| -------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `migrations`               | Mongo migration ids describing Mongo-shaped backfills. The SQLite runner keeps its own `schema_migrations`. |
| `worker_status`            | One cached status snapshot, rewritten by the workers within a poll cycle of the first boot.                 |
| `generated_searches`       | AI-generated search suggestions, regenerated by their worker.                                               |
| `video_geo_backfill_audit` | The audit log of a one-shot migration that has already run.                                                 |
| `image_access_tokens`      | Shape mismatch with the destination table, and minute-long lifetimes. See below.                            |
| `probe`                    | A connectivity ping, not data.                                                                              |

`image_access_tokens` is the only one where something is genuinely left behind.
On MongoDB the document is keyed by the SHA-256 of the token, carries the exact
URL path it is bound to and names no user; the SQLite table is keyed by a
24-character id, stores the hash in `token_hash` and requires a `user_id`
foreign key. There is no honest mapping, and inventing one would mean minting a
user attribution the source never recorded. These are capability tokens for
thumbnail and preview URLs with a lifetime measured in minutes — the cutover's
own downtime is longer than they live, and a client that finds one rejected
mints another on its next request.

### `app_settings` was missing from the schema and is added here

The collection has no accessor in `db/client.ts` — a dozen `*-config.repo.ts`
modules open it by name — so it was missed when the initial schema was
enumerated from that file. Without it a cutover silently drops the operator's
Cloudflare R2 credentials, map and pano configuration, network and observability
settings and every worker tunable. Migration `0002-app-settings` adds it: a
string key and the source document stored whole, so a key this server version
does not recognise survives too.

## Tests

```bash
cd src/api
bun test src/db/sqlite/import/
```

They run against a throwaway `mongod` on port 27077 and skip-pass when one is
not running, like every other Mongo-backed suite here. Never point them at
:27017 — that is a developer's real library.

The seeded library is small and deliberately awkward: multi-location assets, a
location under a library root that is not registered, faces both assigned and
unassigned, duplicate Apple Photos links, a large vision payload with an
`ObjectId` nested inside it, a legacy row with no `fileinfo` and no
`indexed_at`, retired stage names, a soft-deleted row and a damaged one. A
library of identical well-formed documents would satisfy the row counts and
prove nothing.

| File                     | What it holds to                                                              |
| ------------------------ | ----------------------------------------------------------------------------- |
| `import.test.ts`         | A full import: per-table counts, the fan-out, identifiers, the whole verdict. |
| `import-fields.test.ts`  | Field-level comparison — arrays, JSON payloads, dates, blobs, renamed fields. |
| `import-resume.test.ts`  | A real interruption mid-assets, then convergence on an uninterrupted import.  |
| `import-changes.test.ts` | The change-log window, and that its floor holds across a resume.              |

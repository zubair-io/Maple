# Refile-backups: a one-time cleanup migration for mis-filed mobile backups

- **Date:** 2026-06-18
- **Status:** Draft (awaiting review)
- **Area:** `src/api` — backup folder layout / migration worker
- **Supersedes:** `restructure-backup-geo`, `restructure-backup-folders`, `restructure-backup-screenshots` (and the geo spec `docs/superpowers/specs/2026-06-05-backup-geo-layout.md`)

## Problem

Mobile-backup photos are filed into folders derived from their geocoded location
(`<year>/<Country|State>/<Town/City|Place>`, screenshots into `<year>/Screenshot`,
no-location into `<year>/<MM>`). A cohort of already-processed backups is sitting
in the **wrong folder**, and the existing migrations never pick them up.

### Root cause: a one-way version stamp that lies

`restructure-backup-geo` gates its candidate query on
`backup_layout_version != 2` and stamps `backup_layout_version: 2` once it has
processed an asset ([restructure-backup-geo.ts:58,161](../../src/api/src/workers/migration/restructure-backup-geo.ts)).
The stamp is written even on a **no-op** move: when `computeGeoDir` finds no
usable location segments (an unresolved-geocode stub `place`), it returns the
asset's *current* directory, the move collapses to a stamp-only update, and the
asset is marked "done"
([restructure-backup-geo.ts:90-93](../../src/api/src/workers/migration/restructure-backup-geo.ts) +
the `noop` branch in [move-backup-asset.ts:133-151](../../src/api/src/workers/migration/move-backup-asset.ts)).

Nothing ever clears that stamp. So any backup the geo migration touched **before
its geocode resolved** is frozen in place: when geocoding later fills in `place`,
the `!= 2` filter permanently excludes it. This is a class bug, not a one-off.

### Worked example (the asset that surfaced this)

A Hasselblad backup, `IMG_0333.JPG`, captured in Paris:

- Stored at `fileinfo[0].path = "2026/24 rue Vignon"` — a POI-named, **pre-geo**
  path. The current segment logic can't even *produce* this: a POI only ever
  appears as the *second* segment, after a country/state
  ([location-segments.ts:59-64](../../src/api/src/backup/location-segments.ts)).
- Its `place` now fully resolves: `address.country = "France"`,
  `rollups.locality = "Paris"`. The canonical dir today is therefore
  **`2026/France/Paris`**.
- Yet it carries `backup_layout_version: 2`, so
  `restructure-backup-geo`'s `{ $ne: 2 }` selector skips it forever.

## Goal

A **single one-time cleanup migration**, `refile-backups`, that:

1. Sweeps every already-processed mobile-backup asset once.
2. Computes the canonical folder from the asset's *current* data.
3. Moves the asset (crash-safe) when, and only when, its folder is wrong.

…and deletes the three broken/now-redundant migrations it replaces.

### Non-goals

- **No ongoing / real-time self-heal.** This is a cleanup of images that already
  went through the pipeline. We do **not** touch the geocode stage, and we do
  **not** add a real-time geo relocate. (Screenshots keep their existing
  describe-stage real-time relocate — see "Preserving the describe hook".)
- **No data deletion.** No asset file is deleted except as the trailing step of a
  verified copy inside the existing crash-safe mover. The `backup_layout_version`
  field is *re-used*, not dropped.
- **No new file I/O.** All moves go through the existing `moveBackupAsset`.

## Design

### 1. One canonical-path function

The three migrations are three branches of one question: *what folder would a
fresh ingest put this asset in?* That is already defined by the ingest formatter
`formatBackupPath` ([path-formatter.ts:77-98](../../src/api/src/backup/path-formatter.ts)).
The cleanup computes that canonical directory and compares it to where the asset
actually sits.

```ts
// Pure, no DB / fs. Exhaustively unit-tested.
export function computeCanonicalDir(doc): string | null {
  const oldDir = doc.fileinfo?.[0]?.path;
  if (oldDir == null) return null;

  // The path's leading 4-digit segment wins over EXIF year, so an asset is
  // never moved across year folders; EXIF year is the fallback.
  const year = yearFor(oldDir, doc.exif?.captured_year);
  if (!year) return null; // pathological — every backup path starts with <year>/

  // Screenshot wins over location (a UI capture isn't a "place" photo).
  if (doc.is_screenshot) return `${year}/${SCREENSHOT_DIR_SEGMENT}`;     // subsumes restructure-backup-screenshots

  const segs = sanitizeLocationSegments(backupLocationSegments(doc.place ?? null));
  if (segs.length > 0) return `${year}/${segs.join('/')}`;               // subsumes restructure-backup-geo

  // No location, not a screenshot: flatten a recognised old day-folder
  // (<year>/<loc>/<MM-DD> or <year>/<MM>/<DD>), otherwise leave in place.
  return restructureDir(oldDir) ?? oldDir;                              // subsumes restructure-backup-folders
}
```

Reused building blocks (unchanged): `backupLocationSegments`,
`sanitizeLocationSegments`, `SCREENSHOT_DIR_SEGMENT`
([path-formatter.ts](../../src/api/src/backup/path-formatter.ts)), and
`restructureDir` ([restructure-path.ts](../../src/api/src/workers/migration/restructure-path.ts)).
`yearFor` is the same path-year-preferred helper both deleted migrations carried.

**Precedence note:** because geo is checked before the old-day-folder flatten, a
geocoded asset still in an old `<year>/<loc>/<MM-DD>` directory jumps **straight**
to its geo folder in one move — strictly better than the old two-migration
hop (flatten, then geo).

### 2. The migration

```ts
// Bumped from 2. v3 == "filed under the unified canonical layout".
export const BACKUP_LAYOUT_VERSION = 3;

function candidateFilter() {
  return {
    'phasset_links.0': { $exists: true },     // mobile-backup origin (all of them, per "all mobile backups w/ geo")
    'fileinfo.0.deleted_at': null,            // canonical entry is live
    backup_layout_version: { $ne: BACKUP_LAYOUT_VERSION },
  };
}
```

`runBatch` is the same shape as the deleted migrations: load a batch, resolve the
library root, `computeCanonicalDir`, then `moveBackupAsset(coll, doc, root,
newDir, { backup_layout_version: 3 })`. A `moved` or `noop` outcome counts as
processed; a concurrent-change `skipped` is left unstamped for a later tick.
`countRemaining` is `countDocuments(candidateFilter())`.

The selector intentionally has **no `place` requirement** — `computeCanonicalDir`
already handles the no-location case (flatten-or-leave), so including no-geo
backups is what lets this one migration subsume `restructure-backup-folders`.
For an asset already in its canonical folder the move is a no-op that only stamps
v3. The vast majority of correctly-filed assets take that path.

### 3. Why a stamp at all — and why it terminates

The migration worker drives done-detection off `countRemaining()`, which it calls
twice per 5 s tick and treats `0` as "done"
([types.ts:25-28](../../src/api/src/workers/migration/types.ts),
[migration.ts:85-114](../../src/api/src/workers/migration.ts)). A purely
stateless "scan every backup and compare paths" **cannot** drive that: a Mongo
count can't express "path ≠ computed", so the count would never fall and the
migration would re-scan-and-recompute the whole backup set every 5 s forever. A
persisted marker is therefore mandatory.

We re-use `backup_layout_version` and **bump it to 3**. The `{ $ne: 3 }` selector
matches every existing asset (v2, v1, or absent), so the cleanup re-sweeps the
entire backup population exactly once, recomputing each asset against its current
data and moving only the mis-filed ones — then stamps v3 and the count falls to
0. This is the same one-time full-population sweep that shipping v2 already
performed; it is precedented and bounded.

The original freeze bug does **not** recur here, because this is a one-time
cleanup: we are not relying on the stamp to stay correct as `place` changes in the
future (explicitly a non-goal). Every asset in the current library is re-evaluated
against its present-day `place`, which is exactly the data the frozen cohort was
mis-stamped without.

### 4. Crash-safe move (unchanged)

Moves go through the existing `moveBackupAsset`: copy + verify the file and its
companions into the new dir, repoint the matched `fileinfo` entry **between**
verify and delete (guarded by `$elemMatch` against concurrent moves), then delete
the source and reclaim the empty folder
([move-backup-asset.ts:114-226](../../src/api/src/workers/migration/move-backup-asset.ts)).
No photo is lost on a crash at any step. No new filesystem code is written.

**Scope is the canonical entry, `fileinfo[0]`.** That is not an arbitrary index:
the schema defines index 0 as the canonical path used for cache-path resolution
([schema.ts FileInfo / AssetDoc.fileinfo](../../src/api/src/db/schema.ts)), and
all three migrations this replaces key on `fileinfo.0`. Companions move with the
primary — `planAndPlace` copies the paired `.xmp` sidecars and the
`apple_rendered_path` rendered file and verifies each
([restructure-fs.ts:161-188](../../src/api/src/workers/migration/restructure-fs.ts)).
Sibling `fileinfo` entries (the same content observed in another library/device)
are **preserved, not stranded**: the repoint is a positional `$` on the
`$elemMatch`-matched entry, and those siblings point into other libraries, not the
old directory being reclaimed. A RAW+JPEG pair is two separate asset docs, each
migrated on its own pass — there is no multi-file asset to split.

### 5. Preserving the describe hook

`describe.ts` calls `relocateBackupScreenshot(image._id)` to file a screenshot
the moment the qwen2.5-vl verdict flips `is_screenshot`
([describe.ts:235](../../src/api/src/workers/stages/describe.ts)). That real-time
backstop is unrelated to this cleanup and must keep working. Since its host file
is deleted, the function **moves into the new `refile-backups.ts` module** (its
screenshot-dir computation expressed via the screenshot branch of
`computeCanonicalDir`), and `describe.ts`'s import is repointed. Behaviour is
unchanged.

**Concurrency with this cleanup is safe.** If the describe-stage relocate and a
`refile-backups` batch touch the same asset at once, both go through
`moveBackupAsset`, whose repoint is gated on an `$elemMatch` over the entry's
`(library_id, path, filename)` read at the start of the operation. Whichever
fires first changes the path; the loser's `$elemMatch` then misses
(`matchedCount === 0`), the copies it made are reverted, and it returns `skipped`
— no double move, no lost stamp. The describe metadata patch does not write
`fileinfo`, so the two updates don't overlap even when they interleave.

### 6. Bounding the candidate scan (partial index)

The candidate filter is unindexed today — `phasset_links.0`-exists +
`backup_layout_version: { $ne: 3 }` — so `countRemaining` (called twice per 5 s
tick, [migration.ts:85,105](../../src/api/src/workers/migration.ts)) and the batch
`find` each scan the **whole** `assets` collection. On this single-event-loop API
(the multi-process supervisor was collapsed in #135) a full scan every 5 s for the
duration of the run can stall HTTP handlers on a large library.

We add a **partial index** in `ensureIndexes`:

```ts
await db.collection('assets').createIndex(
  { backup_layout_version: 1 },
  { name: 'backup_layout_version_partial',
    partialFilterExpression: { 'phasset_links.0': { $exists: true } } },
);
```

The index contains entries only for mobile-backup docs, so the planner visits the
backup subset instead of the entire library. `createIndex` is idempotent (a no-op
when it already exists), consistent with the rest of `ensureIndexes`. It is a
small permanent index serving a one-shot migration — droppable once the cleanup
has completed library-wide, but left in place by default (it also covers any
future `backup_layout_version` re-sweep).

## Files

### Add
- `src/api/src/workers/migration/refile-backups.ts` — `refileBackups: Migration`,
  `computeCanonicalDir`, `BACKUP_LAYOUT_VERSION = 3`, the moved
  `relocateBackupScreenshot`, and a local `yearFor`.
- `src/api/src/workers/migration/refile-backups.test.ts` — unit + e2e (below).

### Change
- `src/api/src/workers/migration/index.ts` — registry: drop the three entries,
  add `refileBackups`.
- `src/api/src/workers/stages/describe.ts` — repoint the
  `relocateBackupScreenshot` import to `refile-backups.ts`.
- `src/api/src/db/schema.ts` — update the `backup_layout_version` doc-comment to
  describe v3 (the unified canonical layout) and reference `refile-backups`.
- `src/api/src/workers/migration.test.ts` — the folder-restructure e2e
  (lines ~85-142) is rewritten against `refile-backups`.
- `src/api/src/db/client.ts` — add the `backup_layout_version_partial` index to
  `ensureIndexes` (see §6).
- `docs/superpowers/specs/2026-06-05-backup-geo-layout.md` — header note marking
  it superseded by this spec.

### Delete
- `src/api/src/workers/migration/restructure-backup-geo.ts` (+ `.test.ts`)
- `src/api/src/workers/migration/restructure-backup-folders.ts`
- `src/api/src/workers/migration/restructure-backup-screenshots.ts` (+ `.test.ts`)
- `src/api/src/workers/migration/restructure-screenshot-path.ts` (+ `.test.ts`)

### Keep (reused)
- `restructure-path.ts` (+ `.test.ts`) — `restructureDir` / `OLD_LAYOUT_DIR_RE`.
- `move-backup-asset.ts`, `restructure-fs.ts`, `scrub-mirror-orphans`,
  `backfill-live-location-count`.

## Testing

TDD on `computeCanonicalDir` first. Port every case from the deleted path-tests
(`restructure-backup-geo`, `restructure-backup-screenshots`,
`restructure-screenshot-path`) into one table-driven suite, plus:

- **The regression that started this:** a v2-stamped doc at `2026/24 rue Vignon`
  with a fully-resolved Paris `place` → `computeCanonicalDir` returns
  `2026/France/Paris`, and an e2e pass moves the file and stamps v3.
- Geo (US state vs non-US country), screenshot wins over geo, no-location flatten
  of `<year>/<loc>/<MM-DD>` and `<year>/<MM>/<DD>`, stub/no-location leave-in-place,
  cross-year guard (path year preferred over EXIF), unsafe-segment sanitisation.
- **Idempotency:** a second `runBatch` after a clean pass moves nothing and the
  count is 0 (selector excludes v3).
- **e2e through `moveBackupAsset`** against real temp dirs (no fs mocks), asserting
  the file lands at the new path, the source is gone, `fileinfo[0]` is repointed,
  and the `thumb`/`preview` cache stages are reset.

Run: `cd src/api && bun test` (the CI gate). No new tsc errors vs. main.

## Rollout

Operator enables **Refile backups** on `/settings/workers`; it runs batch-by-batch
to completion, then idles. Each move is logged. Progress (processed / errors) and
the pending count surface in the workers UI, and the worker-level pause/resume
applies. Cancellable at any time via the per-migration toggle; re-enabling resumes
(already-stamped assets are skipped). **Disable the toggle once it reports done**
so its `countRemaining` scan stops contributing to the status pill (see Risks).

## Risks

- **Mass re-stamp cost.** The v3 bump re-evaluates every mobile backup once
  (~50 assets / 5 s). For a large library this is minutes to ~an hour of
  background work — the same order as the original v2 rollout. It is background,
  observable, and cancellable.
- **A `computeCanonicalDir` bug could move correctly-filed assets.** Mitigated by
  porting the full existing test corpus before deleting it, parity with
  `formatBackupPath`, and the crash-safe (never-overwrite, copy-verify-delete)
  mover. No-op moves for already-correct assets are gated and cheap.
- **Candidate-query scan cost** is bounded by the partial index (§6), which
  confines it to the backup subset. It still scans that subset each tick while the
  migration runs, so — as an operational practice — **disable the toggle once it
  reports done**: an enabled-but-finished migration keeps contributing a
  `countRemaining` scan to the status pill, which (unlike the tick loop) does not
  skip `done` migrations ([migration.ts:54-56](../../src/api/src/workers/migration.ts)).

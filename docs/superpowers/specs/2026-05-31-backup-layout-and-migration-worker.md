# Backup layout change + Migration worker — design

Ticket: [#744](https://github.com/zubair-io/Maple/issues/744). Brainstormed 2026-05-31.

Two related changes to the device-backup ("iPhone backup") library layout:

1. Drop the `MM-DD` day-subfolder for **new** backups (flatter path).
2. Add a generic **Migration** worker with a registry of named migrations and a
   per-migration toggle in `/settings/workers`; ship the first migration that
   restructures already-backed-up photos into the new layout.

---

## Part 1 — New backup folder structure

`formatBackupPath` (TS) / `PathFormatter.format` (Swift) — a byte-parity pair.

| | Old | New |
| --- | --- | --- |
| With location | `<year>/<loc>/<MM>-<DD>/<file>` | `<year>/<loc>/<file>` |
| Without location | `<year>/<MM>/<DD>/<file>` | `<year>/<MM>/<file>` |

Only the **day** grouping is dropped. Without a place, month stays as the
grouping level. All other behaviour (location slash→`_`, leading-dot / `..` →
treated as no-location, filename safety) is unchanged.

Both implementations change together; the existing per-language unit tests are
updated to the new expected strings. `BackupPathPreview` in
`BackupSettingsView.swift` (and its fallback literal) updates to match.

---

## Part 2 — Migration worker (API backend only)

### Shape

A library-wide, interval-fired worker — **not** a per-asset version-claim
stage. It is the exact `missing-reaper` pattern:

- Registered in the in-process `stageRegistry` (`name: "migration"`), so the
  existing `/api/workers/migration/{status,pause,resume}` surface controls it.
- Owns its own `setInterval` loop (mirrors `missing-reaper` / `trash-gc`), not
  `runStage()`.
- Started from `workers/maintenance.ts` alongside trash-gc + missing-reaper.
- Worker-level pause persists in `worker_config.paused` (the standard surface).

### Migration registry

A static array of named migrations:

```ts
interface Migration {
  id: string;            // stable key, e.g. "restructure-backup-folders"
  title: string;         // UI label
  description: string;   // UI blurb
  countRemaining(): Promise<number>;            // work still to do (drives status + done-detection)
  runBatch(batchSize: number): Promise<MigrationBatchResult>; // one bounded pass
}
```

Future migrations = add another entry. Done-detection is **count-based**
(`countRemaining() === 0`), never a stored counter — so a re-run after new data
appears just works.

### Per-migration state + toggle

Persisted in one `app_settings` doc `_id: "migration"` (mirrors
`missing-reaper-config.repo.ts`):

```ts
{
  _id: "migration",
  migrations: {
    "restructure-backup-folders": {
      enabled: boolean,                 // operator toggle
      status: "idle"|"running"|"done"|"error",
      processed: number,                // cumulative moved/deduped this enablement
      errors: number,
      last_error: string | null,
      started_at: string | null,        // ISO
      finished_at: string | null,       // ISO
    }
  }
}
```

Each tick, for every **enabled** migration whose `countRemaining() > 0`, run one
bounded batch, accumulate progress, and persist. When `countRemaining()` hits 0
mark `status: "done"` and idle. The worker idles (does nothing) when no
migration is enabled or all enabled ones are done. Worker-level `paused` gates
the whole loop.

### Routes (added to `workers/routes-main.ts`)

- `GET  /api/workers/migration/migrations` → `{ migrations: [{ id, title, description, enabled, status, processed, errors, remaining, last_error, started_at, finished_at }] }`
- `PATCH /api/workers/migration/migrations/:id` → body `{ enabled?: boolean, reset?: boolean }`. Toggling `enabled: true` resets status→running/started_at; `reset: true` clears progress back to idle. Re-reads on next tick.

Worker pause/resume/status reuse the generic `/:name/*` routes.

### Status surfacing

The migration worker isn't a claim stage, so `fetchStatusDbState`
special-cases it like `missing-reaper`: `pending` = sum of `countRemaining()`
across enabled migrations, so the Workers UI shows the live queue rather than
0/0/0.

---

## First migration — "Restructure backup folders"

Moves existing backed-up photos from `…/MM-DD/file` into the new
`year/place/file` (or `year/MM/file`) layout.

### Scope (which assets)

Backup-origin assets are exactly those carrying `phasset_links`. The query
selects assets with a non-empty `phasset_links` whose primary `fileinfo` entry
sits in an **old-layout 3-segment dir**. `countRemaining()` counts them.

### Path transform (idempotent)

The formatters only ever produce a **3-segment dir for old layout** and a
**2-segment dir for new layout**. So:

- 2 segments → already migrated → skip.
- Exactly 3 segments where seg0 = `^\d{4}$` AND either seg2 = `^\d{2}-\d{2}$`
  (with-location) OR (seg1 = `^\d{2}$` AND seg2 = `^\d{2}$`) (no-location) →
  **new dir = first two segments** (drop the 3rd).
- Anything else → not recognized → skip (never touch).

This kills the date-named-location bug: a *new-layout* path like
`2024/12-25/IMG.HEIC` (location literally "12-25") is 2 segments → skipped.

### Per-asset move — crash-safe ordering

The order is load-bearing (never lose / never orphan a photo):

1. **Copy** source bytes → target path.
2. **Verify** target == source via **full-file hash** (not `maple_id`/`sha1_head`).
3. **Move companions** the same copy→verify way: paired `.xmp` sidecars
   (`listPairedSidecars`, canonical + conflict copies) and the
   `apple_rendered_path` file.
4. **Update the DB** — rewrite the matched `fileinfo` entry to the new
   `(path, filename)` via surgical `arrayFilters` (keyed on the old
   `library_id/path/filename`, like `markSoftDeleted`'s `source`), and update
   `apple_rendered_path` in the same write.
5. **Delete** source file + source companions.
6. **Drop** the stale old-dir `.maple/` cache (keyed on `maple_id` + path —
   workers regenerate at the new path).

The DB update sits **between verify and delete**. Crash after (4): row points
at the good new file, old lingers as harmless orphan. Crash before (4): row
still points at the existing old file. Either way: no loss.

### Collisions (two files now resolving to the same target)

When the target path T is occupied:

- **Full-file hash equal** → the newcomer is redundant. Repoint this row's
  `fileinfo` entry to T **first**, then delete the source. (If T belongs to
  another row sharing `maple_id`, that's a pre-existing ingest-dedup artifact —
  log it; row-merge is out of scope.)
  - **Safety override:** if the source carries sidecars/companions the survivor
    lacks or that differ, do **not** dedupe-delete — fall back to suffix-rename.
    Dropping a byte-identical original whose XMP holds distinct edits would
    silently lose edits. Dedupe is the optimization; suffix-rename is the safe
    path. When in doubt, rename.
- **Hash differs** → `pickFreePath(T)` → numeric-suffixed name, copy there.
  Never overwrite T.

### Empty-folder cleanup

After a successful pass, the old `MM-DD` (and the now-childless `MM/DD` /
`<loc>/MM-DD`) dirs are removed **only if genuinely empty**. The old dir's
`.maple/` subtree (step 6) is dropped first, so "genuinely empty" is reachable.
`rmdir` is guarded to never touch anything at or above the library root.

### Discover-watcher interaction

Discover watches **every** registered folder, including the backup library, so
a move fires `unlink(old)` + `add(new)`.

- **No duplicate row:** `handle-event` dedups the `add` on `sha1_head` (content-
  invariant across the exif `maple_id` upgrade), finding the already-repointed
  row instead of inserting a new one. Verified.
- **Duplicate `fileinfo` entry (race):** if the watcher processes `add(new)`
  *before* our DB repoint, it can push a second `fileinfo` entry for the new
  path. Both then stat present, so the missing-reaper never prunes them. The
  migration therefore runs a **post-finalize `fileinfo` dedup** (collapse exact-
  duplicate live entries). It is stable: by then the old source is deleted and
  the new path is on the row, so `handle-event`'s "record location if not
  already present" guard suppresses any further re-add.

### Cache keying (folder reclamation)

The current thumb/preview stages write **content-addressed** caches
(`.maple/thumbs/<maple_id>.jpg`, `.maple/previews/<maple_id>_<size>.jpg`).
`dropOldCache` removes those AND the **legacy basename-keyed** scheme
(`<sha256Prefix16(filename)>.jpg`, `<basename_no_ext>_<size>.jpg`) so the old
day-folder is reclaimable regardless of which scheme produced the cache.
Regeneration at the new path is guaranteed by resetting the `thumb`/`preview`
stage versions in the repoint write.

---

## Acceptance criteria → where met

- New backups land at flatter paths; parity tests updated (TS + Swift). → Part 1
- `BackupPathPreview` shows the new path. → Part 1
- Migration worker registered with a registry + per-migration toggles in
  `/settings/workers`. → Part 2a + 2c
- Restructure migration: copy→verify→delete, collision dedupe/rename, companion
  move, cache drop, empty-folder cleanup, `fileinfo` update. → Part 2b
- Tests: path formatter (both langs), migration move logic, worker
  registration/status. → all phases

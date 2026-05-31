# Imports v1 — copy a server-local folder into a Library

**Ticket:** [#742](https://github.com/zubair-io/Maple/issues/742)
**Date:** 2026-05-31
**Scope:** API backend (Bun/Elysia/MongoDB) + Angular UI. Copy-only, non-destructive.

## Goal

Copy images, their `.xmp` sidecars, and movies from a **server-local folder** into a
registered Library, laid out on disk as:

```
<LibRoot>/<YEAR>/<MM-or-user-label>/<filename>
```

`YEAR`/`MM` derive from each file's **modified date** (UTC, parity with the backup path
formatter). The middle segment is a path-safe free-text label the user can edit per group
(default = two-digit month `MM`). **Originals are copied, never moved** — the
non-destructive invariant extends to imports.

## Flow

1. User picks a server-local folder (jailed to `MAPLE_ROOTS`).
2. Folder + subfolders are scanned; image/sidecar/movie files are grouped into `YEAR/MM`
   buckets by mtime.
3. User reviews groups and optionally renames each bucket (free text, path-safe).
4. User picks a **target Library** and clicks **Import** → one `imports` document is created
   (`status: pending`) holding the source, the target library, and the resolved per-file
   destinations.
5. The **import worker** claims the pending import (claim/lease on the doc, mirroring
   `JobRunner`), copies each file (skipping duplicates), and tells the indexer about each new
   image via `handleEvent({ kind: 'created', absPath }, folderId, libraryRoot)`.
6. Duplicate check **before** copying — `hashFileForId()` → dedup by `maple_id` then
   `sha1_head` (same keys as the discover watcher).

## Data model

New collection `imports`. The collection **is** the work queue — claim/lease fields live on
the doc, exactly like `JobDoc`.

```ts
export type ImportStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled';

export interface ImportFileEntry {
  /** Absolute source path on the server. */
  src: string;
  /** Destination path RELATIVE to the target library root (POSIX-separated). */
  dest: string;
  /** Bytes, for progress + the BSON-size note below. */
  size: number;
  /** Source mtime epoch-ms — the bucketing basis, retained for audit. */
  mtime: number;
  /** 'image' | 'sidecar' | 'movie' — drives the indexer hand-off decision. */
  kind: ImportFileKind;
  /** Per-file outcome, filled by the worker. */
  state: 'pending' | 'copied' | 'skipped_duplicate' | 'failed';
  /** Failure detail when state === 'failed'. */
  error: string | null;
}

export interface ImportDoc {
  status: ImportStatus;
  /** Absolute source folder the user picked. */
  source_root: string;
  /** Target library (a registered FolderDoc): _id + path snapshot. */
  library_id: ObjectId;
  library_root: string;
  files: ImportFileEntry[];
  /** Coarse progress; total = files.length. */
  progress: { current: number; total: number };
  counts: { copied: number; skipped: number; failed: number };
  error: string | null;
  // claim/lease — identical shape to JobDoc
  locked_by: string | null;
  lease_expires_at: string | null;
  cancel_requested: boolean;
  created_at: string;
  updated_at: string;
}
```

Sidecars are attached to their parent image's bucket (same `dest` directory, same label) so
a RAW and its `.xmp` never split across folders.

**BSON-size boundary (logged, not blocking):** one import = one ~16 MB BSON doc. Each
`ImportFileEntry` is ~200–400 bytes, so the doc stays well under the cap into the tens of
thousands of files. A 100k-file import would approach the limit; v1 does not chunk. If that
becomes real, split into N docs sharing an `import_group_id`. Noted here so the boundary is
visible.

## Module-by-module breakdown

All paths under `src/api/src/imports/` unless noted.

| Module | Responsibility |
| --- | --- |
| `db/schema.ts` (edit) | `ImportDoc` / `ImportFileEntry` / `ImportStatus` types. |
| `db/client.ts` (edit) | `importsCollection()` accessor + `imports_claim` index `{ status, lease_expires_at }` in `ensureIndexes`. |
| `imports/dest.ts` | **Pure.** `bucketFor(mtime) → { year, mm }`, `isSafeLabel(label)`, `destPath({ year, label, filename })` → `<year>/<label>/<filename>`. Reuses `isSafeFilename` from `backup/path-formatter.ts` for the filename; new directory-segment validation for the label. **NOT** `formatBackupPath` — that emits a `DD` segment we don't want. |
| `imports/scan.ts` | Walk `source_root` (+ subfolders, jailed to `MAPLE_ROOTS`), classify files (image / sidecar / movie / ignore), pair sidecars to images, group into buckets by mtime, return `ScanResult` (buckets with default `MM` labels). |
| `imports/copy.ts` | Copy one file atomically (temp-then-rename into the dest dir, `mkdir -p`). Dedup: `hashFileForId(src)` → look up `maple_id` then `sha1_head` in `assets`; skip if present. Returns per-file outcome. |
| `imports/repo.ts` | Typed Mongo ops: `createImport`, `getImport`, `listImports`, `claimImport`, `updateImportProgress`, `completeImport`, `failImport`, `markImportCancelled`, `requestImportCancel`, `isImportCancelRequested`. Mirrors `jobs.repo.ts` claim/lease. |
| `imports/worker.ts` | `ImportRunner` class mirroring `JobRunner`: claim → resolve target `FolderDoc` → per-file copy loop → `handleEvent` hand-off for images → progress/lease renewal → cancel-between-files. `start/stop` singleton glue + `startImportRunner()`/`stopImportRunner()` wired in `index.ts`. Tunables (poll/lease/enabled) read from `worker_config` collection (`name: 'import'`). |
| `routes/imports.ts` | `POST /api/imports/scan`, `POST /api/imports`, `GET /api/imports`, `GET /api/imports/:id`, `POST /api/imports/:id/cancel`. Server-side re-validation of every bucket label + source-folder jail check. Registered in the auth-gated sub-app in `index.ts`. |

### Web (`src/web`)

| Module | Responsibility |
| --- | --- |
| `maple-common/.../api/imports-api.service.ts` | `scan()`, `create()`, `list()`, `get()`, `cancel()` — `Observable`-returning, `API_BASE_URL` token, auth via interceptor. Plus API DTO types. |
| `maple/.../settings/imports/imports.component.{ts,html,scss}` | Folder pick → target library → scan → editable buckets → import → progress. Standalone, signals, `OnPush`, wrapped in `SettingsShellComponent`. |
| `maple/.../app.routes.ts` (edit) | Lazy route `settings/imports` behind `authGuard`. |
| `maple/.../settings/settings-shell.component.ts` (edit) | Add **Imports** nav item. |

## Security guardrails

1. **Source folder** must pass the `MAPLE_ROOTS` jail (`fs/browse.ts`) in the scan handler.
2. **Bucket labels** are free text that become directory names — a traversal vector.
   Validated **server-side** in `POST /api/imports` (not just the UI): reject `/`, `\`,
   `..`, leading `.`, empty, and over-long, same shape as `isSafeFilename` applied to a
   single directory segment.
3. **Filenames** validated via `isSafeFilename`.
4. **Copy, never move** — originals untouched. No delete path anywhere in this feature.
5. Atomic temp-then-rename so a crash never leaves a half-written destination visible.

## Tests

- `imports/dest.test.ts` — bucketing (UTC boundaries, leap, year rollover), label safety
  (traversal rejects), dest path assembly. **TDD: written first.**
- `imports/scan.test.ts` — temp-dir tree → buckets; sidecar pairing; jail rejection;
  movie classification.
- `imports/copy.test.ts` — copies file + sidecar to dest; dedup skip by `maple_id` and by
  `sha1_head`; atomic (no temp left behind).
- `imports/repo.test.ts` — round-trip CRUD + claim/lease contention (two claimers, one
  wins; expired lease re-claim).
- `imports/worker.test.ts` — end-to-end tick: pending → done, per-file states, `handleEvent`
  hand-off for images only (movies copied, not indexed), cancel-between-files leaves
  already-copied files in place.
- `routes/imports.test.ts` — endpoint happy paths + label-traversal rejection + jail
  rejection + bad-ObjectId 400s.

Real temp dirs and a real `maple_test_*` Mongo DB (no sidecar/db mocks — repo convention).

## PR sequencing (one branch, commits in order, single PR closing #742)

1. Schema + `imports` collection + indexes + pure `dest.ts` (+ `dest.test.ts`).
2. `scan` + `copy` + `repo` + `routes/imports.ts` (scan/create/status/cancel end-to-end) +
   tests.
3. Import worker (`ImportRunner`, copy + indexer hand-off) + worker tests + `index.ts` wiring.
4. Angular UI (folder pick → target library → scan → editable buckets → import → progress).

## Known limitations (v1)

- Movies are copied but **not indexed** (the indexer/watcher is image-only).
- One BSON doc per import request (fine to tens of thousands of files; see boundary note).
- Bucketing uses file mtime in **UTC** (parity with the backup path formatter).

## Open decisions — resolved to the proposed defaults

- **Bucketing timezone:** UTC (matches `formatBackupPath`).
- **Worker concurrency:** single import at a time (matches `JobRunner`'s v1 stance);
  tunables live in `worker_config` (`name: 'import'`), not env vars, so they're
  operator-toggleable.
- **Cancel granularity:** between files only; already-copied files stay.

## v2 (out of scope)

Pick a folder or image(s) from the user's **local computer** (browser upload), reusing the
chunked/resumable PhotoKit backup-ingest transport.

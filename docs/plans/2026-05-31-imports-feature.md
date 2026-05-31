# Plan — Imports (Maple Cloud / Self-Hosted)

Status: **proposal (not yet built)**
Date: 2026-05-31
Scope decided with requester: **API backend + Angular UI**, **copy (leave originals untouched)**, **numeric `MM` default bucket label**.

> Every PR closes a ticket. Before the first PR, open a GitHub issue (KTLO or Files board)
> for "Imports v1" and add `Closes #N` to each PR. This doc is the engineering plan that
> the issue points at.

---

## 1. Goal

Add an **Imports** feature to the Self-Hosted app that copies images / their `.xmp`
sidecars / movies from a **server-local folder** into a registered Library, organised on
disk as:

```
<LibRoot>/<YEAR>/<MM-or-user-label>/<filename>
```

…where `YEAR`/`MM` come from each file's **modified date** and the middle segment is a
path-safe free-text label the user can edit per group (default = two-digit month).

Flow:

1. User picks a server-local folder.
2. Folder + subfolders are scanned; files are grouped into `YEAR/MM` buckets.
3. User reviews groups and optionally renames each bucket (free text, path-safe).
4. User clicks **Import** → one `imports` document is created (`status: pending`) holding
   the source + the resolved destinations.
5. A new **import worker** claims the pending import, copies each file (skipping
   duplicates), and tells the indexer about each new file.

**v2 (out of scope here):** pick a folder or image(s) from the user's *local computer*
(browser upload), reusing the chunked backup-ingest transport.

---

## 2. Why this shape (fit with existing architecture)

The codebase already has every primitive this needs — we assemble, we don't invent:

| Need | Existing primitive we reuse |
| --- | --- |
| Claim/lease background loop | `JobRunner` shape in `src/api/src/job-runner/runner.ts` + `jobs.repo.ts` (`claimJob`/`completeJob`/`failJob`, status `queued→running→done`, lease auto-release). |
| "Tell the indexer there's a new file" | `handleEvent({ kind: 'created', absPath }, folderId, libraryRoot)` exported from `src/api/src/workers/discover/index.ts`. Already used this exact way by `enqueueBrowseIndex` in `fs/browse.ts:805`. |
| Duplicate detection | `hashFileForId(absPath)` in `src/api/src/indexer/id.ts` → `{ maple_id, sha1_head }`; dedup by `maple_id` then `sha1_head` exactly like `discover/handle-event.ts:240`. The unique `maple_id_gt_1` index already exists. |
| Year/Month path layout | `formatBackupPath` / `isSafeFilename` in `src/api/src/backup/path-formatter.ts` (we add an imports-specific variant; same safety rules). |
| Server-local folder browse + jail | `listDir` / `browseRoots` / `isUnderRoot` in `src/api/src/fs/browse.ts`; `MAPLE_ROOTS` jail. |
| Atomic file write (temp+rename) | pattern from `fs/xmp.ts` (`writeThumb`, `writeXmpAtomic`). |
| Paired sidecars on a source file | `listPairedSidecars(rawAbsPath)` in `fs/xmp.ts:507`. |
| Collection + index registration | `src/api/src/db/client.ts` (`*Collection()` helpers + `ensureIndexes`). |
| Typed Mongo schema | `src/api/src/db/schema.ts`. |
| Route group behind auth | Elysia plugin pattern (`routes/jobs.ts`), mounted in the `authedApi` sub-app in `src/index.ts:187`. |

**Design choice — dedicated collection as the queue (not the `jobs` collection).**
The requester explicitly described "a new worker `import`" that "looks at the import
collection." So the `imports` collection *is* the work queue (claim/lease lives on the
import doc), mirroring `JobDoc`'s lease fields. This keeps import state (source, per-file
destinations, per-file copy outcome) in one place the UI can poll directly.

---

## 3. Data model

New file additions to `src/api/src/db/schema.ts`:

```ts
export type ImportStatus =
  | 'pending'    // created, awaiting worker
  | 'running'    // worker claimed it
  | 'completed'  // all files copied or deduped, none failed
  | 'partial'    // finished but ≥1 file failed
  | 'failed'     // worker error before/independent of per-file work
  | 'cancelled';

export type ImportFileKind = 'image' | 'video';
export type ImportFileStatus = 'pending' | 'copied' | 'duplicate' | 'failed';

export interface ImportFileEntry {
  /** Absolute source path (server-local, inside MAPLE_ROOTS). */
  src_abs: string;
  /** Destination relative to the target library root, POSIX-separated,
   *  e.g. "2026/05/IMG_0001.dng". Collision disambiguation (-N) is applied
   *  by the worker at copy time and written back here. */
  dest_rel: string;
  kind: ImportFileKind;
  size: number;
  mtime: number;            // epoch ms — drove the bucket
  status: ImportFileStatus;
  /** Content id once hashed (for dedup + indexer hand-off). */
  maple_id?: string | null;
  /** Number of paired .xmp sidecars copied alongside (companions, not
   *  their own entries). */
  sidecars_copied?: number;
  error?: string | null;
}

export interface ImportDoc {
  source_path: string;             // the folder the user picked (absolute)
  target_library_id: ObjectId;     // → folders collection
  status: ImportStatus;
  files: ImportFileEntry[];
  counts: { total: number; copied: number; duplicate: number; failed: number };

  // claim/lease — identical semantics to JobDoc
  locked_by: string | null;
  lease_expires_at: string | null;
  cancel_requested: boolean;

  error: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}
export type ImportWithId = WithId<ImportDoc>;
```

Notes:
- **Sidecars are companions, not entries.** When an image is copied, the worker copies its
  paired `.xmp` sidecar(s) (`listPairedSidecars`) into the same destination dir. Orphan
  `.xmp` files (no matching image) are ignored by the scan.
- **Videos are copied but not indexed.** The discover watcher's `SUPPORTED_EXTS` is
  image-only, so movies land in the Library but get no `AssetDoc`. This is called out
  explicitly (not silently dropped) — see §9 "Known limitations".
- **Doc size.** A 10k-file import stores ~10k entries (~2–3 MB) — under the 16 MB BSON
  cap. If we later need bigger imports we split into chunked child docs; v1 keeps it
  simple in one doc. (Documented as a v1 boundary.)

`src/api/src/db/client.ts`:
- add `importsCollection(): Promise<Collection<ImportDoc>>`.
- in `ensureIndexes`, add:
  ```ts
  await db.collection('imports').createIndex(
    { status: 1, lease_expires_at: 1 }, { name: 'imports_claim' });
  await db.collection('imports').createIndex(
    { created_at: -1 }, { name: 'imports_list' });
  ```

---

## 4. Backend modules (new `src/api/src/imports/`)

All kept well under the 400-line soft budget.

### 4.1 `dest.ts` — pure path/label helpers (no I/O; the unit-test core)
- `sanitizeBucketLabel(raw: string): string | null` — trims, rejects `/`, `\`, `..`,
  leading `.`, control chars, length > 64; returns `null` when invalid so the route can
  400. Allows spaces (free text).
- `monthBucket(mtimeMs: number): { year: string; month: string; key: string }` —
  `year` = `YYYY`, `month` = `MM` (UTC, matching `formatBackupPath`), `key = "${year}/${month}"`.
  *(UTC is chosen for determinism + parity with the backup path formatter; documented.)*
- `importDestRel(mtimeMs, label, filename): string` — `${year}/${safeLabel}/${filename}`;
  throws on unsafe `filename` (reuse `isSafeFilename` from `backup/path-formatter.ts`).

### 4.2 `scan.ts` — recursive source scan + grouping
- `scanSource(sourcePath): Promise<OpResult<ScanResult>>`
  - Jail: resolve realpath, require it under `browseRoots()` (`MAPLE_ROOTS`), same posture
    as `fs/browse.ts`. Per-child realpath re-check to defeat symlink swaps.
  - Recurse subdirectories (skip dotdirs incl. `.maple/`). Classify each regular file:
    image (`IMAGE_EXTENSIONS` = RAW ∪ sharp/heic, reused from `fs/browse.ts`), video
    (`VIDEO_EXTENSIONS`, new small set: mov/mp4/m4v/avi/mkv/…), `.xmp` (companion — not
    listed), other (ignored).
  - Group images+videos by `monthBucket(mtime).key`.
  - Returns:
    ```ts
    interface ScanGroup { key: string; year: string; month: string;
      count: number; total_bytes: number; sample: string[]; } // sample = up to 5 names
    interface ScanResult { source_path: string; total_files: number;
      total_bytes: number; groups: ScanGroup[]; }
    ```
  - Scan returns **summaries only** (counts + sample names), not the full file list — keeps
    the response small and the create step authoritative (it re-scans).

### 4.3 `copy.ts` — one-file copy with dedup + sidecars + collision-safety
- `isDuplicate(srcAbs): Promise<{ dup: boolean; maple_id: string; sha1_head: string }>` —
  `hashFileForId(srcAbs)`, then `assets.findOne({ maple_id })` else `{ sha1_head }`.
- `copyFileAtomic(srcAbs, destAbs)` — `mkdir -p` dest dir, copy to `destAbs.tmp.<pid>`,
  `fsync`, `rename`. Returns final path.
- `pickFreeDestPath(destAbs)` — if `destAbs` exists, append ` (2)`, ` (3)` before ext
  (mirrors `pickFreeConflictPath` in `fs/xmp.ts`).
- `copyPairedSidecars(srcAbs, finalDestAbs)` — `listPairedSidecars(srcAbs)`, copy each next
  to the final image path; returns count.

### 4.4 `repo.ts` — typed Mongo ops for the `imports` collection
Mirrors `job-runner/jobs.repo.ts`:
- `createImport(input): Promise<ImportWithId>` (status `pending`, lease null).
- `getImport(id)`, `listImports(limit)`.
- `claimImport(workerId, leaseMs, now)` — `findOneAndUpdate` on
  `{ status: 'pending', locked_by: null } OR { status:'running', lease_expires_at < now }`,
  set `running` + lease + `locked_by`. Sort `created_at: 1`.
- `renewLease(id, leaseMs, now)`, `setFileResult(id, idx, patch)` (positional update +
  `$inc` the matching count), `completeImport(id, status, now)`, `failImport(id, error)`.
- `requestImportCancel(id)`, `isImportCancelRequested(id)`.

### 4.5 `worker.ts` — the import worker (the headline deliverable)
Class `ImportWorker` mirroring `JobRunner` (start/stop/tick + singleton glue
`startImportWorker` / `stopImportWorker`).

`tick()`:
1. `claimImport(workerId, leaseMs)`. No claim → `{ kind: 'no-claim' }` (caller sleeps).
2. Resolve target library: `folders.findOne(target_library_id)` → `{ _id, path }` =
   `(folderId, libraryRoot)`. Register the root (`registerRoot`) so writes pass the jail.
3. Track `seenMapleIds` in-memory (dedup two identical files inside one import run).
4. For each `files[i]` with `status === 'pending'`:
   - check `isImportCancelRequested` between files → if set, `completeImport(…, 'cancelled')`.
   - `isDuplicate(src)` (or `seenMapleIds.has`) → mark `duplicate`, `$inc counts.duplicate`.
   - else `destAbs = join(libraryRoot, dest_rel)`; `pickFreeDestPath`; `copyFileAtomic`;
     `copyPairedSidecars`; record `maple_id`; mark `copied`; `$inc counts.copied`.
   - on throw → mark `failed` with message; `$inc counts.failed` (continue; don't abort run).
   - **after a successful image copy** → `handleEvent({ kind:'created', absPath: destAbs },
     folderId, libraryRoot)` so the indexer skeleton-upserts immediately (videos: copy only).
   - `renewLease` every N files so long imports don't lose their claim.
5. Final status: `failed`-count 0 → `completed`; else `partial`. `completeImport`.

Idempotency / crash-safety: per-file `status` means a re-claimed import (after a crash /
lease expiry) skips already-`copied`/`duplicate` entries and resumes the `pending` ones.
`pickFreeDestPath` + the indexer's own `maple_id` dedup make a re-run safe even if a copy
half-finished.

Lifecycle wiring in `src/index.ts`:
- import `startImportWorker` / `stopImportWorker`.
- start it in the background boot block next to `startJobRunner()` (guarded by the same
  try/catch posture; respect a `MAPLE_IMPORT_WORKER_ENABLED` env, default on).
- stop it in `shutdown()` next to `stopJobRunner()`.

### 4.6 `routes/imports.ts` — Elysia plugin (mounted in the `authedApi` sub-app)
- `POST /api/imports/scan` `{ source_path }` → `ScanResult` (preview only).
- `POST /api/imports` `{ source_path, target_library_id, labels: Record<string,string> }`
  - validate `target_library_id` (ObjectId + exists in `folders`).
  - **re-scan** `source_path` server-side (don't trust a client file list), apply
    `labels[key]` per `YEAR/MM` bucket (default `MM` when absent), `sanitizeBucketLabel`
    each (400 on invalid), build `files[]` with resolved `dest_rel`, insert `pending`
    import → `{ id }` (201).
- `GET /api/imports` → `{ imports: [...summaries] }` (newest first, capped 200).
- `GET /api/imports/:id` → status view (counts, status, per-file omitted or paginated;
  return up to N recent `failed` entries for triage).
- `POST /api/imports/:id/cancel` → set `cancel_requested`.

Register in `src/index.ts:187` `authedApi` chain: `.use(importsRoutes)`.

---

## 5. Angular UI (`src/web`, project `maple` + shared `maple-common`)

Follows `docs/best-practices.md` § Angular: **standalone components, signals,
`input()`/`output()`, separate `.ts`/`.html`/`.scss`, observables at the service layer,
view-models in components.** (Exact file paths confirmed against the existing
settings-page + folder-picker pattern; the import page slots in beside them.)

### 5.1 Models — `projects/maple-common/.../models/import.model.ts`
Hand-written interfaces mirroring the API DTOs (`ScanResult`, `ScanGroup`,
`ImportStatusView`, `ImportFileEntryView`, status string unions).

### 5.2 Service — `projects/maple-common/.../services/import.service.ts`
Uses the shared `HttpClient` API wrapper (same base-URL + bearer interceptor every other
service uses):
- `scan(sourcePath): Observable<ScanResult>` → `POST /api/imports/scan`
- `create(req): Observable<{ id }>` → `POST /api/imports`
- `get(id): Observable<ImportStatusView>` → `GET /api/imports/:id`
- `list(): Observable<ImportStatusView[]>` → `GET /api/imports`
- `cancel(id): Observable<void>` → `POST /api/imports/:id/cancel`

### 5.3 Page — `projects/maple/.../features/import/`
`ImportPageComponent` (standalone) with a small step state machine via signals:
1. **Pick source folder** — reuse the existing server folder-browser component/service
   (the library-picker that drives `/api/fs/dir` / folder registration). If a reusable
   picker component exists it's embedded; otherwise a thin `FolderPickerComponent`
   wrapping the same `/api/fs` calls.
2. **Pick target library** — dropdown from `GET /api/folders`.
3. **Scan** → render `groups` as a table: `YEAR/MM`, editable **label** input
   (default `MM`, inline-validated path-safe), file count, total size. Live preview of the
   resulting path (`<Lib>/<year>/<label>/`).
4. **Import** → `create({ source_path, target_library_id, labels })` → route to progress.
5. **Progress** — poll `get(id)` every ~1.5 s (mirrors the existing jobs/workers-status
   polling pattern) until terminal status; show overall progress bar +
   copied / duplicate / failed / total, a **Cancel** button, and a failures list.

### 5.4 Navigation
Add an **Imports** entry to the app nav/sidebar and a lazy route
(`{ path: 'import', loadComponent: … }`) in the `maple` routes file, next to the existing
feature routes.

### 5.5 Web tests
- `import.service.spec.ts` — `HttpTestingController` round-trips for each method.
- `import-page` group-editor spec — label edit + validation + payload building.
Run via `bun run test`; lint via `bun run lint` (project rules).

---

## 6. Tests (backend)

`src/api/tests/imports.test.ts` (skip-pass when Mongo is unreachable, matching the repo's
existing test posture):
- **Pure**: `sanitizeBucketLabel`, `monthBucket`, `importDestRel` (incl. unsafe filename /
  label rejection, leading-dot, `..`, separators).
- **Scan**: build a temp dir with images/videos/xmp across two months → assert group keys,
  counts, sample names, and that `.xmp`/dotfiles are excluded from groups; jail rejection
  for a path outside `MAPLE_ROOTS`.
- **copy.ts**: temp src → temp dest; `pickFreeDestPath` disambiguation; sidecar copy;
  `isDuplicate` true when an asset row with the same `maple_id` exists.
- **repo**: `createImport` → `claimImport` (lease) → `setFileResult` → `completeImport`
  round-trip against a `maple_test_imports_<pid>` DB; second `claimImport` returns null
  while leased, then re-claims after lease expiry.
- **worker.tick()**: seed a `pending` import over a temp source + a temp library root;
  inject a fake `handleEvent` (or assert an `assets`/skeleton row + a `created`
  change event); assert one file `copied`, an identical second file `duplicate`, counts and
  final `completed`. Deterministic `now()`/`sleep()` injection like `JobRunner`.

No mocks for any sidecar/XMP file I/O — round-trip real files in temp dirs (repo rule).

---

## 7. Files touched / added

**API (new)**
- `src/api/src/imports/dest.ts`
- `src/api/src/imports/scan.ts`
- `src/api/src/imports/copy.ts`
- `src/api/src/imports/repo.ts`
- `src/api/src/imports/worker.ts`
- `src/api/src/routes/imports.ts`
- `src/api/tests/imports.test.ts`

**API (edit)**
- `src/api/src/db/schema.ts` (ImportDoc + types)
- `src/api/src/db/client.ts` (`importsCollection` + indexes)
- `src/api/src/index.ts` (mount route, start/stop worker, env var doc)

**Web (new)**
- `projects/maple-common/.../models/import.model.ts`
- `projects/maple-common/.../services/import.service.ts` (+ `.spec.ts`)
- `projects/maple/.../features/import/import-page.{ts,html,scss}` (+ spec)
- (optional) `folder-picker` wrapper if no reusable picker exists

**Web (edit)**
- `maple` routes file (+ lazy route)
- nav/sidebar component (Imports entry)

**Docs**
- `src/api/src/index.ts` env block: document `MAPLE_IMPORT_WORKER_ENABLED`.
- Short mention in `docs/feature-spec.md` (Imports) — optional, low priority.

---

## 8. Suggested PR sequencing

To keep each PR reviewable and under budget (and because the backend is independently
testable):

1. **PR 1 — schema + collection + indexes** (`schema.ts`, `client.ts`) and the pure
   `imports/dest.ts` with unit tests. Tiny, low-risk.
2. **PR 2 — scan + copy + repo + routes** (`scan.ts`, `copy.ts`, `repo.ts`,
   `routes/imports.ts`, mount in `index.ts`) + tests. Scan/create/status/cancel work
   end-to-end without the worker (imports sit `pending`).
3. **PR 3 — import worker** (`worker.ts`, start/stop wiring, env var) + worker tests.
   Imports now actually copy + notify the indexer.
4. **PR 4 — Angular UI** (models, service, page, nav, route) + web tests.

(If the requester prefers a single PR, collapse 1–3; keep the UI as its own PR regardless,
since web review + CI are separate gates.)

---

## 9. Known limitations / explicit non-goals (v1)

- **Movies are copied but not indexed** (the indexer is image-only). They live in the
  Library and sync via the File Provider, but get no `AssetDoc`. Called out, not hidden.
- **Single import doc per request** (one BSON doc holds all file entries). Fine to tens of
  thousands; very large imports would later need chunked child docs.
- **Bucketing uses file mtime in UTC** (parity with `formatBackupPath`). If users expect
  local-time bucketing we can switch — flagged as a decision point.
- **No move/delete-source** — copy only, per the chosen option. Originals are never
  touched (consistent with Maple's non-destructive invariant).
- **v2** (local-computer folder/file picking via browser upload) is deferred; it will reuse
  the chunked, resumable transport already built for PhotoKit backup ingest.

---

## 10. Open decisions to confirm before building

1. **Bucketing timezone** — UTC (proposed, parity with backup) vs. server-local.
2. **Worker concurrency** — single import at a time per process (proposed, simplest;
   matches `JobRunner` v1) vs. small pool.
3. **Cancel granularity** — cancel between files only (proposed) — already-copied files
   stay; no rollback.
4. **Issue/board** — which board does the tracking issue go on (KTLO vs Files)?

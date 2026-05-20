# Maple File Provider — Phase 3 Design (uploads + soft-delete trash)

**Status:** draft, 2026-05-16
**Phase 1 reference:** `.archived-plans/plans/2026-05-14-file-provider-phase1.md`
**Phase 2 reference:** `.archived-plans/specs/2026-05-16-file-provider-phase2-design.md`
**Implementation plan (to be written):** `.archived-plans/plans/2026-05-16-file-provider-phase3.md`

## Goal

Let users drag photos *into* the Maple library through Finder (uploads) and
*out of* it to the Trash (deletes), with both operations safe and reversible.
Phase 2 made XMP sidecars writable; Phase 3 makes asset files themselves
writable in a controlled way: new files come *in* from any photo source on the
user's machine, deletions go to a recoverable per-library trash.

The shape of the writable surface stays narrow on purpose:

- **You may add** any RAW or bitmap image the indexer already understands.
- **You may delete** any indexed asset. The bytes survive in `.maple/trash/`
  until the GC clears them or the user empties the trash.
- **You may restore** anything in the trash by dragging it back to a normal
  folder (or via the Maple app's Trash UI).
- **You may not** rename, move between folders, or modify RAW bytes in place.
  Those become Phase 6+.

## Scope

In:
- Drag-in uploads via the Finder mount for RAW formats (`RAW_EXTENSIONS`) and
  bitmap formats (`SHARP_EXTENSIONS`: `jpg`/`jpeg`/`png`/`heic`/`heif`/`tif`/
  `tiff`/`webp`/`gif`/`avif`). Other types rejected at the extension boundary.
- Drag-to-Trash deletes — server moves the file to `.maple/trash/<rel>` and
  flags `assets.deleted_at`. Sidecars (`.xmp`) move with the asset.
- A per-library `Trash` virtual folder visible at the root of each library
  root, exposing trashed items grouped by their original relative path.
- Restore by dragging from `Trash` back into a normal folder. Server moves the
  file back to its original location (or to a collision-resolved name).
- Server-side GC: assets where `deleted_at < now - 30d` are purged from disk
  and Mongo by a nightly worker.

Out (deferred):
- Rename, move-between-folders, or in-place modify of RAW bytes (Phase 6+).
- Bulk-empty-trash UI in the Maple app (Phase 6+; for now, trash empties via
  the 30-day GC or by deleting individual items from the Trash folder, which
  triggers immediate purge).
- Upload progress UI in the Maple app — File Provider's built-in progress
  surfaces in Finder's status; that's enough for v1.
- iOS uploads / deletes (Phase 4 covers iOS read; write is a Phase 4 follow-up
  if needed).
- Push change feed for upload-completion notifications (Phase 5b).

## Load-bearing principles (unchanged from Phase 1 + 2)

- **Originals are sacred.** RAW bytes are never modified in place. Delete moves
  the file; restore moves it back. The byte stream that hits `.maple/trash/`
  is identical to the byte stream that left the user's hands.
- **Server is source of truth.** All writes go to the server; the extension
  never holds divergent state. Finder's local cache is invalidated by the
  enumerator after each successful mutation.
- **Server-side identifiers.** Newly uploaded assets get a fresh Mongo
  `ObjectId` returned by the upload endpoint. Deleted assets keep their
  identifier — the file is in a different place, but the `_id` is stable.
  Restore preserves the `_id` too.
- **Phase boundary clean.** No partial Phase 4+ scaffolding (no iOS hooks, no
  rename/move handlers, no working-set machinery) sneaks in.

## Architecture overview

Four subsystems change. Phase 1 + 2 surfaces stay as-is.

### 1. Server upload endpoint

`POST /api/folders/:id/upload`

A streaming endpoint that accepts a single file at a time. The request body is
the raw file bytes (`Content-Type` reflects the file's MIME type), and the
target relative path is carried in headers so the body stays pure bytes:

| Header | Purpose |
|---|---|
| `X-Maple-Target-Path: <relative-path>` | URL-encoded path relative to the folder root, including the filename. Must not contain `..`, must not start with `.`. |
| `X-Maple-File-Mtime: <epoch-seconds>` | Optional. Source-file modification time, used as the on-disk mtime to preserve "captured at" / "imported at" ordering. Defaults to `Date.now()` if absent. |
| `Content-Length: <bytes>` | Required. Server rejects unbounded streams. |

The server:
1. Validates the path against the folder root (no `..` escape, no leading `.`,
   no `/`-prefixed absolute paths). Returns `400` on validation failure.
2. Confirms the extension is in the union of `RAW_EXTENSIONS` + `SHARP_EXTENSIONS`
   (case-insensitive). Returns `415 Unsupported Media Type` otherwise.
3. Refuses to overwrite an existing file. Returns `409 Conflict` with
   `{ "error": "file exists", "abs_path": "..." }`. (The File Provider already
   enforces no-overwrite per Apple's protocol; the server check is defense in
   depth for direct API callers.)
4. Streams the body to a temp file in the same filesystem (`.maple/.upload-<uuid>`),
   `fsync`s, then atomic-renames into place.
5. Enqueues an `indexer_queue` row of type `enrich-file` for the new path so
   thumbnails, EXIF, and search blob get populated normally. The asset doc is
   created up-front by the upload handler (so the response can return the
   `_id` synchronously); enrichment populates the rest asynchronously.
6. Returns `201 Created` with `{ "asset_id": "<hex>", "abs_path": "...", "size": N, "mtime": "..." }`.

The asset doc inserted on upload has `enrichment.status: "pending"` for every
stage, matching what the indexer writes for filesystem-discovered files. From
the rest of the app's perspective, an uploaded file is indistinguishable from a
file dropped onto the filesystem outside Maple's view.

### 2. Server soft-delete + restore endpoints

`DELETE /api/assets/:id`

1. Look up the asset by `_id`. Return `404` if not found.
2. If already trashed (`deleted_at != null`), return `204` (idempotent).
3. Compute trash path: `<folder_root>/.maple/trash/<original-relative-path>`.
   Create intermediate directories as needed.
4. Atomic-rename the file from `abs_path` to the trash path. If the target
   already exists in trash (re-delete of a previously restored item),
   append a numeric suffix: `.maple/trash/<rel-base>.<n>.<ext>`.
5. Move any paired `.xmp` (canonical + conflict-suffix forms) alongside.
6. Update the asset doc: `abs_path = <trash path>`, `deleted_at = now`,
   `original_path = <pre-trash abs_path>`. The `original_path` field is new
   and only present on trashed assets — restore reads it back.
7. Remove the asset from any Meilisearch index it's in (search shouldn't
   return trashed items).
8. Return `204 No Content`.

`POST /api/assets/:id/restore`

Request body: `{ "target_relative_path": "<optional rel path>" }`. If omitted,
restore to `original_path`.

1. Look up the asset. Return `404` if not found, `409` if not trashed.
2. Compute target path:
   - If body specifies `target_relative_path`, use `<folder_root>/<rel>`.
   - Else use `original_path` from the asset doc.
3. If the target exists, append `.restored` then a numeric suffix until free
   (`IMG_1.ARW` → `IMG_1.restored.ARW` → `IMG_1.restored.1.ARW`).
4. Atomic-rename the file from the trash path back to the target.
5. Move paired sidecars back.
6. Clear `deleted_at`, unset `original_path`, update `abs_path` to the new
   target.
7. Re-enqueue Meilisearch indexing for the asset.
8. Return `200 OK` with `{ "asset_id": "<hex>", "abs_path": "<new>" }`.

`GET /api/folders/:id/trash?limit=N&cursor=...`

Returns trashed assets for one library root, paged. Response shape mirrors
`GET /api/folders/:id/assets`:

```json
{
  "items": [
    { "asset_id": "...", "filename": "IMG_1.ARW",
      "original_relative_path": "2024/2024-01-15/IMG_1.ARW",
      "trash_relative_path": ".maple/trash/2024/2024-01-15/IMG_1.ARW",
      "size": 40000000, "mtime": "...", "deleted_at": "..." }
  ],
  "next_cursor": null
}
```

`GET /api/fs/dir` (existing endpoint) gains a single behavioural change: it
omits any file whose corresponding asset doc has `deleted_at != null`. The
`dirs` array does not change — physical subdirectories are always listed.

### 3. Server GC worker

A new worker stage `trash-gc` runs once a day (cron-scheduled, simple
interval-fired job). For each asset where `deleted_at < now - 30 days`:
1. Delete the file at `abs_path` (already in `.maple/trash/`).
2. Delete the paired sidecars if any.
3. Delete the asset doc from Mongo.
4. Log the action.

The 30-day window is hard-coded for Phase 3; making it configurable per folder
is a future ask. A force-empty endpoint (`POST /api/folders/:id/trash/empty`)
is intentionally out of scope here — too easy to nuke a library with a single
typo'd curl. If the user really wants to empty trash, they delete items from
the Trash folder one by one (or wait 30 days).

Deletion of an item that's already in the Trash folder triggers a permanent
purge: the extension calls `DELETE /api/assets/:id` again, the server sees
`deleted_at != null` already, treats it as the "user emptied this from trash"
signal, and does the disk + Mongo purge synchronously.

### 4. Extension write paths

**`createItem(basedOn:fields:contents:options:request:completionHandler:)`** is
no longer a `NSFeatureUnsupportedError` stub. Implementation:

1. Resolve the parent identifier (`itemTemplate.parentItemIdentifier`) to a
   library root + relative directory via `LibraryRootCache`. If the parent is
   the root container, reject with `noSuchItem` (uploads must go into a
   specific folder). If the parent is a trash container, reject with
   `featureUnsupported` (Phase 3 doesn't support uploading directly into
   trash).
2. Validate the filename extension against the supported set. Reject with
   `NSError(NSCocoaErrorDomain, NSFileWriteUnknownError)` otherwise.
3. Stream the `contents` URL through `URLSession.uploadTask(with:fromFile:)`
   to `POST /api/folders/:id/upload` with the computed `X-Maple-Target-Path`.
   Set `X-Maple-File-Mtime` from the template's `contentModificationDate` if
   present.
4. On `201`: parse the response, construct a `MapleItem(image: ...)` from the
   returned metadata, call `completionHandler(item, [], false, nil)`.
5. On `409`: call the handler with the existing item if we can synthesize it,
   otherwise `NSError(NSFileProviderErrorDomain, .filenameCollision)`.
6. On `415`: `NSError(NSCocoaErrorDomain, NSFileWriteUnknownError)`.
7. On other errors: pass through as `nil` item + the wrapped error.

**`deleteItem(identifier:baseVersion:options:request:completionHandler:)`**:

1. Parse identifier. Only `.asset` identifiers may be deleted. Reject folders
   and sidecars (sidecar delete already works via Phase 2; ignore the call
   here).
2. Call `DELETE /api/assets/:id`. On `204`, complete with `nil` (success). On
   error, surface.
3. The OS removes the item from the local cache. The next enumeration drops
   it from the parent folder (because the asset is filtered out by
   `deleted_at != null`) and surfaces it in the per-library Trash folder.

**`modifyItem(...)`** gains a single new behaviour for the restore flow: when
the changed fields include `.parentItemIdentifier` AND the new parent is a
normal folder AND the old parent was the Trash container, treat it as a
restore:

1. Parse old + new parent identifiers.
2. Old must be `trash/<folderID>`; new must be `folder/<folderID>:<rel>`. The
   `folderID` must match — restoring into a *different* library root is
   out of scope (would require the asset to live in a different physical
   folder root, which is a real move, deferred to Phase 6+).
3. Call `POST /api/assets/:id/restore` with the new relative path as the
   target.
4. Surface the restored item.

If any other field changes alongside the parent, the operation is treated as a
plain move and rejected with `featureUnsupported`. Phase 3 only restores
straight from trash; it does not rename-during-restore.

### 5. Extension enumeration changes

The root enumerator now appends one synthetic item per library root: a
`Trash` folder. So the root container's children become:

- Library root 1 (`folder/<id1>:`)
- Trash for library root 1 (`trash/<id1>`)
- Library root 2 (`folder/<id2>:`)
- Trash for library root 2 (`trash/<id2>`)
- ...

The trash item's `displayName` is `"Trash"` (potentially `"<library> Trash"`
if we ever support multiple libraries with collision-prone names; for v1, a
flat `"Trash"` is fine because each appears under its library root in
Finder's column view).

A new `TrashEnumerator` handles `trash/<folderID>` containers:

1. Call `GET /api/folders/:id/trash` with pagination.
2. For each entry, construct a `MapleItem` with:
   - `itemIdentifier = asset/<id>` (same as the asset's normal identifier)
   - `parentItemIdentifier = trash/<folderID>`
   - `filename = original_relative_path` last component, but suffixed with the
     time-of-delete (`IMG_1 (deleted 2026-05-15).ARW`) if the user has
     multiple deletions of files that resolved to the same name — extension
     synthesizes the suffix locally based on what's already in the page to
     avoid Finder displaying duplicate names.
3. Capabilities: `[.allowsReading, .allowsDeleting, .allowsReparenting]` —
   drag back to restore, delete from here to permanently purge.

The trash enumerator's `enumerateChanges` is no-op (matches the rest of
Phase 1). Manual Refresh in Settings invalidates everything including trash.

### 6. The `.maple/` visibility tension

Phase 1 specified that `.maple/` directories are exposed as hidden File
Provider items, not browsable. Phase 3 needs the user to *see* trash contents.

Resolution: `.maple/` is still hidden in Finder's normal directory view. The
File Provider does NOT enumerate `.maple/` as a child of a normal folder.
Instead, the Trash virtual folder is its own top-level item (a sibling of the
library root), and the extension translates between the virtual `trash/<id>`
identifier and the physical `<root>/.maple/trash/...` path on the server.
Finder users never see the `.maple/` prefix — they see "Trash" alongside their
photos folder.

## Identifier scheme (updated from Phase 1 + 2)

| Conceptual item | Encoded form | Notes |
|---|---|---|
| Domain root | `rootContainer` | Children = library roots + trash folders |
| Library root folder | `folder/<folderID>:` | Unchanged |
| Subdirectory | `folder/<folderID>:<b64url-relpath>` | Unchanged |
| File (asset) | `asset/<assetID>` | Unchanged. Used whether the asset is in a folder or in trash. |
| Sidecar (canonical) | `sidecar/<assetID>` | Phase 2 |
| Sidecar (conflict copy) | `sidecar/<assetID>:<b64url-name>` | Phase 2 |
| Trash container | `trash/<folderID>` | **New.** Per library root. Children = trashed asset items. |
| Working set | `workingSet` | Phase 5b. Empty in Phase 3. |

`FileProviderIdentifier` gains a new case:

```swift
case trash(folderID: String)
```

With encoding `trash/<folderID>` and decoding via the existing prefix-strip
pattern. Round-trip tests added.

## Restore flow (user perspective)

1. User accidentally deletes `IMG_42.ARW` by dragging it to macOS Finder's
   Trash. The extension catches `deleteItem`, calls `DELETE /api/assets/:id`.
   The file moves to `<root>/.maple/trash/2024/IMG_42.ARW`.
2. The Finder Trash itself is empty — File Provider items don't go there;
   the OS treats them as deleted-in-place. The file disappears from the
   library folder.
3. User opens the "Trash" folder visible at the root of Maple in Finder.
   `IMG_42.ARW` is there, dated when they deleted it.
4. User drags it back to the `2024/` folder. The extension catches `modifyItem`
   with old parent `trash/<root>` and new parent `folder/<root>:2024`. It
   calls `POST /api/assets/:id/restore` with `target_relative_path: "2024/IMG_42.ARW"`.
5. Server moves the file back. The asset re-appears in `2024/` on the next
   enumeration.

If the user drags it to a different folder (`2025/`), the restore endpoint
accepts that as the target. The file lives where the user dropped it.

If the original location is now occupied (the user uploaded a new file with
the same name in the meantime), the server appends `.restored` and the user
sees `IMG_42.restored.ARW` next to the new `IMG_42.ARW` — the same flavor of
disambiguation Phase 2 uses for sidecar conflicts.

## Error handling

- **Network failure during upload:** macOS retains the bytes in its local
  cache and retries when reachable. Standard File Provider behaviour. No
  client-side queue needed.
- **Auth failure (401, refresh fails):** Bubble up as
  `NSFileProviderError.notAuthenticated`. User signs back in, Phase 1
  token-mirror restores the extension.
- **Upload exceeds disk space on server:** Server returns `507 Insufficient
  Storage`, extension surfaces as `NSError(NSFileProviderErrorDomain, .insufficientQuota)`.
- **Restore-target collision:** Server resolves with `.restored` suffix, returns
  the new path. Extension surfaces the new name without erroring.
- **Delete of a still-being-uploaded item:** Server returns `409` (upload
  in progress, refuse to delete). Rare race; surface as `serverUnreachable`
  to trigger Finder's retry semantics.
- **Indexer fails to enrich after upload:** Asset still appears in
  enumeration (the upload handler created the doc up-front). The thumb
  endpoint serves a placeholder until enrichment catches up. Not a Phase 3
  concern.

## Testing strategy

### Unit (Swift, `swift test`)
- `FileProviderIdentifierTests` — add round-trip for the new `trash/<folderID>`
  form, including rejection of `trash/` (missing folder ID) and `trash//`
  (empty folder ID).
- `RemoteCatalogTests` — decode the `/api/folders/:id/trash` and
  `/api/assets/:id/restore` response shapes. Mock URL session via
  `StubURLProtocol` (already in the repo).

### API (Bun, `bun test`)
- `assets-upload.test.ts`:
  - Upload of a supported RAW writes the file to the right path, creates an
    asset doc with `enrichment.status: "pending"` for every stage, enqueues an
    `indexer_queue` row, returns 201 with the asset_id.
  - Upload of `.txt` returns 415; no file on disk; no asset doc.
  - Upload with `X-Maple-Target-Path: ../../etc/passwd` returns 400; no escape
    above the folder root.
  - Upload to a non-existent folder ID returns 404.
  - Upload that would overwrite an existing file returns 409; original
    untouched.
  - Concurrent uploads to the same target path: one succeeds, one returns 409.
- `assets-delete-trash.test.ts`:
  - DELETE of an indexed asset moves the file to `.maple/trash/<rel>`, sets
    `deleted_at`, returns 204. The original location no longer exists on disk.
  - DELETE of an asset whose sidecar exists moves both. The sidecar's
    `.maple/trash/` path mirrors the asset's.
  - DELETE of an already-trashed asset purges the file and the asset doc
    synchronously, returns 204.
  - DELETE of a non-existent asset returns 404.
- `assets-restore.test.ts`:
  - Restore of a trashed asset moves it back to `original_path`, clears
    `deleted_at`, returns 200.
  - Restore with `target_relative_path` writes to that path instead.
  - Restore into an occupied target appends `.restored`; response carries the
    new path.
  - Restore of a non-trashed asset returns 409.
- `folders-trash-list.test.ts`:
  - Returns trashed assets in deletion-time order (newest first).
  - Pagination via cursor works.
- `fs-dir-excludes-trash.test.ts`:
  - `GET /api/fs/dir` for a path that contains a trashed asset omits it from
    `images`. The physical file in `.maple/trash/...` is never enumerated by
    this endpoint.

### Integration (manual, pre-merge)
1. `bun run dev`, register a folder.
2. From Finder, drag a JPEG and a CR3 from `~/Downloads` into the Maple
   folder. Confirm both upload (Finder shows progress, files appear in the
   target folder).
3. Confirm in the Maple app that the new assets are indexed and viewable.
4. From Finder, drag one of the uploaded files to the Trash.
5. Confirm the file disappears from the Maple folder in Finder.
6. Open the "Trash" virtual folder at the root of the library. Confirm the
   deleted file is listed.
7. Drag it back to the Maple folder. Confirm it reappears.
8. Confirm in the Maple app that the asset is no longer trashed.
9. Verify that uploading a `.txt` file from Finder produces a Finder error
   dialog (the OS surfaces `NSFileWriteUnknownError`).

### Skipped
- Stress test: 10k concurrent uploads. Lightroom-class import workflows go
  through Maple's own upload API, not File Provider. Drag-in uploads via
  Finder are inherently low-volume.
- Property-based test of restore-collision suffix generation. Server logic is
  small (one `while exists: append .restored.N`), covered by integration.

## Performance invariants (unchanged)

Phase 3 doesn't touch the render loop. Uploads are streamed end-to-end
(`URLSession.uploadTask(with:fromFile:)` on the client; `pipeline` on Bun);
neither the client nor the server buffers a full 150 MB RAW. The 16 ms
slider-tick budget is unaffected because uploads happen out-of-band.

The one notable allocation is the upload-progress accounting that macOS does
on the extension's `Progress` object. Confirmed via `os_signpost` profiling
in Phase 1 that this is sub-millisecond per chunk; no further mitigation
needed.

## What ships at the end of Phase 3

A user can:
1. Drag a JPEG, PNG, HEIC, TIFF, or RAW file from anywhere on their Mac into
   any folder in the Maple Finder mount. The file uploads to the server and
   indexes normally.
2. Drag any asset (RAW + sidecar together) to the Trash. The file moves to
   `.maple/trash/`, the asset doc is flagged, the asset disappears from
   normal folder views.
3. Open the per-library "Trash" virtual folder visible at the root of each
   library, see what's been deleted (and when).
4. Drag a file from Trash back to any folder under that library root. The
   file restores; collisions resolve with `.restored` suffix.
5. Delete a file from inside the Trash folder. The file and its asset doc
   are purged immediately, irreversibly.
6. Wait 30 days for un-restored trash to GC automatically.

The RAW bytes themselves are never modified in place. Uploads write new files;
deletes/restores rename existing ones; the GC unlinks long-trashed files. No
Phase 3 code path mutates a RAW.

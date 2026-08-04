# File Management — Design

**Status:** Approved; tracked by [Milestone 23 · File Management](https://github.com/zubair-io/Maple/milestone/23), epic [#2660](https://github.com/zubair-io/Maple/issues/2660)
**Scope:** Apple (macOS/iPadOS/iOS), Windows (WinUI 3), and Web (Angular + Self Hosted API)
**Related:** [Milestone 21 · FileProvider correctness & hardening](https://github.com/zubair-io/Maple/milestone/21) (prior art for move/rename plumbing), [Milestone 22 · Windows Native Port](https://github.com/zubair-io/Maple/milestone/22), `docs/spec/08-io.md` § Import rules, `docs/maple-prd.md`

## Motivation

Maple has no first-class file management today. `docs/product-status.md` never lists rename, move, drag-and-drop reorganize, or batch rename as built, planned, or even tracked — it's a genuine gap in the roadmap, not an unfinished feature. Meanwhile the codebase has been drifting toward needing exactly this: the Self Hosted API has independently converged on the same crash-safe move primitive three separate times (backup re-file, organize-by-location, the day-dir refile migration), and it already has trash/restore and a real import pipeline. The gap is specifically **user-facing file management**: renaming an asset, moving it between folders, dragging files onto the app, and organizing the folder tree — none of which exist as UI on either platform today.

This doc audits current capability per platform, defines what's missing against ACDSee/Adobe Bridge-style file management, and designs the architecture and ticket breakdown to close the gap. Three surfaces are in scope: Apple, Web, and the WinUI 3 Windows port (Milestone 22), which is substantially built but has no file-management capability at all.

## Scope & non-goals

**In scope** — operations on files that already have a real path, which is what keeps "filesystem-native, no catalog lock-in" true even as capability grows:

- Rename (single asset, batch with template tokens)
- Move (drag-and-drop between folders, explicit "Move to…")
- Copy (duplicate into another folder)
- Delete → Trash, with Restore
- Folder CRUD (new/rename/move/delete) with a real context menu
- Drop-to-import (OS drag-in of new files/folders)
- Reconciling a file renamed/moved _outside_ Maple instead of orphaning its sidecar (a gap already named in `docs/spec/08-io.md` § Import rules)
- Cache/derivative invalidation so a move doesn't leave stale thumbnails

**Explicitly out of scope for this epic:**

- Virtual collections / smart albums / tag-based groupings decoupled from the folder structure
- Checksum-based duplicate detection
- Custom manual sort order within a folder/grid (distinct from folder-tree drag-and-drop, which _is_ in scope)
- PhotoKit rename/move — PhotoKit assets have no user-writable path (`docs/spec/01-data-model.md` invariant #3); the UI must surface _why_ file-management actions are unavailable for PhotoKit-sourced assets, not silently fail or hide them without explanation.

## Current-state audit

### Data model

`ImageAsset`/`AssetRef` identity is `(sourceKind, primaryURL)`; `sidecarURL` is **computed, not stored** specifically because the user can move files (`docs/spec/01-data-model.md` invariant #2). The unified `slug:relPath` addressing scheme (`src/web/projects/maple-common/src/lib/addressing/maple-address.ts`, mirrored in `src/api/src/library/address.ts`) already treats an asset's address as path-derived and expects callers to refresh rather than hold stale addresses — the identity model already assumes files move.

### Apple — what exists

- **Zero** drag-and-drop anywhere in the native SwiftUI app (`.draggable`, `.dropDestination`, `NSItemProvider` — no matches in `src/apple/Maple/Views`).
- FileProvider (`FileProviderExtensionCore.swift`, Milestone 21) supports **folder** rename/move via Finder (`modifyItem` → `catalog.moveFolder`), but explicitly returns `featureUnsupported` for renaming/moving an **individual asset**. `.folder`, `.trash`, `.mapleDir`, `.thumb`, and generic `.file` deletion are all explicitly unsupported too.
- The folder picker (`AppShell+FolderActions.swift`) opens/bookmarks a folder as a _source_; it does not copy files into anything.

### Web/API — what exists

More than expected — this is where most of the reusable primitive already lives:

- `src/api/src/fs/trash.ts` — `moveToTrash`, `moveOutOfTrash`, `moveSidecarsAlongside` (base-swap sidecar rename), `computeTrashPath` (`<root>/.maple/trash/<rel>`), `pickFreePath`/`pickFreeRestoredPath` (collision-safe suffixing).
- `routes/folders.ts` — `POST /:id/mkdir`, `POST /:id/move` (full directory rename/move, self-subtree guard, 409 on collision) — built to serve FileProvider, reusable for UI.
- `routes/library-relocate.ts` — crash-safe **copy → verify → repoint DB → delete source** for relocating an asset + sidecar, auto-renaming on collision. This pattern (`moveBackupAsset`) is reused a third time by the day-dir refile migration — it's the converged "move" primitive this codebase keeps re-deriving.
- `routes/imports.ts` — a real copy-based import pipeline (`scan`/`dest`/`copy`/`repo`/`worker`).
- `drop-zone.component.ts` — OS-file → app import via native HTML5 DnD, plus a File System Access "Open folder" flow. Import-from-OS only; grepping `CdkDrag`/`cdkDropList`/`dragstart` app-wide found no internal drag-and-drop for reorganizing assets.
- `folder-tree.component.ts` — pure navigation/selection. Zero `contextmenu`/rename/menu handling.
- **No rename endpoint exists** for individual assets anywhere in `src/api/src`.

### Windows (WinUI 3) — what exists

Least of the three. The port is real (net8.0-windows, WindowsAppSDK 1.6, CommunityToolkit.Mvvm, 34 C# files at `src/windows/Maple.WinUI`) but has no file management whatsoever:

- **Zero drag-and-drop of any kind.** Grepping the entire `src/windows` tree for `AllowDrop`, `CanDrag`, `DragItemsStarting`, `DragOver`, `Drop`, `DataPackage`, `StorageItems`, and `IDataObject` returns no matches on any term. No OS-file drop-to-import, no internal drag-to-move.
- **No trash concept.** No hits for `Recycle`, `Trash`, `RecycleOption`, `IFileOperation`, or `SHFileOperation`. The sources tree's only context-menu item is "Remove from Library," which explicitly never touches disk.
- **Sources tree** (`MainWindow.xaml:118-147`, `FolderNode` in `ViewModels/EditSessionViewModel.Library.cs`) is local library roots only — no rename, no new folder, no delete.
- **File I/O is scattered inline** across services and view-models with no abstraction layer: `Directory.CreateDirectory` in four places, `File.Move` in `Services/Xmp/SidecarStore.cs:60` and `Services/Cloud/CloudClient.cs:202`, `File.Delete` in two. No `Directory.Move`, no `File.Copy`, no `StorageFile`/`StorageFolder` usage anywhere.
- **XMP is a hand-rolled C# implementation** (`Services/Xmp/XmpParser.cs`, `XmpWriter.cs`), not routed through the Rust core — so the sidecar-follow logic is Windows' own.
- **Asset identity is right already**: `PhotoItem.FilePath` is a plain string and `SidecarStore.SidecarPathFor()` computes the sidecar path fresh via `Path.ChangeExtension` rather than storing it — matching the "computed, not stored" invariant. Preserve this during the move/rename work.

Two prerequisites fall out of the audit and land in the foundation group rather than inside individual features:

1. **The grid is `SelectionMode="Single"`** (`MainWindow.xaml:284`), and every handler reads `SelectedItem` singular. Batch rename, multi-asset drag, and multi-asset trash are all blocked until multi-selection exists ([#2634](https://github.com/zubair-io/Maple/issues/2634)).
2. **There is no test project at all** — no `.sln`, no test framework reference, zero tests under `src/windows`. Windows cannot join the parity harness until one exists ([#2635](https://github.com/zubair-io/Maple/issues/2635)).

Windows also carries filesystem constraints the other two surfaces don't: reserved device names (`CON`, `NUL`, `PRN`, `AUX`, `COM1-9`, `LPT1-9`), `MAX_PATH` at 260 characters unless long paths are opted into, a case-insensitive-but-case-preserving filesystem (so `img.cr3` → `IMG.CR3` is a real rename that naive collision checks reject as a self-collision), and sharing-violation failures when another process holds a file open. Each is an explicit acceptance criterion on the Windows tickets.

### Worker stages

Per-asset ongoing work (`exif`, `thumb`, `preview`, `describe`, `geocode`, …) is a versioned `defineStage()` entry in `workers/stages/manifest.ts`. Thumbnail/preview cache keys are path-and-mtime derived (`docs/caching.md`), so a move needs a stage-version bump to regenerate correctly — not a literal cache-file relocation.

### PRD conflict (resolved — see PRD diff below)

`docs/maple-prd.md:74` and `:291` state DAM/asset-management beyond the source tree is out of scope ("Maple is an editor, not a catalog"). The API side has already drifted this direction (trash, relocate, imports). This design keeps the _spirit_ of that non-goal — no virtual catalog, no database lock-in, filesystem stays authoritative — while making real file operations on real folders explicitly in scope. The PRD is updated to say this precisely rather than contradict shipped code.

## Core architecture

### The relocate primitive

One shared _semantic_ contract, reused by rename, move, copy, drag-to-folder, and folder move — implemented natively per platform (not shared code, since Swift/TS/browser have fundamentally different filesystem access):

```
relocate(asset, destination, mode: .move | .copy) throws -> RelocateResult
  1. Resolve destination path; on collision, ask the caller (Skip / Replace /
     Keep Both) for user-initiated ops, or auto-suffix (pickFreePath-style)
     for unattended/background ops (migrations, refile).
  2. Copy primary file to destination (copy, not move — crash safety).
  3. Verify (size + mtime — same-filesystem copies don't need a full
     checksum).
  4. Copy/rename the sidecar alongside, same base-swap logic as
     moveSidecarsAlongside.
  5. Repoint identity:
       - Filesystem/SMB (Apple direct): sidecarURL is computed not stored,
         so only the non-authoritative LibraryIndex entry needs a
         best-effort refresh.
       - Cloud/Web (API): repoint the Mongo fileinfo doc's path fields in
         the same transaction pattern library-relocate.ts already uses.
  6. If mode == .move: delete the original primary + sidecar.
  7. Bump the asset's thumb/preview stage-version so path-keyed caches
     regenerate through the existing worker pipeline — do not try to
     physically relocate cache files, since the cache key is path-derived.
  8. Return the new address/AssetRef so callers update without a full
     rescan.
```

**Failure direction:** any failure before step 6 leaves the original untouched (safe to retry). The one unsafe window is step 6 itself — a copy-succeeded-but-delete-failed leaves a duplicate, never data loss. This matches the failure direction the existing relocate workers already accept.

**Batch operations** run this per-asset with partial-failure semantics — report per-file success/failure, don't roll back succeeded files on a later failure (matches the existing batch-metadata editor), surface a summary ("18 of 20 moved, 2 skipped: collision").

### Platform routing

| Source                      | Where the op runs                                                                                                                                         |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Web, any source             | Bun API (extends the existing trash/relocate primitives into one generic path)                                                                            |
| Apple, Filesystem/SMB       | Direct local Swift I/O — new `MapleCore` module. No API hop: the app already has full local access, and one would break offline editing for zero benefit. |
| Windows, local disk/SMB     | Direct local C# I/O — new file-operations service, same reasoning as Apple                                                                                |
| Apple/Windows, Cloud source | Calls the same API the web app uses                                                                                                                       |
| Apple, PhotoKit             | Not supported — UI disables/explains                                                                                                                      |

Cross-platform parity is enforced by **golden-outcome tests** (same starting file tree + same operation → identical resulting tree, sidecar contents, and cache state), the same philosophy already used for XMP byte-parity — not by sharing code, since the platforms don't share a filesystem layer.

The one exception — the piece that _is_ shared code — is the **batch-rename template engine**, which goes in `raw-core` as a `filename.rs` module exposed through the existing `raw-ffi` (Apple, Windows P/Invoke) and `raw-wasm` (Web) surfaces. It is pure string logic with no platform dependency, it has four consumers (Apple, Web, Windows, API), and all three surfaces already link the core, so this reuses established plumbing at near-zero marginal build cost. Three hand-written template parsers would drift, and the drift would be user-visible: the same template over the same files producing different names on different machines.

### Drop-to-import — reference, never copy

Dropping onto the app is the same code path as "Open," not a new copy pipeline:

- **Drop a single file** → mount its parent folder as a source, jump into **Full Image** on that photo.
- **Drop a folder** → mount the folder as a source, land in **Browse**.
- **Drop multiple loose files** → mount their common parent, land in **Browse** with those files selected.
- **Drop something already inside a mounted source** → navigate/select, no remount.

This matches the existing invariant in `docs/spec/08-io.md` § Import rules: "a source is a reference to a location, not a copy of its contents."

**Platform caveat:** a browser tab can't hand a remote Self Hosted server a live reference to an arbitrary local folder — that's only mechanically possible via the File System Access API (already the "Open folder" flow in `drop-zone.component.ts`, Chromium-only). Where reference-in-place isn't possible (non-FSA browsers, or an explicit "bring these into my managed library" ingestion), the existing copy-based `imports.ts` pipeline is the correct fallback and stays as-is — this is a real platform constraint, not an inconsistency to paper over.

## Feature designs

### Rename

Single: inline edit (double-click the filename in the grid cell or Info panel; Apple: Enter; Web: F2 or double-click). Base name editable; extension preserved by default — retyping it is allowed but warns, since it doesn't transcode anything. Commits through `relocate(asset, sameFolder/newName, .move)`.

Batch: multi-select → "Batch Rename…" — a template-token modal (`{original}`, `{n}` sequence with configurable start/padding, `{date:FORMAT}` from EXIF, custom literal text, `{ext}`), live before/after preview, applied **sequentially** (a shared-destination template can collide with itself mid-batch, not just with pre-existing files).

### Move / copy via drag-and-drop

Drop targets are folder-tree nodes only (no grid-to-grid — reordering within a folder is out of scope). Default drag = move; the platform copy-modifier = copy. Multi-select drag carries the whole selection if the dragged item is part of it. Collisions **ask** (Skip / Replace / Keep Both) for user-initiated drags — unlike background workers, someone's watching.

- Apple: `.draggable`/`.dropDestination` with a `Transferable` of selected asset IDs — net new.
- Web: introduce `@angular/cdk/drag-drop` for this specifically. The existing native-HTML5-DnD in `drop-zone.component.ts` is right for OS-file-drop (`dataTransfer.files`) but wrong for widget-to-widget dragging (no drop-target highlighting, no drag preview, no `connectedTo`) — CDK is purpose-built for this and isn't a project dependency yet.
- Windows: `CanDragItems`/`DragItemsStarting` on the grid, `AllowDrop`/`DragOver`/`Drop` on the tree, with a `DataPackage` carrying selected asset IDs. Ctrl is the copy modifier. Blocked on grid multi-selection ([#2634](https://github.com/zubair-io/Maple/issues/2634)). Dragging assets _out_ to Explorer is out of scope for this epic.

### Folder tree CRUD

New Folder, Rename (inline), Move to Trash (recursive) via a real right-click context menu — currently absent on all three platforms. Web already has the backend (`POST /:id/mkdir`, `POST /:id/move`); it's purely a UI gap. Apple needs the same three actions wired to local `FileManager` calls (Filesystem/SMB) or `catalog.moveFolder` (Cloud) — today only Finder, via FileProvider, can rename/move a folder. Windows needs a `ContextFlyout` on its sources tree, which currently has exactly one item ("Remove from Library," which never touches disk). Recursive folder delete trashes all contained assets, preserving relative structure so restore can reconstruct the tree.

### Delete → Trash → Restore

Web/API has this per-asset already; needs a folder-level version and UI (Delete key, right-click, a "Trash" pseudo-node per source with Restore / Delete Permanently). Trashing to `.maple/trash/<rel>` is just `relocate(asset, trashPath, .move)` with a fixed destination — no separate mechanism.

The exceptions are the two desktop OSes that own a real trash: **macOS** uses `FileManager.trashItem` and **Windows** uses the shell `IFileOperation` API. Both are syscalls rather than copy-verify-delete, because the OS owns that semantics and the result stays recoverable from Finder/Explorer — which is what a desktop user expects and looks for. Neither presents a Maple Trash node for local sources, since the OS already has one.

Everything without an OS trash uses `.maple/trash/<rel>` and _does_ get an in-app Trash node: iOS/iPadOS (no OS trash for security-scoped folders), SMB (no reliable network recycle bin), and Cloud sources. 30-day auto-purge applies to the Maple-private trash only — the OS trashes are the OS's to manage. That asymmetry is deliberate but must be visible in the UI rather than silently different: a macOS or Windows user should understand their delete went to Finder Trash / the Recycle Bin.

### External-change reconciliation

Closes a gap already named in `docs/spec/08-io.md`: renaming a file outside Maple today orphans its sidecar permanently. On the next folder rescan, if a previously-indexed path goes missing and a new, unindexed file appears **in the same folder** with a matching cheap fingerprint (file size + EXIF `DateTimeOriginal` + camera serial — not a full checksum, RAWs are large), treat it as an external rename: move the sidecar and bump the cache stage-version instead of orphaning. Same-folder only for v1 — cross-folder external moves are an explicit, documented limitation, not silently mishandled.

**The false-positive guard is load-bearing, not a nicety.** This operation moves user edit data, so a wrong match silently attaches one photo's edits to a different photo. Reconcile only when exactly one plausible candidate exists; two candidates means decline and log. A committed test proving two same-size, different photos never merge is a required deliverable, not optional coverage.

Windows has an advantage worth exploiting: `FileSystemWatcher` raises a real `Renamed` event carrying both old and new paths, so a rename observed while the app is running needs no fingerprint heuristic at all — follow the event directly, with zero false-positive risk. The heuristic is only the fallback for renames that happened while the app was closed.

## Testing & parity strategy

- **Unit + integration** (both platforms): real temp directories with real files + sidecars, no mocks — collision handling, sidecar-follow, partial-batch-failure, crash-safety (kill mid-copy before delete → source untouched, no data loss).
- **Cross-platform outcome parity**: a declarative fixture format (`starting tree → operation → expected resulting tree + sidecar contents`), executed independently by Swift XCTest, the Bun test suite, and the Windows test project — proves identical outcomes without shared code. Windows needs a test project created first ([#2635](https://github.com/zubair-io/Maple/issues/2635)); it has none today, which also means its hand-rolled XMP serializer has never been verified against the shared golden corpus despite claiming byte-parity with the TypeScript one.
- **External-reconciliation heuristic**: a dedicated false-positive test — two genuinely different files sharing a size must not get merged.
- **UI mechanics**: not a color-parity concern. Accessibility-identifier-driven interaction tests (XCUITest / Playwright) verifying the drop actually moved the asset.
- **Cache invalidation**: an integration test asserting a move's stage-version bump triggers regeneration at the new path with no full rescan.

## Milestone & ticket breakdown

[Milestone 23 · File Management](https://github.com/zubair-io/Maple/milestone/23) — 32 tickets in 7 dependency-ordered groups, tracked by epic [#2660](https://github.com/zubair-io/Maple/issues/2660). Groups 1–6 parallelize once Group 0 lands.

**Group 0 — Foundation (blocks everything else)**

| Ticket                                                  | Work                                                                          |
| ------------------------------------------------------- | ----------------------------------------------------------------------------- |
| [#2628](https://github.com/zubair-io/Maple/issues/2628) | Filename template engine in `raw-core`, exposed via FFI + WASM                |
| [#2629](https://github.com/zubair-io/Maple/issues/2629) | API: generic `relocate` primitive unifying `trash.ts` / `library-relocate.ts` |
| [#2630](https://github.com/zubair-io/Maple/issues/2630) | API: folder-level trash + restore (recursive)                                 |
| [#2631](https://github.com/zubair-io/Maple/issues/2631) | Apple: `MapleCore` local file-operations module                               |
| [#2632](https://github.com/zubair-io/Maple/issues/2632) | Windows: local file-operations service                                        |
| [#2633](https://github.com/zubair-io/Maple/issues/2633) | Cross-surface outcome-parity harness                                          |
| [#2634](https://github.com/zubair-io/Maple/issues/2634) | Windows: grid multi-selection — _prerequisite_                                |
| [#2635](https://github.com/zubair-io/Maple/issues/2635) | Windows: test project + XMP round-trip seed — _prerequisite_                  |

**Group 1 — Rename**

| Ticket                                                                                                                                                                      | Work                                               |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| [#2636](https://github.com/zubair-io/Maple/issues/2636)                                                                                                                     | API: rename + batch-rename endpoints               |
| [#2637](https://github.com/zubair-io/Maple/issues/2637) · [#2638](https://github.com/zubair-io/Maple/issues/2638) · [#2639](https://github.com/zubair-io/Maple/issues/2639) | Inline single-asset rename — Web / Apple / Windows |
| [#2640](https://github.com/zubair-io/Maple/issues/2640) · [#2641](https://github.com/zubair-io/Maple/issues/2641) · [#2642](https://github.com/zubair-io/Maple/issues/2642) | Batch rename dialog — Web / Apple / Windows        |

**Group 2 — Move / drag-and-drop reorganize**

| Ticket                                                                                                                                                                      | Work                                                     |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| [#2643](https://github.com/zubair-io/Maple/issues/2643) · [#2645](https://github.com/zubair-io/Maple/issues/2645) · [#2647](https://github.com/zubair-io/Maple/issues/2647) | Folder-tree context menu — Web / Apple / Windows         |
| [#2644](https://github.com/zubair-io/Maple/issues/2644) · [#2646](https://github.com/zubair-io/Maple/issues/2646) · [#2648](https://github.com/zubair-io/Maple/issues/2648) | Drag assets onto the folder tree — Web / Apple / Windows |

**Group 3 — Drop-to-import (reference, never copy)**

| Ticket                                                                                                                                                                      | Work                                                                |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| [#2649](https://github.com/zubair-io/Maple/issues/2649) · [#2650](https://github.com/zubair-io/Maple/issues/2650) · [#2651](https://github.com/zubair-io/Maple/issues/2651) | Drop to mount and open — Apple / Web (File System Access) / Windows |

**Group 4 — Trash / Restore**

| Ticket                                                                                                                                                                      | Work                                                             |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| [#2652](https://github.com/zubair-io/Maple/issues/2652) · [#2653](https://github.com/zubair-io/Maple/issues/2653) · [#2654](https://github.com/zubair-io/Maple/issues/2654) | Trash + restore — Web / Apple (OS Trash) / Windows (Recycle Bin) |

**Group 5 — External-change reconciliation**

| Ticket                                                                                                                                                                      | Work                                                               |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| [#2655](https://github.com/zubair-io/Maple/issues/2655) · [#2656](https://github.com/zubair-io/Maple/issues/2656) · [#2657](https://github.com/zubair-io/Maple/issues/2657) | Same-folder external rename reconciliation — API / Apple / Windows |

**Group 6 — Polish**

| Ticket                                                  | Work                                                        |
| ------------------------------------------------------- | ----------------------------------------------------------- |
| [#2658](https://github.com/zubair-io/Maple/issues/2658) | Reveal in Finder / show in Explorer                         |
| [#2659](https://github.com/zubair-io/Maple/issues/2659) | Cache-invalidation-on-move verification across all surfaces |

## PRD diff

`docs/maple-prd.md:74` (Non-goals):

```diff
- **Asset management / DAM features beyond the source tree.** Maple is an editor,
- not a catalog. No proprietary catalog format, no metadata-database lock-in.
- Source tree + filesystem-native + XMP sidecars.
+ **Virtual catalog / DAM features decoupled from the source tree.** Maple is an
+ editor with file management, not a database-catalog app: no smart albums, no
+ tag-based virtual collections divorced from real folders, no checksum-based
+ duplicate detection, no proprietary catalog format. The filesystem is always
+ authoritative; any server-side index (Self Hosted) is a disposable cache of
+ it, never the source of truth. Rename, move, copy, delete, and folder
+ operations on real files are in scope — see
+ docs/superpowers/specs/2026-08-04-file-management-design.md.
```

`docs/maple-prd.md:291` (§13 Out of scope, reiterated):

```diff
- Catalog / DAM beyond the source tree.
+ Virtual catalog / DAM features decoupled from the source tree (smart albums,
+ tag-based collections, duplicate detection). Real file operations (rename,
+ move, copy, delete, folder CRUD) are in scope.
```

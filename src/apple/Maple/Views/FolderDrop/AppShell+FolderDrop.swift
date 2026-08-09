// AppShell+FolderDrop.swift — accept OS file/folder drops onto the app
// window and mount them the same way "Open" does (#2649).
//
// Scope: macOS + iPadOS only (the `.dropDestination(for: URL.self, …)`
// modifier is wired onto `paneShellWithLayout` in `AppShell.swift`, which
// iPhone's `phoneTabShell` never renders — see `MapleShellKind`). The
// SAME entry point (`handleWindowDrop`) is also wired onto every sidebar
// row's own `URL.self` drop target (`LibrarySidebar.onDropURLs`) — SwiftUI
// does not let a differently-typed drop fall through from a nested
// `.dropDestination` (e.g. the sidebar rows' `DraggedAssetPayload` target)
// to an ancestor's, so relying on a window-level-only handler would leave
// the sidebar — the most intuitive drop target — dead to Finder drags.
//
// All ROUTING logic (which of the four ticket cases a drop is) lives in
// `MapleCore`'s `DropMountPlanner` — pure, unit-tested, no I/O. This file
// is the thin SwiftUI-facing layer that:
//   • gathers the "already mounted" root set from live `AppShell` state
//     (`activeScopeURL`/`currentRootBookmark`) + `SavedFolderStore`
//   • confirms sandbox access to a dropped item's PARENT folder before
//     mounting it (see `confirmParentFolderAccess`'s doc comment — a
//     Finder drag only grants scope to the exact item dragged, never its
//     parent, so enumerating the parent needs an explicit, separate grant)
//   • resolves a `DropPlan` into the actual `loadFolder`/`openSubFolder`/
//     selection calls those flows already expose
//   • owns the one new user-facing failure mode: an unsupported drop
//     surfaces through the same `browseVM.loadError` banner every other
//     folder-flow error uses (`AppShell+FolderActions.swift`), not a new
//     mechanism.
//
// Bookmark persistence is NEVER reimplemented here — every mount goes
// through `loadFolder(url:)` (fresh mount) or `openSubFolder(rootBookmark:)`
// (reusing an already-persisted bookmark), exactly as `docs/spec/08-io.md`
// § Import rules requires: "a source is a reference to a location, not a
// copy of its contents."

import SwiftUI
import MapleCore

@MainActor
extension AppShell {
    /// Entry point for `.dropDestination(for: URL.self, action:)` — wired
    /// onto both `paneShellWithLayout` (the window) and every sidebar row.
    /// Returns whether the drop was accepted — SwiftUI plays the "reject"
    /// animation when `false`. Single-flighted: `isProcessingWindowDrop`
    /// guards against SwiftUI firing the action closure twice for one
    /// physical drag-release, and against a second drop overlapping the
    /// first's async folder-access confirmation (#2649 review finding I2).
    /// Always returns `true` synchronously once accepted — the actual
    /// mount work (including a possible confirmation panel) runs in a
    /// detached `Task`, since `.dropDestination`'s action closure has no
    /// async overload.
    func handleWindowDrop(_ urls: [URL]) -> Bool {
        guard !urls.isEmpty else { return false }
        guard !isProcessingWindowDrop else { return false }
        isProcessingWindowDrop = true
        Task { @MainActor in
            defer { isProcessingWindowDrop = false }
            await processWindowDrop(urls)
        }
        return true
    }

    /// The actual routing, run inside `handleWindowDrop`'s single-flighted
    /// `Task`. Split out so `navigateExistingMount`'s "root vanished"
    /// fallback can re-enter the SAME planning logic without going back
    /// through — and being rejected by — `handleWindowDrop`'s in-flight
    /// guard.
    private func processWindowDrop(_ urls: [URL]) async {
        let plan = DropMountPlanner.plan(for: urls, mountedRoots: mountedDropRoots())
        switch plan {
        case .unsupported(let extensions):
            browseVM.loadError = FileOperationError.unsupportedDropType(extensions)
        case .mountFolder(let folder):
            // The dropped folder is the item Finder granted scope to
            // directly — no confirmation panel needed, unlike the two
            // parent-folder cases below.
            loadFolder(url: folder)
        case .openFile(let file, let parentFolder):
            guard let confirmedFolder = await confirmParentFolderAccess(seed: parentFolder) else { return }
            loadFolder(url: confirmedFolder)
            openDroppedFile(file)
        case .mountAndSelect(let parentFolder, let files):
            guard let confirmedFolder = await confirmParentFolderAccess(seed: parentFolder) else { return }
            loadFolder(url: confirmedFolder)
            selectDroppedFiles(files)
        case .navigateExisting(let root, let items):
            await navigateExistingMount(root: root, droppedItems: items)
        }
    }

    // MARK: - Sandbox scope confirmation (B1)

    /// A Finder drag grants the app a sandbox extension on the EXACT item
    /// dragged — never its parent directory. Dropping a single file (or
    /// several loose files) therefore never carries scope for the folder
    /// `DropMountPlanner` wants to mount: `claimScope(for:)` silently no-ops
    /// on an unscoped URL, and `FilesystemSource.open`'s `bookmarkData`
    /// call throws, which `loadFolder`'s catch swallows as non-fatal — net
    /// result, the folder never actually enumerates and no bookmark
    /// persists. No code-side workaround exists; only an explicit, separate
    /// user grant of the parent folder does. This presents that grant:
    /// macOS via `NSOpenPanel` seeded at the dropped item's folder (so it's
    /// a one-click confirmation, not a fresh navigation); iOS/iPadOS via
    /// the ordinary `.fileImporter` (no seeding API exists there — a
    /// documented platform constraint, not an oversight).
    ///
    /// Returns `nil` if the user cancels. Never called for a whole-folder
    /// drop (`.mountFolder`) — that item already carries real scope — nor
    /// for `.navigateExisting`, which reuses an already-persisted bookmark.
    func confirmParentFolderAccess(seed: URL) async -> URL? {
        #if os(macOS)
        await FilesystemSource.presentFolderPicker(
            seedDirectory: seed,
            prompt: "Grant Access",
            message: "Confirm access to the folder that contains the dropped photo — Maple references it in place, no copy."
        )
        #else
        await withCheckedContinuation { continuation in
            dropConfirmationContinuation = continuation
            showDropConfirmationPicker = true
        }
        #endif
    }

    /// Single consume-point for `dropConfirmationContinuation` — the
    /// `.fileImporter` success closure and its `.onChange`-driven cancel
    /// fallback in `AppShell.swift` both call this unconditionally instead
    /// of each touching the continuation directly. Only the FIRST call
    /// actually resumes; every later call (including the deferred
    /// cancel-fallback racing in after a real pick already resolved things)
    /// is a silent no-op — same exactly-once shape as
    /// `AssetDropCollisionResolver`, inlined here rather than extracted
    /// since this is the one call site.
    func resolveDropConfirmation(_ url: URL?) {
        guard dropConfirmationContinuation != nil else { return }
        let continuation = dropConfirmationContinuation
        dropConfirmationContinuation = nil
        continuation?.resume(returning: url)
    }

    // MARK: - Mounted-root detection

    /// Every local-folder root the app already knows about: the currently
    /// active browse root (if the current selection is a filesystem folder
    /// AND its bookmark has actually settled — see `currentRootBookmark`'s
    /// "invalidate first" convention in `AppShell+FolderActions.swift` for
    /// why `nil` mid-transition is the correct, safe reading) plus every
    /// folder in the recents list. A drop under any of these is "already
    /// inside a mounted source" per the ticket — navigate, don't remount,
    /// don't mint a new bookmark.
    private func mountedDropRoots() -> [URL] {
        var roots: [URL] = []
        if case .folder = librarySelection, let activeScopeURL, currentRootBookmark != nil {
            roots.append(activeScopeURL)
        }
        roots.append(contentsOf: SavedFolderStore.load().map { URL(fileURLWithPath: $0.path) })
        return roots
    }

    /// The persisted bookmark for a root `mountedDropRoots()` already
    /// returned. The active root's bookmark lives in `currentRootBookmark`;
    /// any other known root's bookmark comes from `SavedFolderStore`. `nil`
    /// only if the root vanished from both between detection and this call
    /// (e.g. removed from the sidebar mid-drop) — the caller falls back to a
    /// fresh mount rather than dropping the gesture.
    ///
    /// Compares plain `.path`, NOT `.standardizedFileURL.path` — for a URL
    /// that names an existing directory, `.standardizedFileURL` normalizes
    /// in a trailing "/" that the paths stored by `loadFolder`/
    /// `SavedFolderStore` (built from a bare `url.path`) never carry, which
    /// would make an otherwise-identical root compare unequal. Case-
    /// INSENSITIVE for the same reason `URL.isDescendant(ofOrEqualTo:)` is
    /// (APFS default volume format — see its doc comment).
    private func bookmarkForMountedRoot(_ root: URL) -> Data? {
        if let activeScopeURL, activeScopeURL.path.caseInsensitiveCompare(root.path) == .orderedSame {
            return currentRootBookmark
        }
        return SavedFolderStore.load()
            .first { $0.path.caseInsensitiveCompare(root.path) == .orderedSame }?
            .bookmark
    }

    // MARK: - Plan execution

    /// Find the freshly-loaded asset matching a dropped file and open it in
    /// Full Image — `browseVM.assets` is populated SYNCHRONOUSLY inside
    /// `loadFolder(url:)` (the bookmark persistence is what's async), so this
    /// is safe to call right after `loadFolder`.
    private func openDroppedFile(_ file: URL) {
        guard let asset = matchingAsset(for: file) else { return }
        openEditor(for: asset)
    }

    /// Enter multi-select and check exactly the assets matching `files`.
    /// Silently matches nothing for a dropped folder path (folders never
    /// appear in `browseVM.assets`) — acceptable degradation for the
    /// unspecified mixed-folders-and-files case; the folder still gets
    /// mounted and shown as a sub-folder tile.
    private func selectDroppedFiles(_ files: [URL]) {
        let ids = files.compactMap { matchingAsset(for: $0)?.id }
        guard !ids.isEmpty else { return }
        browseVM.isSelecting = true
        browseVM.selectedIDs = Set(ids)
    }

    private func matchingAsset(for file: URL) -> AssetRef? {
        browseVM.assets.first { $0.primaryURL?.path == file.path }
    }

    /// Drop landed under an already-mounted root. Re-derive the navigation
    /// target with the SAME planner, this time with an empty mounted-roots
    /// list so it can't recurse back into `.navigateExisting` — this reuses
    /// exactly the folder/file/multi-file split `DropMountPlanner` already
    /// does for a fresh mount, so "drop an already-mounted sub-folder" lands
    /// on that sub-folder (not the root) and "drop already-mounted loose
    /// files" selects them in place. Both cases already have a valid,
    /// persisted bookmark for `root` (that's what made them "already
    /// mounted"), so — unlike `processWindowDrop`'s fresh-mount branches —
    /// nothing here ever needs `confirmParentFolderAccess`.
    private func navigateExistingMount(root: URL, droppedItems: [URL]) async {
        guard let bookmark = bookmarkForMountedRoot(root) else {
            // Root disappeared between detection and here — fall back to a
            // fresh mount. Calls `processWindowDrop` directly (not
            // `handleWindowDrop`) — we're already inside its single-flighted
            // `Task`, and `handleWindowDrop` would just reject a recursive
            // call while `isProcessingWindowDrop` is still true.
            await processWindowDrop(droppedItems)
            return
        }
        switch DropMountPlanner.plan(for: droppedItems, mountedRoots: []) {
        case .mountFolder(let folder):
            navigate(toSubFolder: folder, rootBookmark: bookmark, thenSelect: [])
        case .openFile(let file, let parentFolder):
            navigate(toSubFolder: parentFolder, rootBookmark: bookmark, thenSelect: [], thenOpen: file)
        case .mountAndSelect(let parentFolder, let files):
            navigate(toSubFolder: parentFolder, rootBookmark: bookmark, thenSelect: files)
        case .unsupported(let extensions):
            browseVM.loadError = FileOperationError.unsupportedDropType(extensions)
        case .navigateExisting:
            // Unreachable — the recursive call passes `mountedRoots: []`.
            break
        }
    }

    /// Navigate to `folder` inside an already-mounted root, then select
    /// and/or open once the load actually lands — skips the round-trip
    /// through `loadFolder`'s bookmark-persistence `Task` entirely by
    /// reusing `openSubFolder`, whose `onComplete` fires only after
    /// `browseVM.assets` has been replaced.
    private func navigate(toSubFolder folder: URL, rootBookmark: Data, thenSelect files: [URL], thenOpen file: URL? = nil) {
        // Plain `.path` (matches how `loadFolder`/`openSubFolder` stamp
        // `librarySelection` — a bare `url.path`, never standardized),
        // case-insensitive for the same APFS reason as everywhere else in
        // this file.
        let currentPath: String? = {
            guard case .folder(let path) = librarySelection else { return nil }
            return path
        }()
        let alreadyShowing = currentPath?.caseInsensitiveCompare(folder.path) == .orderedSame
            && currentRootBookmark == rootBookmark
        if alreadyShowing {
            if let file { openDroppedFile(file) } else { selectDroppedFiles(files) }
            return
        }
        openSubFolder(url: folder, rootBookmark: rootBookmark) {
            if let file { openDroppedFile(file) } else { selectDroppedFiles(files) }
        }
    }
}

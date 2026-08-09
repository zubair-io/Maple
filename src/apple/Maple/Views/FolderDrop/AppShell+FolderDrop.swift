// AppShell+FolderDrop.swift — accept OS file/folder drops onto the app
// window and mount them the same way "Open" does (#2649).
//
// Scope: macOS + iPadOS only (the `.dropDestination(for: URL.self, …)`
// modifier is wired onto `paneShellWithLayout` in `AppShell.swift`, which
// iPhone's `phoneTabShell` never renders — see `MapleShellKind`).
//
// All ROUTING logic (which of the four ticket cases a drop is) lives in
// `MapleCore`'s `DropMountPlanner` — pure, unit-tested, no I/O. This file
// is the thin SwiftUI-facing layer that:
//   • gathers the "already mounted" root set from live `AppShell` state
//     (`activeScopeURL`/`currentRootBookmark`) + `SavedFolderStore`
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
    /// Entry point for `.dropDestination(for: URL.self, action:)` on
    /// `paneShellWithLayout`. Returns whether the drop was accepted — SwiftUI
    /// plays the "reject" animation when `false`, so an empty/garbage drop
    /// (e.g. a plain-text drag that happened to resolve zero URLs) declines
    /// rather than silently no-opping with no feedback at all.
    func handleWindowDrop(_ urls: [URL]) -> Bool {
        guard !urls.isEmpty else { return false }
        let plan = DropMountPlanner.plan(for: urls, mountedRoots: mountedDropRoots())
        switch plan {
        case .unsupported(let extensions):
            browseVM.loadError = FileOperationError.unsupportedDropType(extensions)
        case .mountFolder(let folder):
            loadFolder(url: folder)
        case .openFile(let file, let parentFolder):
            loadFolder(url: parentFolder)
            openDroppedFile(file)
        case .mountAndSelect(let parentFolder, let files):
            loadFolder(url: parentFolder)
            selectDroppedFiles(files)
        case .navigateExisting(let root, let items):
            navigateExistingMount(root: root, droppedItems: items)
        }
        return true
    }

    // MARK: - Mounted-root detection

    /// Every local-folder root the app already knows about: the currently
    /// active browse root (if the current selection is a filesystem folder)
    /// plus every folder in the recents list. A drop under any of these is
    /// "already inside a mounted source" per the ticket — navigate, don't
    /// remount, don't mint a new bookmark.
    private func mountedDropRoots() -> [URL] {
        var roots: [URL] = []
        if case .folder = librarySelection, let activeScopeURL {
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
    /// would make an otherwise-identical root compare unequal.
    private func bookmarkForMountedRoot(_ root: URL) -> Data? {
        if let activeScopeURL, activeScopeURL.path == root.path {
            return currentRootBookmark
        }
        return SavedFolderStore.load()
            .first { $0.path == root.path }?
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
    /// files" selects them in place.
    private func navigateExistingMount(root: URL, droppedItems: [URL]) {
        guard let bookmark = bookmarkForMountedRoot(root) else {
            // Root disappeared between detection and here — fall back to a
            // fresh mount rather than silently dropping the gesture.
            handleWindowDrop(droppedItems)
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
        // Plain `.path` — matches how `loadFolder`/`openSubFolder` stamp
        // `librarySelection` (a bare `url.path`, never standardized).
        let alreadyShowing = librarySelection == .folder(path: folder.path)
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

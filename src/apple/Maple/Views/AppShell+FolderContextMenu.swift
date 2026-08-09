// AppShell+FolderContextMenu.swift — New Folder / Rename / Move to Trash
// action methods behind the source-tree right-click context menu (#2645).
//
// Wires the sidebar's local (`FolderTreeRow`), SMB (share row), and Cloud
// (`CloudFolderTreeRow`) context-menu actions to the already-merged
// `MapleCore` folder-CRUD engines (`LocalFileOperations+Folders`,
// `+Trash`, `SMBFileOperations+Folders`) and to `RemoteCatalog`'s
// `makeDir`/`moveFolder` (Cloud). This file is UI wiring only — every
// actual filesystem/network operation lives in `MapleCore` or
// `MapleCloudKit`, per the ticket's scope note.
//
// Cloud folder TRASH (#2696) — `POST /api/folders/:id/trash-folder`
// (#2630/#2695) recursively trashes every live asset under the subfolder;
// `trashCloudFolder` below wires `CloudFolderTreeRow`'s "Move to Trash"
// item to it via `RemoteCatalog.trashFolder`.
//
// SMB folder Rename/Trash are also not wired: `SMBSource` enumerates the
// whole share recursively (`images()`) rather than exposing a per-directory
// listing, so the sidebar has no SMB subfolder tree to attach a row-level
// Rename/Trash action to — only the share-root "New Folder" action has a
// target. #2697 tracks building that subfolder tree (SMB directory
// browsing), which is its own ticket, not a context-menu wiring change.

import SwiftUI
import MapleCore

@MainActor
extension AppShell {

    // MARK: - Local Filesystem

    /// Create `name` inside `parentURL`. `rootBookmark` is the nearest saved
    /// ancestor's security-scope bookmark (same value `FolderTreeRow` already
    /// threads to every depth for enumeration).
    func createLocalFolder(name: String, in parentURL: URL, rootBookmark: Data) {
        withLocalFolderScope(rootBookmark) { _ in
            _ = try LocalFileOperations.createFolder(named: name, in: parentURL)
        }
    }

    /// Rename `folderURL` in place. Updates `SavedFolderStore` when the
    /// renamed folder is itself a top-level saved folder (its `id` — the
    /// path — no longer matches after the move, so a plain in-place edit
    /// isn't possible; the old entry is dropped and a fresh one inserted
    /// with a freshly-minted bookmark for the new path).
    func renameLocalFolder(_ folderURL: URL, to newName: String, rootBookmark: Data) {
        withLocalFolderScope(rootBookmark) { root in
            let renamed = try LocalFileOperations.renameFolder(folderURL, to: newName)
            reconcileSavedFolder(oldPath: folderURL.path, newURL: renamed, root: root)
            if librarySelection == .folder(path: folderURL.path) {
                librarySelection = .folder(path: renamed.path)
                libraryTitle = renamed.lastPathComponent
            } else if let descendantSuffix = selectionPath(under: folderURL) {
                // The grid was showing a DESCENDANT of the renamed folder
                // (review finding, jules) — an exact-path check alone misses
                // this, leaving `librarySelection` pointing at a path that
                // no longer exists once the ancestor moved. Rewrite it onto
                // the same relative descendant under the new location.
                let newDescendant = renamed.appendingPathComponent(descendantSuffix)
                librarySelection = .folder(path: newDescendant.path)
            }
        }
    }

    /// Move `folderURL` to Trash — the real OS Trash on macOS, `.maple/trash`
    /// on iOS/iPadOS (see `LocalFileOperations.deleteFolder`'s `#if os`
    /// split). Recursive: the whole subtree moves as one directory move.
    func trashLocalFolder(_ folderURL: URL, rootBookmark: Data) {
        withLocalFolderScope(rootBookmark) { root in
            _ = try LocalFileOperations.deleteFolder(folderURL, libraryRoot: root)
            if SavedFolderStore.load().contains(where: { $0.path == folderURL.path }) {
                SavedFolderStore.remove(path: folderURL.path)
            }
            // Trashing the exact selected folder, OR any of its ancestors
            // (review finding, jules — the exact-path check alone left a
            // descendant selection dangling on a now-deleted path), leaves
            // nothing left to show. Fall back to the same cold-start pick
            // the app uses when a saved selection turns out to be gone.
            if librarySelection == .folder(path: folderURL.path) || selectionPath(under: folderURL) != nil {
                Task { @MainActor in await autoPickInitialSource() }
            }
        }
    }

    /// If `librarySelection` is a folder strictly inside `ancestorURL`,
    /// returns its path relative to `ancestorURL` (e.g. selection
    /// `/A/B/C`, `ancestorURL` `/A` → `"B/C"`). `nil` when the selection
    /// isn't a folder, or isn't under `ancestorURL` at all.
    private func selectionPath(under ancestorURL: URL) -> String? {
        guard case .folder(let selectedPath) = librarySelection, selectedPath != ancestorURL.path else {
            return nil
        }
        let prefix = ancestorURL.path.hasSuffix("/") ? ancestorURL.path : ancestorURL.path + "/"
        guard selectedPath.hasPrefix(prefix) else { return nil }
        return String(selectedPath.dropFirst(prefix.count))
    }

    /// Resolves `rootBookmark`, claims security scope for the duration of
    /// `body`, runs it, releases scope, and bumps `folderRefreshGeneration`
    /// on success so the sidebar re-enumerates. Errors surface through the
    /// same `browseVM.loadError` banner the rest of the shell uses.
    private func withLocalFolderScope(_ rootBookmark: Data, _ body: (URL) throws -> Void) {
        var isStale = false
        #if os(macOS)
        let root = try? URL(resolvingBookmarkData: rootBookmark, options: .withSecurityScope,
                            relativeTo: nil, bookmarkDataIsStale: &isStale)
        #else
        let root = try? URL(resolvingBookmarkData: rootBookmark, options: [],
                            relativeTo: nil, bookmarkDataIsStale: &isStale)
        #endif
        guard let root else {
            browseVM.loadError = FileOperationError.sourceMissing("folder's saved bookmark could not be resolved")
            return
        }
        let accessing = root.startAccessingSecurityScopedResource()
        defer { if accessing { root.stopAccessingSecurityScopedResource() } }
        do {
            try body(root)
            folderRefreshGeneration += 1
        } catch {
            browseVM.loadError = error
        }
    }

    /// Drop the saved entry at `oldPath` and, if it was a top-level saved
    /// folder, insert a fresh one at `newURL` with a newly-minted bookmark
    /// (the old bookmark is bound to the old path and won't resolve).
    /// No-op for a descendant rename — only top-level folders live in
    /// `SavedFolderStore`.
    private func reconcileSavedFolder(oldPath: String, newURL: URL, root: URL) {
        guard let existing = SavedFolderStore.load().first(where: { $0.path == oldPath }) else { return }
        #if os(macOS)
        let bookmark = try? newURL.bookmarkData(options: .withSecurityScope,
                                                includingResourceValuesForKeys: nil, relativeTo: nil)
        #else
        let bookmark = try? newURL.bookmarkData(includingResourceValuesForKeys: nil, relativeTo: nil)
        #endif
        // Bail BEFORE removing the old entry (review finding, jules): if
        // minting a bookmark for the renamed URL fails, the old entry must
        // stay in place rather than the folder silently vanishing from the
        // sidebar. Better a stale path than a dropped folder.
        guard let bookmark else { return }
        SavedFolderStore.remove(path: oldPath)
        SavedFolderStore.upsert(SavedFolder(
            path: newURL.path,
            displayName: newURL.lastPathComponent,
            bookmark: bookmark,
            lastOpened: existing.lastOpened
        ))
    }

    // MARK: - SMB

    /// New Folder at the connected share's root. The sidebar's SMB rows are
    /// flat (no subfolder tree, see file header), so this is the only SMB
    /// folder action with a target today.
    func createSMBFolder(name: String, share: SMBCredentialStore.SavedShare) {
        Task { @MainActor in
            guard let creds = await SMBCredentialStore.shared.credentials(for: share) else {
                browseVM.loadError = FileOperationError.sourceMissing(
                    "SMB credentials for \(share.host)/\(share.share) — reconnect from the sidebar first")
                return
            }
            do {
                _ = try await SMBSource.createFolderAtShareRoot(name: name, credentials: creds)
                folderRefreshGeneration += 1
                // If this share is the one currently open, refresh the grid
                // so the new folder is visible without a manual reconnect —
                // the SMB source itself has no change-watcher to pick it up.
                if case .smbShare(let current) = librarySelection, current == share {
                    connectSavedSMB(share)
                }
            } catch {
                browseVM.loadError = error
            }
        }
    }

    // MARK: - Cloud

    /// `POST /api/folders/<id>/mkdir` via `RemoteCatalog`. `parentAbsPath` and
    /// `libraryRootPath` are both server-absolute; the relative path the API
    /// expects is derived by stripping the library root prefix.
    func createCloudFolder(server: URL, libraryFolderID: String, libraryRootPath: String,
                           parentAbsPath: String, name: String) {
        // The UI already disables Create for an invalid name; re-checked
        // here (#2645 review) as defense in depth — `RemoteCatalog.makeDir`
        // is shared with the FileProvider extension, which sources its
        // names from the OS (already validated), so it doesn't itself
        // enforce `FilenameValidation`'s rules.
        guard FilenameValidation.isValidFolderName(name) else {
            browseVM.loadError = FileOperationError.invalidName(name)
            return
        }
        let targetAbsPath = (parentAbsPath as NSString).appendingPathComponent(name)
        guard let relative = cloudRelativePath(targetAbsPath, under: libraryRootPath) else {
            browseVM.loadError = FileOperationError.invalidDestination(
                "\(targetAbsPath) is not under library root \(libraryRootPath)")
            return
        }
        Task { @MainActor in
            let catalog = RemoteCatalog(http: makeAuthenticatedHTTPClient(server: server), server: server)
            do {
                _ = try await catalog.makeDir(folderID: libraryFolderID, targetRelativePath: relative)
                folderRefreshGeneration += 1
            } catch {
                browseVM.loadError = error
            }
        }
    }

    /// `POST /api/folders/<id>/move` via `RemoteCatalog`, source and target
    /// both computed relative to `libraryRootPath`.
    func renameCloudFolder(server: URL, libraryFolderID: String, libraryRootPath: String,
                           absPath: String, newName: String) {
        guard FilenameValidation.isValidFolderName(newName) else {
            browseVM.loadError = FileOperationError.invalidName(newName)
            return
        }
        // Component join, not string-appending (#2645 review): the prior
        // `.deletingLastPathComponent.appending("/\(newName)")` could form a
        // double slash if the parent path already ended in one.
        let parentAbsPath = (absPath as NSString).deletingLastPathComponent
        let targetAbsPath = (parentAbsPath as NSString).appendingPathComponent(newName)
        guard let sourceRel = cloudRelativePath(absPath, under: libraryRootPath),
              let targetRel = cloudRelativePath(targetAbsPath, under: libraryRootPath) else {
            browseVM.loadError = FileOperationError.invalidDestination(
                "\(absPath) is not under library root \(libraryRootPath)")
            return
        }
        Task { @MainActor in
            let catalog = RemoteCatalog(http: makeAuthenticatedHTTPClient(server: server), server: server)
            do {
                let result = try await catalog.moveFolder(
                    folderID: libraryFolderID, sourceRelativePath: sourceRel, targetRelativePath: targetRel)
                switch result {
                case .ok:
                    folderRefreshGeneration += 1
                case .conflict:
                    browseVM.loadError = FileOperationError.destinationExists(targetAbsPath)
                }
            } catch {
                browseVM.loadError = error
            }
        }
    }

    /// `POST /api/folders/<id>/trash-folder` via `RemoteCatalog` (#2696).
    /// Recursive — every asset under `absPath` is trashed server-side.
    /// Partial failure (some assets trashed, others not) surfaces as a
    /// single error banner naming the failure count rather than a per-item
    /// report: unlike the grid's multi-select trash, a folder trash has no
    /// natural "list of items" the user picked one-by-one to show outcomes
    /// against.
    func trashCloudFolder(server: URL, libraryFolderID: String, libraryRootPath: String, absPath: String) {
        guard let relative = cloudRelativePath(absPath, under: libraryRootPath), !relative.isEmpty else {
            browseVM.loadError = FileOperationError.invalidDestination(
                "\(absPath) is not under library root \(libraryRootPath)")
            return
        }
        Task { @MainActor in
            // `makeCloudTrashClient` (`AppShell+Trash.swift`) — routes
            // through `LocalNetworkResolver.shared.effectiveURL(for:)` so a
            // server reachable on the local network doesn't take the WAN
            // path (review finding, jules: a raw `RemoteCatalog(server:
            // server)` construction here skipped that entirely).
            let catalog = makeCloudTrashClient(server: server)
            do {
                let summary = try await catalog.trashFolder(folderID: libraryFolderID, relativePath: relative)
                folderRefreshGeneration += 1
                if summary.failed > 0 {
                    browseVM.loadError = FileOperationError.underlying(
                        "\(summary.failed) of \(summary.total) items in this folder could not be trashed")
                }
            } catch {
                browseVM.loadError = error
            }
        }
    }

    /// Strips `libraryRootPath` off the front of `absPath`, POSIX-style.
    /// Returns `nil` when `absPath` isn't actually under the root (shouldn't
    /// happen given the sidebar only ever passes paths from its own tree,
    /// but the API rejects `..`/leading-`/` the same way `encodeTargetPath`
    /// does, so this fails closed rather than sending a malformed request).
    /// Not `private`: `AppShell+AssetDrop.swift` (#2646) reuses this same
    /// abs-path → library-relative-path derivation for the Cloud drop
    /// target's `destination_path`.
    func cloudRelativePath(_ absPath: String, under libraryRootPath: String) -> String? {
        let root = libraryRootPath.hasSuffix("/") ? String(libraryRootPath.dropLast()) : libraryRootPath
        guard absPath == root || absPath.hasPrefix(root + "/") else { return nil }
        guard absPath != root else { return "" }
        return String(absPath.dropFirst(root.count + 1))
    }
}

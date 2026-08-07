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
// Cloud folder TRASH is deliberately NOT wired here: the API has no
// folder-level trash route today (only per-asset `DELETE /api/assets/<id>`,
// per the design doc's "Delete → Trash → Restore" section — folder-level
// trash for Web/API is called out there as still-needed work, not
// something this Apple ticket can route to). The sidebar surfaces this as
// a disabled context-menu item with an explanation rather than a silent
// omission — see `CloudFolderTreeRow`'s "Move to Trash" button.
//
// SMB folder Rename/Trash are also not wired: `SMBSource` enumerates the
// whole share recursively (`images()`) rather than exposing a per-directory
// listing, so the sidebar has no SMB subfolder tree to attach a row-level
// Rename/Trash action to — only the share-root "New Folder" action has a
// target. Building that subfolder tree is its own ticket (SMB directory
// browsing), not a context-menu wiring change.

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
            if librarySelection == .folder(path: folderURL.path) {
                Task { @MainActor in await autoPickInitialSource() }
            }
        }
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
        SavedFolderStore.remove(path: oldPath)
        #if os(macOS)
        let bookmark = try? newURL.bookmarkData(options: .withSecurityScope,
                                                includingResourceValuesForKeys: nil, relativeTo: nil)
        #else
        let bookmark = try? newURL.bookmarkData(includingResourceValuesForKeys: nil, relativeTo: nil)
        #endif
        guard let bookmark else { return }
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
        let targetAbsPath = (absPath as NSString).deletingLastPathComponent.appending("/\(newName)")
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

    /// Strips `libraryRootPath` off the front of `absPath`, POSIX-style.
    /// Returns `nil` when `absPath` isn't actually under the root (shouldn't
    /// happen given the sidebar only ever passes paths from its own tree,
    /// but the API rejects `..`/leading-`/` the same way `encodeTargetPath`
    /// does, so this fails closed rather than sending a malformed request).
    private func cloudRelativePath(_ absPath: String, under libraryRootPath: String) -> String? {
        let root = libraryRootPath.hasSuffix("/") ? String(libraryRootPath.dropLast()) : libraryRootPath
        guard absPath == root || absPath.hasPrefix(root + "/") else { return nil }
        guard absPath != root else { return "" }
        return String(absPath.dropFirst(root.count + 1))
    }
}

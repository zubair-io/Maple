// AppShell+FolderMove.swift — "Move Folder to…" for local and SMB folder
// rows (#2847). Both engines' `moveFolder` (`LocalFileOperations+Folders`,
// `SMBFileOperations+Folders`) were merged and tested with no UI entry
// point — the sidebar only ever reached `renameFolder`. This is the
// wiring: build the destination tree (`FolderMoveDestinations`) behind
// `FolderMoveVM`'s spinner phase (`FolderMove+VM.swift`), present Maple
// UI's Move To Modal (`FolderMoveSheets.swift`), run the engine, and
// repoint whatever the grid was showing — the same shape
// `AppShell+FolderContextMenu.swift`'s rename path uses, plus a real
// reload when the moved subtree is what's on screen (its asset URLs are
// dead the moment the directory moves).
//
// Cloud folders are deliberately not wired here: `RemoteCatalog.moveFolder`
// does accept an arbitrary target path, but the Cloud tree is only ever
// listed lazily one directory at a time (`onListCloudDir`), and the picker
// needs the whole tree up front — a separate ticket.

import SwiftUI
import MapleCore

@MainActor
extension AppShell {

    // MARK: - Present the picker

    /// Local: the destination tree is every folder under the row's saved
    /// root (the bookmark's scope covers the whole subtree), minus the
    /// moving folder's own subtree. `folderMove.begin` flips the overlay
    /// to its spinner sheet before the walk starts and ignores a second
    /// click while one is running; the walk itself runs off the main
    /// actor (`walkLocalTree`) inside a scope claim on the resolved root.
    func beginLocalFolderMove(_ folderURL: URL, rootBookmark: Data) {
        guard let root = resolveFolderBookmark(rootBookmark) else { return }
        folderMove.begin(.local(folderURL: folderURL, rootBookmark: rootBookmark)) {
            await Self.walkLocalTree(root: root, excluding: folderURL)
        }
    }

    /// The local walk on a detached task — a large library is a deep
    /// directory tree — wired to the caller's cancellation so the sheet's
    /// Cancel stops it at the next directory (`FolderMoveDestinations`
    /// checks `Task.isCancelled` per level) instead of finishing a listing
    /// nobody will see.
    private static func walkLocalTree(root: URL, excluding folderURL: URL) async -> [FolderMoveDestination] {
        let walk = Task.detached(priority: .userInitiated) { () -> [FolderMoveDestination] in
            let accessing = root.startAccessingSecurityScopedResource()
            defer { if accessing { root.stopAccessingSecurityScopedResource() } }
            return FolderMoveDestinations.localTree(
                root: root, rootName: root.lastPathComponent, excluding: folderURL)
        }
        return await withTaskCancellationHandler {
            await walk.value
        } onCancel: {
            walk.cancel()
        }
    }

    /// SMB: the whole share's folder tree over one throwaway connection
    /// (`SMBSource.folderTree`), reachable for any saved share — same
    /// reasoning `createSMBFolder` documents. One network round trip per
    /// directory, which is exactly why the spinner sheet exists; a
    /// dismissed sheet cancels the walk at the next directory.
    func beginSMBFolderMove(_ path: String, share: SMBCredentialStore.SavedShare) {
        folderMove.begin(.smb(share: share, path: path)) {
            guard let creds = await SMBCredentialStore.shared.credentials(for: share) else {
                throw FileOperationError.sourceMissing(
                    "SMB credentials for \(share.host)/\(share.share) — reconnect from the sidebar first")
            }
            return try await SMBSource.folderTree(
                rootName: "\(share.host) / \(share.share)", excluding: path, credentials: creds)
        } onFailure: { error in
            browseVM.loadError = error
        }
    }

    // MARK: - Confirm

    /// The picker's "Move" — `destinationID` is the chosen node's id, i.e.
    /// the new parent directory in the engine's own addressing.
    func confirmFolderMove(_ prompt: FolderMovePrompt, destinationID: String) {
        switch prompt.target {
        case .local(let folderURL, let rootBookmark):
            moveLocalFolder(folderURL, into: URL(fileURLWithPath: destinationID), rootBookmark: rootBookmark)
        case .smb(let share, let path):
            moveSMBFolder(path, into: destinationID, share: share)
        }
    }

    /// Picking the folder's CURRENT parent is a no-op the engine would
    /// also answer with "already there" — skip the scope claim entirely.
    /// Otherwise: engine move, then repoint the grid if it was showing the
    /// moved folder or anything inside it — `openSubFolder` reloads at the
    /// new path (and reconfigures the per-folder thumb/preview caches for
    /// it), which is what makes the moved photos browsable again.
    /// `withLocalFolderScope` bumps `folderRefreshGeneration` on success
    /// so both the old and new parent rows re-enumerate.
    func moveLocalFolder(_ folderURL: URL, into destination: URL, rootBookmark: Data) {
        let currentParent = folderURL.deletingLastPathComponent().standardizedFileURL.path
        guard destination.standardizedFileURL.path != currentParent else { return }
        withLocalFolderScope(rootBookmark) { _ in
            let moved = try LocalFileOperations.moveFolder(folderURL, into: destination)
            if librarySelection == .folder(path: folderURL.path) {
                openSubFolder(url: moved, rootBookmark: rootBookmark)
            } else if let descendantSuffix = selectionPath(under: folderURL) {
                openSubFolder(url: moved.appendingPathComponent(descendantSuffix), rootBookmark: rootBookmark)
            }
        }
    }

    /// SMB twin — same post-move refresh `renameSMBFolder` performs: bump
    /// the tree and, if this share is the one open in the grid, reconnect
    /// so the grid's recursive listing reflects the new layout (the SMB
    /// source has no change-watcher of its own).
    func moveSMBFolder(_ path: String, into destination: String, share: SMBCredentialStore.SavedShare) {
        guard destination != (path as NSString).deletingLastPathComponent else { return }
        Task { @MainActor in
            guard let creds = await SMBCredentialStore.shared.credentials(for: share) else {
                browseVM.loadError = FileOperationError.sourceMissing(
                    "SMB credentials for \(share.host)/\(share.share) — reconnect from the sidebar first")
                return
            }
            do {
                _ = try await SMBSource.moveFolder(path, into: destination, credentials: creds)
                folderRefreshGeneration += 1
                if case .smbShare(let current) = librarySelection, current == share {
                    connectSavedSMB(share)
                }
            } catch {
                browseVM.loadError = error
            }
        }
    }
}

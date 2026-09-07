// FolderMoveDestinations.swift — the candidate-destination tree behind the
// sidebar's "Move Folder to…" context-menu item (#2847). Both engines'
// `moveFolder` (`LocalFileOperations+Folders`, `SMBFileOperations+Folders`)
// were merged and tested with no UI entry point; this is the read-only half
// the picker needs — a flat, pre-order list of every folder the moving
// folder could legally land in, shaped for Maple UI's Move To Modal (a flat
// node list with `parentID`/`depth`/`hasChildren`, expansion resolved by the
// modal itself).
//
// Pure listing, no I/O beyond directory reads — the actual move stays with
// the engines. Two rules both walks share:
//   • dot-prefixed directories are skipped — `.maple` above all (it is
//     derivative cache + trash, never a destination; see
//     `MapleSidecarPaths.derivativeDirectoryName`), same filter the sidebar
//     trees and `SMBFileOperations.listSubdirectories` already apply.
//   • the moving folder's OWN subtree is skipped — a folder can't move into
//     itself or a descendant (the engines refuse it; the picker simply
//     never offers it).

import Foundation

/// One row of the destination tree. `id` is the absolute path (local) or
/// share-relative path (SMB) — exactly what the matching engine's
/// `moveFolder(_:into:)` takes as the new parent.
public struct FolderMoveDestination: Sendable, Hashable, Identifiable {
    public let id: String
    public let parentID: String?
    public let name: String
    public let depth: Int
    public let hasChildren: Bool

    public init(id: String, parentID: String?, name: String, depth: Int, hasChildren: Bool) {
        self.id = id
        self.parentID = parentID
        self.name = name
        self.depth = depth
        self.hasChildren = hasChildren
    }
}

public enum FolderMoveDestinations {

    // MARK: - Local Filesystem

    /// Every directory under `root` (root included, at depth 0, shown as
    /// `rootName`), pre-order and name-sorted, minus dot-directories and
    /// `excluding`'s whole subtree. The caller holds security scope on
    /// `root` for the duration — this reads directories at every depth.
    public static func localTree(root: URL, rootName: String, excluding moving: URL) -> [FolderMoveDestination] {
        localSubtree(root, name: rootName, parentID: nil, depth: 0,
                     excludedPath: moving.standardizedFileURL.path)
    }

    private static func localSubtree(
        _ dir: URL, name: String, parentID: String?, depth: Int, excludedPath: String
    ) -> [FolderMoveDestination] {
        // The picker cancels the walk when the user dismisses its
        // "Finding folders…" sheet (`FolderMoveVM.cancel`); a large library
        // is a deep tree, so stop at the next directory rather than
        // finishing a listing nobody will see.
        guard !Task.isCancelled else { return [] }
        let id = dir.standardizedFileURL.path
        let children = localChildDirectories(of: dir)
            .filter { $0.standardizedFileURL.path != excludedPath }
        let node = FolderMoveDestination(
            id: id, parentID: parentID, name: name, depth: depth, hasChildren: !children.isEmpty)
        return [node] + children.flatMap {
            localSubtree($0, name: $0.lastPathComponent, parentID: id, depth: depth + 1,
                         excludedPath: excludedPath)
        }
    }

    /// Direct, visible subdirectories of `dir`, name-sorted — the same
    /// rule `FolderTreeRow.enumerateChildren` uses for the sidebar, so the
    /// picker and the tree agree on what a folder "contains."
    private static func localChildDirectories(of dir: URL) -> [URL] {
        let contents = (try? FileManager.default.contentsOfDirectory(
            at: dir, includingPropertiesForKeys: [.isDirectoryKey], options: [.skipsHiddenFiles])) ?? []
        return contents
            .filter {
                !$0.lastPathComponent.hasPrefix(".")
                    && (try? $0.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true
            }
            .sorted { $0.lastPathComponent < $1.lastPathComponent }
    }

    // MARK: - SMB

    /// SMB twin of `localTree`: the share root (`"/"`, shown as `rootName`)
    /// and every subfolder beneath it, walked one directory at a time
    /// through `SMBFileOperations.listSubdirectories` (which already drops
    /// dot-directories), minus `excluding`'s subtree.
    public static func smbTree(
        rootName: String, excluding moving: String, transport: SMBFileTransport
    ) async throws -> [FolderMoveDestination] {
        try await smbSubtree("/", name: rootName, parentID: nil, depth: 0, excludedPath: moving, transport: transport)
    }

    private static func smbSubtree(
        _ path: String, name: String, parentID: String?, depth: Int, excludedPath: String,
        transport: SMBFileTransport
    ) async throws -> [FolderMoveDestination] {
        // Same cancellation seam as `localSubtree` — one network round
        // trip per directory, so a dismissed picker stops the walk at the
        // next one instead of listing the whole share for nothing.
        try Task.checkCancellation()
        let children = try await SMBFileOperations.listSubdirectories(at: path, transport: transport)
            .filter { $0.path != excludedPath }
        let node = FolderMoveDestination(
            id: path, parentID: parentID, name: name, depth: depth, hasChildren: !children.isEmpty)
        var descendants: [FolderMoveDestination] = []
        for child in children {
            descendants += try await smbSubtree(
                child.path, name: child.name, parentID: path, depth: depth + 1,
                excludedPath: excludedPath, transport: transport)
        }
        return [node] + descendants
    }
}

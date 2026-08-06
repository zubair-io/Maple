// LocalFileOperations+Folders.swift — folder CRUD for the local Filesystem
// source (issue #2631). Unlike an asset relocate, a directory rename/move
// moves no file bytes — it's a single atomic filesystem-level rename, so
// none of these need the copy-verify-delete contract. Mirrors the API's
// `POST /:id/mkdir` / `POST /:id/move` (`src/api/src/routes/folders.ts`,
// both built on `fs.rename`) and FileProvider's `catalog.moveFolder` prior
// art (Cloud-routed, but the same semantics: rename/move only, self-subtree
// guard, no silent overwrite).

import Foundation

extension LocalFileOperations {

    /// Create `name` inside `parentDir`. Fails on collision rather than
    /// auto-suffixing — matches the API's `mkdir`, which 409s rather than
    /// silently picking a sibling name the user didn't ask for.
    public static func createFolder(named name: String, in parentDir: URL) throws -> URL {
        let target = parentDir.appendingPathComponent(name)
        guard !FileManager.default.fileExists(atPath: target.path) else {
            throw FileOperationError.destinationExists(target.path)
        }
        try FileManager.default.createDirectory(at: target, withIntermediateDirectories: true)
        return target
    }

    /// Rename `folderURL` in place.
    public static func renameFolder(_ folderURL: URL, to newName: String) throws -> URL {
        try moveFolder(folderURL, into: folderURL.deletingLastPathComponent(), newName: newName)
    }

    /// Move `folderURL` (optionally renaming it) into `newParentDir`.
    /// Refuses to move a folder into its own subtree (matches `folders.ts`'s
    /// self-subtree guard) and refuses to silently overwrite an existing
    /// item at the destination.
    public static func moveFolder(_ folderURL: URL, into newParentDir: URL,
                                   newName: String? = nil) throws -> URL {
        let name = newName ?? folderURL.lastPathComponent
        let sourcePath = folderURL.standardizedFileURL.path
        let targetParentPath = newParentDir.standardizedFileURL.path
        guard targetParentPath != sourcePath, !targetParentPath.hasPrefix(sourcePath + "/") else {
            throw FileOperationError.invalidDestination(
                "cannot move \(folderURL.path) into its own subtree \(newParentDir.path)")
        }
        let target = newParentDir.appendingPathComponent(name)
        guard target.standardizedFileURL.path != sourcePath else {
            return folderURL  // already there — a no-op rename-to-itself
        }
        guard !FileManager.default.fileExists(atPath: target.path) else {
            throw FileOperationError.destinationExists(target.path)
        }
        try FileManager.default.createDirectory(at: newParentDir, withIntermediateDirectories: true)
        try FileManager.default.moveItem(at: folderURL, to: target)
        return target
    }

    /// Recursively trash `folderURL` — the whole subtree moves as one unit
    /// (a directory move, not a per-file walk), which is exactly what
    /// "preserving relative structure so restore can reconstruct the tree"
    /// requires: nothing inside is touched individually.
    public static func deleteFolder(_ folderURL: URL, libraryRoot: URL) throws -> URL {
        #if os(macOS)
        var trashed: NSURL?
        try FileManager.default.trashItem(at: folderURL, resultingItemURL: &trashed)
        return (trashed as URL?) ?? folderURL
        #else
        return try trashFolderToMapleFolder(folderURL, libraryRoot: libraryRoot)
        #endif
    }

    /// `.maple/trash/<rel>` fallback for folder delete — iOS/iPadOS always;
    /// no `#if os` gate, so also directly testable on macOS.
    static func trashFolderToMapleFolder(_ folderURL: URL, libraryRoot: URL) throws -> URL {
        let trashParent = try trashDestinationDir(for: folderURL, libraryRoot: libraryRoot)
        try FileManager.default.createDirectory(at: trashParent, withIntermediateDirectories: true)
        // A directory move, not an asset relocate — the numeric-suffix
        // collision handling is inlined rather than routed through
        // `CollisionResolver`/`relocate`, which are sized for the
        // copy-verify-delete file contract this operation doesn't need.
        var target = trashParent.appendingPathComponent(folderURL.lastPathComponent)
        var suffix = 1
        while FileManager.default.fileExists(atPath: target.path) {
            target = trashParent.appendingPathComponent("\(folderURL.lastPathComponent).\(suffix)")
            suffix += 1
        }
        try FileManager.default.moveItem(at: folderURL, to: target)
        return target
    }
}

// SMBFileOperations+Folders.swift — folder CRUD for the SMB source (issue
// #2631). A directory rename/move is a single server-side rename — no file
// bytes move — so, like the local engine, none of these need the
// copy-verify-delete contract.

import Foundation

extension SMBFileOperations {

    /// Create `name` inside `parentDir`. Fails on collision rather than
    /// auto-suffixing, matching the API's `mkdir`.
    public static func createFolder(named name: String, in parentDir: String,
                                    transport: SMBFileTransport) async throws -> String {
        guard FilenameValidation.isValidPathComponent(name) else {
            throw FileOperationError.invalidName(name)
        }
        let target = posixJoin(parentDir, name)
        guard await !exists(target, transport: transport) else {
            throw FileOperationError.destinationExists(target)
        }
        try await transport.createDirectory(atPath: target)
        return target
    }

    /// Rename `folderPath` in place.
    public static func renameFolder(_ folderPath: String, to newName: String,
                                    transport: SMBFileTransport) async throws -> String {
        try await moveFolder(folderPath, into: (folderPath as NSString).deletingLastPathComponent,
                             newName: newName, transport: transport)
    }

    /// Move `folderPath` (optionally renaming it) into `newParentDir`.
    /// Refuses to move a folder into its own subtree and refuses to
    /// silently overwrite an existing item at the destination.
    public static func moveFolder(_ folderPath: String, into newParentDir: String,
                                  newName: String? = nil,
                                  transport: SMBFileTransport) async throws -> String {
        if let newName, !FilenameValidation.isValidPathComponent(newName) {
            throw FileOperationError.invalidName(newName)
        }
        let name = newName ?? posixLastComponent(folderPath)
        guard newParentDir != folderPath, !newParentDir.hasPrefix(folderPath + "/") else {
            throw FileOperationError.invalidDestination(
                "cannot move \(folderPath) into its own subtree \(newParentDir)")
        }
        let target = posixJoin(newParentDir, name)
        guard target != folderPath else { return folderPath }  // no-op rename-to-itself
        guard await !exists(target, transport: transport) else {
            throw FileOperationError.destinationExists(target)
        }
        try? await transport.createDirectory(atPath: newParentDir)
        try await transport.moveItem(atPath: folderPath, toPath: target)
        return target
    }

    /// Recursively trash `folderPath` into `.maple/trash/<rel>` — the whole
    /// subtree moves as one server-side rename, preserving relative
    /// structure so restore can reconstruct the tree.
    public static func deleteFolder(_ folderPath: String, shareRoot: String = "/",
                                    transport: SMBFileTransport) async throws -> String {
        let trashParent = try trashDestinationDir(for: folderPath, shareRoot: shareRoot)
        try? await transport.createDirectory(atPath: trashParent)
        let base = posixLastComponent(folderPath)
        var target = posixJoin(trashParent, base)
        var suffix = 1
        while await exists(target, transport: transport) {
            target = posixJoin(trashParent, "\(base).\(suffix)")
            suffix += 1
        }
        try await transport.moveItem(atPath: folderPath, toPath: target)
        // #2945: without this, every photo trashed via Delete Folder is
        // permanently exempt from the 30-day auto-purge — see
        // `writeTrashedMarkers`'s doc comment for why the marker is
        // per-contained-photo rather than per-folder-root.
        await writeTrashedMarkers(forSubtreeAt: target, transport: transport)
        return target
    }
}

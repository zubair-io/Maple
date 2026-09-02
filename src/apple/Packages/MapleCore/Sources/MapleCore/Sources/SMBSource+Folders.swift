// SMBSource+Folders.swift — folder CRUD for the SMB source (file-budget
// split out of SMBSource.swift, #2697).
//
// Two shapes:
//   - `createFolder(named:in:)` (instance) — runs over the currently-open
//     connection, same as every other instance method on this actor.
//   - The `static` operations below — `createFolderAtShareRoot`,
//     `createFolder(named:in:credentials:)`, `listSubdirectories`,
//     `renameFolder`, `trashFolder` — each open a THROWAWAY connection via
//     `withThrowawayConnection`, because the sidebar's SMB tree (#2697,
//     `SMBFolderTreeRow`) must be browsable and actionable for any SAVED
//     share, not only the one the app currently has open for browsing.

import Foundation
import AMSMB2

extension SMBSource {

    /// Create `name` inside the currently-connected share, at `parentPath`
    /// (share-relative, defaults to the share root). Used by the sidebar's
    /// "New Folder" context-menu action on an already-open SMB share (#2645)
    /// — routes through `SMBFileOperations.createFolder`, the same
    /// collision/error contract as the local Filesystem source.
    public func createFolder(named name: String, in parentPath: String = "/") async throws -> String {
        guard let client else { throw SMBError.notConnected }
        return try await SMBFileOperations.createFolder(named: name, in: parentPath, transport: client)
    }

    /// One-shot "New Folder" for an SMB share the app does NOT currently
    /// have open (the sidebar lists every saved share, not just the active
    /// one). Opens a throwaway connection scoped to this single mkdir — no
    /// recursive asset listing, unlike `connect(credentials:remotePath:)` —
    /// and tears it down again immediately after.
    public static func createFolderAtShareRoot(name: String, credentials: Credentials) async throws -> String {
        try await createFolder(named: name, in: "/", credentials: credentials)
    }

    /// New Folder inside an arbitrary `parentPath` (#2697) — the subfolder
    /// counterpart to `createFolderAtShareRoot` above, which is just this
    /// with `parentPath` fixed at `"/"`.
    public static func createFolder(
        named name: String, in parentPath: String, credentials: Credentials
    ) async throws -> String {
        try await withThrowawayConnection(credentials: credentials) { mgr in
            try await SMBFileOperations.createFolder(named: name, in: parentPath, transport: mgr)
        }
    }

    /// Non-recursive subfolder listing for the sidebar's SMB tree (#2697),
    /// via the same throwaway-connection pattern as `createFolderAtShareRoot`
    /// — the sidebar tree is browsable for any saved share, not only the
    /// one the app currently has open for browsing.
    public static func listSubdirectories(
        at path: String, credentials: Credentials
    ) async throws -> [SMBFileOperations.DirEntry] {
        try await withThrowawayConnection(credentials: credentials) { mgr in
            try await SMBFileOperations.listSubdirectories(at: path, transport: mgr)
        }
    }

    /// Rename a subfolder in place (#2697) — the folder-level counterpart
    /// to `renameAsset`, reachable for any saved share via a throwaway
    /// connection rather than requiring the share to already be open.
    public static func renameFolder(
        _ path: String, to newName: String, credentials: Credentials
    ) async throws -> String {
        try await withThrowawayConnection(credentials: credentials) { mgr in
            try await SMBFileOperations.renameFolder(path, to: newName, transport: mgr)
        }
    }

    /// Recursively move a subfolder into `.maple/trash` (#2697) — the
    /// folder-level counterpart to `trashAsset`, same throwaway-connection
    /// shape as `renameFolder` above.
    public static func trashFolder(_ path: String, credentials: Credentials) async throws -> String {
        try await withThrowawayConnection(credentials: credentials) { mgr in
            try await SMBFileOperations.deleteFolder(path, transport: mgr)
        }
    }

    /// Shared throwaway-connection shape for one-shot folder operations
    /// against a share the app may not currently have open: connect, run
    /// `body`, disconnect — success or failure — and propagate `body`'s
    /// result or error. Extracted from `createFolderAtShareRoot` (#2697)
    /// once a second and third caller (`listSubdirectories`, `renameFolder`,
    /// `trashFolder`) needed the identical connect/disconnect wrapping.
    static func withThrowawayConnection<T: Sendable>(
        credentials: Credentials, _ body: @Sendable (SMB2Manager) async throws -> T
    ) async throws -> T {
        guard let serverURL = URL(string: "smb://\(credentials.host)") else {
            throw SMBError.invalidServerURL(credentials.host)
        }
        let cred = URLCredential(
            user: credentials.username,
            password: credentials.password,
            persistence: .forSession
        )
        guard let mgr = SMB2Manager(url: serverURL, credential: cred) else {
            throw SMBError.invalidServerURL(credentials.host)
        }
        try await mgr.connectShare(name: credentials.share)
        do {
            let result = try await body(mgr)
            try? await mgr.disconnectShare(gracefully: false)
            return result
        } catch {
            try? await mgr.disconnectShare(gracefully: false)
            throw error
        }
    }
}

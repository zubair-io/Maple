// SMBFileOperations+Trash.swift — Delete → Trash for the SMB source (issue
// #2631). SMB shares mediated through AMSMB2 have no OS-trash concept to
// call into (unlike a Finder-mounted local volume), so — per the design
// doc — SMB always uses `.maple/trash/<rel>` regardless of platform, via
// the same relocate primitive every other SMB move here uses.

import Foundation

extension SMBFileOperations {

    /// Trash a single asset (primary + sidecar) into
    /// `<shareRoot>/.maple/trash/<rel>`.
    public static func trash(_ primaryPath: String, shareRoot: String = "/",
                             transport: SMBFileTransport) async throws -> RelocateOutcome {
        let trashDir = try trashDestinationDir(for: primaryPath, shareRoot: shareRoot)
        return try await relocate(primaryPath, to: trashDir, mode: .move, collision: .autoSuffix, transport: transport)
    }

    /// `<shareRoot>/.maple/trash/<relative-parent-directory>` — the SMB
    /// counterpart of `LocalFileOperations.trashDestinationDir`, mirroring
    /// the same API convention (`computeTrashPath` in
    /// `src/api/src/fs/trash.ts`). Works for a file or a folder: only the
    /// PARENT directory of `item` matters.
    static func trashDestinationDir(for item: String, shareRoot: String) throws -> String {
        let root = normalizedPosixDir(shareRoot)
        let parent = normalizedPosixDir((item as NSString).deletingLastPathComponent)
        let rootPrefix = root == "/" ? "/" : root + "/"
        guard parent == root || parent.hasPrefix(rootPrefix) else {
            throw FileOperationError.invalidDestination("\(item) is not under share root \(shareRoot)")
        }
        let trashRoot = posixJoin(root, ".maple/trash")
        guard parent != root else { return trashRoot }
        let relSuffix = root == "/" ? String(parent.dropFirst()) : String(parent.dropFirst(root.count + 1))
        return posixJoin(trashRoot, relSuffix)
    }

    /// Strips a trailing slash except for the bare root itself, so prefix
    /// comparisons (`hasPrefix(root + "/")`) don't get thrown off by an
    /// inconsistently-slashed caller-supplied root.
    static func normalizedPosixDir(_ path: String) -> String {
        guard path.count > 1, path.hasSuffix("/") else { return path }
        return String(path.dropLast())
    }
}

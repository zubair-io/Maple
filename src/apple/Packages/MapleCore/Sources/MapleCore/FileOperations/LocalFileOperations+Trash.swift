// LocalFileOperations+Trash.swift — Delete → Trash for the local Filesystem
// source (issue #2631).
//
// macOS owns a real Trash the user already knows how to look in, so a
// filesystem-source delete goes straight to `FileManager.trashItem` — one
// syscall, recoverable from Finder, no copy-verify-delete needed because the
// OS is the one doing the moving. iOS/iPadOS has no OS trash for a
// security-scoped folder, so it falls back to `.maple/trash/<rel>` under the
// library root via the SAME relocate primitive every other move here uses.

import Foundation

extension LocalFileOperations {

    /// Trash a single asset (primary + sidecar).
    public static func trash(_ primaryURL: URL, libraryRoot: URL) async throws -> RelocateOutcome {
        #if os(macOS)
        return try await trashToOSTrash(primaryURL)
        #else
        return try await trashToMapleFolder(primaryURL, libraryRoot: libraryRoot)
        #endif
    }

    #if os(macOS)
    /// The real OS Trash. No `#if`-independent counterpart to test against —
    /// `FileManager.trashItem` is Apple's own contract to keep, not logic
    /// this module owns.
    static func trashToOSTrash(_ primaryURL: URL) async throws -> RelocateOutcome {
        let fm = FileManager.default
        var trashedPrimary: NSURL?
        try fm.trashItem(at: primaryURL, resultingItemURL: &trashedPrimary)

        let sidecarURL = SidecarPath.sidecarURL(for: primaryURL)
        var trashedSidecarURL: URL?
        if fm.fileExists(atPath: sidecarURL.path) {
            var resultingURL: NSURL?
            try? fm.trashItem(at: sidecarURL, resultingItemURL: &resultingURL)
            trashedSidecarURL = resultingURL as URL?
        }
        await invalidateDerivedCaches(forOldPrimaryPath: primaryURL.path)
        return RelocateOutcome(
            primaryPath: (trashedPrimary as URL?)?.path ?? primaryURL.path,
            sidecarPath: trashedSidecarURL?.path,
            renamedDueToCollision: false,
            sidecarFollowed: trashedSidecarURL != nil
        )
    }
    #endif

    /// `.maple/trash/<rel>` fallback. iOS/iPadOS routes here always; it has
    /// no `#if os` gate so it's also directly reachable (and testable) on
    /// macOS, where `trash(_:libraryRoot:)` itself never calls it.
    static func trashToMapleFolder(_ primaryURL: URL, libraryRoot: URL) async throws -> RelocateOutcome {
        let trashDir = try trashDestinationDir(for: primaryURL, libraryRoot: libraryRoot)
        return try await relocate(primaryURL, to: trashDir, mode: .move, collision: .autoSuffix)
    }

    /// `<libraryRoot>/.maple/trash/<relative-parent-directory>` — mirrors
    /// the API's `computeTrashPath` (`src/api/src/fs/trash.ts`), which
    /// preserves the item's relative position under the root so Restore can
    /// reconstruct the original tree. Works for both a file and a folder:
    /// it only cares about `item`'s PARENT directory, so folder-delete
    /// reuses it verbatim to compute where the folder itself should land.
    static func trashDestinationDir(for item: URL, libraryRoot: URL) throws -> URL {
        let rootPath = libraryRoot.standardizedFileURL.path
        let parentPath = item.deletingLastPathComponent().standardizedFileURL.path
        guard parentPath == rootPath || parentPath.hasPrefix(rootPath + "/") else {
            throw FileOperationError.invalidDestination(
                "\(item.path) is not under library root \(libraryRoot.path)")
        }
        let trashRoot = libraryRoot.appendingPathComponent(".maple").appendingPathComponent("trash")
        guard parentPath != rootPath else { return trashRoot }
        let relSuffix = String(parentPath.dropFirst(rootPath.count + 1))
        return trashRoot.appendingPathComponent(relSuffix)
    }
}

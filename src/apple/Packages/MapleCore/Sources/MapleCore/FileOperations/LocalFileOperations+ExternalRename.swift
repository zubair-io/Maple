// LocalFileOperations+ExternalRename.swift — applies ONE confirmed
// external-rename match (issue #2656: `ExternalRenameMatcher` decided
// `oldPrimaryPath` and `newPrimaryPath` are the same photo). Unlike
// `relocate`/`planRelocate`, the PRIMARY file was already moved by Finder
// (or any other external process) before this ever runs — there is nothing
// left to copy-verify-delete. This only needs to make the SIDECAR follow,
// clear the old location's derived caches, and refresh the `LibraryIndex`
// — reusing the exact step-5/step-7 primitives `LocalFileOperations+
// CacheAndIndex.swift` already established for the user-initiated relocate
// path.

import Foundation
import OSLog

private let externalRenameLog = Logger(subsystem: "app.justmaple.aperture", category: "ExternalRename")

extension LocalFileOperations {

    /// Apply a confirmed external rename. Returns `false` (never throws) on
    /// any failure — matches the best-effort framing of every other
    /// cache/index-repointing step in this module: the photo's pixels and
    /// its sidecar's CONTENTS are never at risk here, only whether the
    /// sidecar successfully follows to the new name.
    ///
    /// Re-verifies the match against the live filesystem before touching
    /// anything: the old path must genuinely be gone and the new path must
    /// genuinely exist. A caller building a match from a stale snapshot (a
    /// race between the rescan diff and this call) fails this check and
    /// declines rather than acting on data that's no longer true.
    @discardableResult
    public static func applyExternalRename(oldPrimaryPath: String, newPrimaryPath: String) async -> Bool {
        let oldURL = URL(fileURLWithPath: oldPrimaryPath)
        let newURL = URL(fileURLWithPath: newPrimaryPath)
        let fm = FileManager.default
        guard !fm.fileExists(atPath: oldURL.path), fm.fileExists(atPath: newURL.path) else {
            externalRenameLog.notice(
                "applyExternalRename: stale match, declining (\(oldPrimaryPath, privacy: .public) -> \(newPrimaryPath, privacy: .public))")
            return false
        }

        let oldSidecarURL = SidecarPath.sidecarURL(for: oldURL)
        var sourceSidecarPath: String?
        var finalSidecarPath: String?
        if fm.fileExists(atPath: oldSidecarURL.path) {
            let newSidecarURL = SidecarPath.sidecarURL(for: newURL)
            guard !fm.fileExists(atPath: newSidecarURL.path) else {
                // The newly-arrived file already owns a sidecar of its own —
                // moving the old one on top would silently attach one
                // photo's edits to another. Decline rather than clobber.
                externalRenameLog.notice(
                    "applyExternalRename: destination already has a sidecar, declining (\(newSidecarURL.path, privacy: .public))")
                return false
            }
            do {
                try fm.moveItem(at: oldSidecarURL, to: newSidecarURL)
            } catch {
                externalRenameLog.error(
                    "applyExternalRename: sidecar moveItem failed (\(oldSidecarURL.path, privacy: .public)): \(error.localizedDescription, privacy: .public)")
                return false
            }
            sourceSidecarPath = oldSidecarURL.path
            finalSidecarPath = newSidecarURL.path
        }

        await invalidateDerivedCaches(forOldPrimaryPath: oldPrimaryPath)
        // `sourceAlreadyRelocated: true` — the primary was already moved by
        // Finder, not by us, so `refreshLibraryIndexAfterMove` (which only
        // reads `plan.sourcePrimaryPath`/`finalPrimaryPath`, never
        // `createdPaths`) is the only part of the shared plan type this
        // needs.
        let plan = RelocatePlan(
            mode: .move, sourcePrimaryPath: oldPrimaryPath, sourceSidecarPath: sourceSidecarPath,
            finalPrimaryPath: newPrimaryPath, finalSidecarPath: finalSidecarPath,
            renamedDueToCollision: false, createdPaths: [], sourceAlreadyRelocated: true)
        await refreshLibraryIndexAfterMove(plan)

        externalRenameLog.info(
            "applyExternalRename: reconciled \(oldPrimaryPath, privacy: .public) -> \(newPrimaryPath, privacy: .public), sidecarFollowed=\(finalSidecarPath != nil)")
        return true
    }
}

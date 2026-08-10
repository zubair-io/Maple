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
    /// `libraryIndexStore`, when provided, is threaded through to
    /// `refreshLibraryIndexAfterMove` instead of letting it construct a
    /// fresh `LibraryIndexStore` — `ExternalRenameReconciler` passes the
    /// SAME actor instance it used to read the folder's fingerprint cache,
    /// so every read/write for this folder during one reconcile pass is
    /// serialized through one actor rather than racing independent
    /// instances over the same `index.json` (#2656 review).
    @discardableResult
    public static func applyExternalRename(
        oldPrimaryPath: String, newPrimaryPath: String, libraryIndexStore: LibraryIndexStore? = nil
    ) async -> Bool {
        let oldURL = URL(fileURLWithPath: oldPrimaryPath)
        let newURL = URL(fileURLWithPath: newPrimaryPath)
        let fm = FileManager.default

        // A case-only rename (`IMG_1.dng` -> `img_1.dng`) on a case-
        // insensitive-but-case-preserving filesystem (APFS default) is the
        // SAME inode at both paths — `fileExists(atPath:)` resolves
        // case-insensitively, so the plain "old is gone, new exists" check
        // below would see the OLD path as still present (it resolves to the
        // very file that was just renamed) and decline, silently stranding
        // the sidecar. `classifySameFile` is the same helper the plain
        // relocate path (`LocalFileOperations.planRelocate`) already uses to
        // recognize this shape; route around the existence check for it.
        let caseOnlyRename = classifySameFile(source: oldURL, target: newURL) == .caseOnlyRename
        if caseOnlyRename {
            guard fm.fileExists(atPath: newURL.path) else {
                externalRenameLog.notice(
                    "applyExternalRename: case-only match but new path is missing, declining (\(newPrimaryPath, privacy: .public))")
                return false
            }
        } else {
            guard !fm.fileExists(atPath: oldURL.path), fm.fileExists(atPath: newURL.path) else {
                externalRenameLog.notice(
                    "applyExternalRename: stale match, declining (\(oldPrimaryPath, privacy: .public) -> \(newPrimaryPath, privacy: .public))")
                return false
            }
        }

        let oldSidecarURL = SidecarPath.sidecarURL(for: oldURL)
        let newSidecarURL = SidecarPath.sidecarURL(for: newURL)
        var sourceSidecarPath: String?
        var finalSidecarPath: String?
        if fm.fileExists(atPath: oldSidecarURL.path) {
            if caseOnlyRename {
                // Same reasoning as the primary above: `oldSidecarURL` and
                // `newSidecarURL` name the SAME sidecar file when the rename
                // is case-only, so `fileExists(atPath: newSidecarURL.path)`
                // would resolve to it too — a "does the destination already
                // have ITS OWN sidecar" check is meaningless here. Move
                // directly, mirroring `LocalFileOperations.
                // performCaseOnlyRename`'s identical unconditional move.
                do {
                    try fm.moveItem(at: oldSidecarURL, to: newSidecarURL)
                } catch {
                    externalRenameLog.error(
                        "applyExternalRename: case-only sidecar moveItem failed (\(oldSidecarURL.path, privacy: .public)): \(error.localizedDescription, privacy: .public)")
                    return false
                }
                sourceSidecarPath = oldSidecarURL.path
                finalSidecarPath = newSidecarURL.path
            } else {
                guard !fm.fileExists(atPath: newSidecarURL.path) else {
                    // The newly-arrived file already owns a sidecar of its
                    // own — moving the old one on top would silently attach
                    // one photo's edits to another. Decline rather than
                    // clobber.
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
        await refreshLibraryIndexAfterMove(plan, using: libraryIndexStore)

        externalRenameLog.info(
            "applyExternalRename: reconciled \(oldPrimaryPath, privacy: .public) -> \(newPrimaryPath, privacy: .public), sidecarFollowed=\(finalSidecarPath != nil)")
        return true
    }
}

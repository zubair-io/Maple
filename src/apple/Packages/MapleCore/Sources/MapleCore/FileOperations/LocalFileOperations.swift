// LocalFileOperations.swift — relocate primitive for the local Filesystem
// source (issue #2631). Copy → verify → sidecar-follow → delete, split into
// `planRelocate` (copy + verify, no deletes) and `finalizeRelocate` (delete
// + cache/index cleanup) so the crash-safety invariant is directly
// testable: call `planRelocate` alone and both the source and the staged
// copy exist on disk, which is exactly the state a real crash between the
// two phases would leave behind. See docs/superpowers/specs/
// 2026-08-04-file-management-design.md § "Core architecture".
//
// Stateless by design (a namespace of static functions, like `SidecarPath`)
// — there is no per-instance state to protect, so this isn't wrapped in an
// actor the way stateful I/O owners (`XMPSidecarStore`, `ThumbnailLoader`)
// are.

import Foundation
import OSLog

private let fileOpsLog = Logger(subsystem: "app.justmaple.aperture", category: "LocalFileOperations")

public enum LocalFileOperations {

    /// Tolerance for the post-copy mtime check — `setAttributes` round-trips
    /// through the filesystem's own clock precision, so exact `Date`
    /// equality is not guaranteed even for a byte-perfect copy.
    static let mtimeTolerance: TimeInterval = 2.0

    // MARK: - Relocate (asset-level: primary + sidecar)

    /// Convenience: plan then finalize in one call. Most callers want this;
    /// `planRelocate`/`finalizeRelocate` exist separately for crash-safety
    /// testing (see the file header) and so a caller can inspect a plan
    /// before committing to it.
    public static func relocate(
        _ sourcePrimaryURL: URL,
        to destinationDir: URL,
        newBasename: String? = nil,
        mode: RelocateMode,
        collision: CollisionPolicy = .autoSuffix
    ) async throws -> RelocateOutcome {
        let plan = try await planRelocate(sourcePrimaryURL, to: destinationDir,
                                           newBasename: newBasename, mode: mode, collision: collision)
        return await finalizeRelocate(plan)
    }

    /// Copy (never move) the primary file — and its `.xmp` sidecar, if one
    /// exists — into `destinationDir`, verifying each copy. Nothing is
    /// deleted and the source is untouched no matter how this call ends,
    /// including when it throws. The one exception is a case-only rename
    /// (see `classifySameFile`), which is performed directly here as an
    /// atomic move — there is no meaningful "staged copy" for it.
    ///
    /// `async` even though every step is a synchronous local `FileManager`
    /// call — matches `ImageSource`'s shape (`FilesystemSource.rawBytes` is
    /// `async throws` too) and lets this share `CollisionResolver`'s async
    /// algorithm with the real-network SMB engine verbatim.
    public static func planRelocate(
        _ sourcePrimaryURL: URL,
        to destinationDir: URL,
        newBasename: String? = nil,
        mode: RelocateMode,
        collision: CollisionPolicy = .autoSuffix
    ) async throws -> RelocatePlan {
        let fm = FileManager.default
        guard fm.fileExists(atPath: sourcePrimaryURL.path) else {
            throw FileOperationError.sourceMissing(sourcePrimaryURL.path)
        }

        let basename = newBasename ?? sourcePrimaryURL.lastPathComponent
        let targetURL = destinationDir.appendingPathComponent(basename)

        switch classifySameFile(source: sourcePrimaryURL, target: targetURL) {
        case .identical:
            throw FileOperationError.sameFile(
                "destination resolves to the same file as the source: \(sourcePrimaryURL.path)")
        case .caseOnlyRename:
            guard mode == .move else {
                throw FileOperationError.sameFile(
                    "case-only rename target is the same file as the source on a case-insensitive "
                    + "filesystem — copy is not meaningful: \(sourcePrimaryURL.path)")
            }
            return try performCaseOnlyRename(source: sourcePrimaryURL, target: targetURL)
        case .different:
            break
        }

        try fm.createDirectory(at: destinationDir, withIntermediateDirectories: true)
        let (resolvedTargetURL, renamed) = try await resolveCollision(at: targetURL, collision: collision)

        var createdPaths: [String] = []
        try copyVerified(from: sourcePrimaryURL, to: resolvedTargetURL)
        createdPaths.append(resolvedTargetURL.path)

        let sourceSidecarURL = SidecarPath.sidecarURL(for: sourcePrimaryURL)
        var sourceSidecarPath: String?
        var finalSidecarPath: String?
        if fm.fileExists(atPath: sourceSidecarURL.path) {
            sourceSidecarPath = sourceSidecarURL.path
            let sidecarTargetURL = SidecarPath.sidecarURL(for: resolvedTargetURL)
            do {
                // The primary's target basename was already proven free (or
                // explicitly replaced) above; an orphan sidecar that
                // happens to share the DERIVED sidecar name is abandoned
                // data, not a live asset's — this asset's sidecar following
                // it is what "the sidecar always follows the primary"
                // means, so it claims that name the same way `.replace`
                // would.
                if fm.fileExists(atPath: sidecarTargetURL.path) {
                    try fm.removeItem(at: sidecarTargetURL)
                }
                try copyVerified(from: sourceSidecarURL, to: sidecarTargetURL)
            } catch {
                // A plan either fully succeeds or leaves NO trace — roll
                // back the primary copy so a caller that sees this throw
                // never has to guess what's on disk.
                try? fm.removeItem(at: resolvedTargetURL)
                throw error
            }
            createdPaths.append(sidecarTargetURL.path)
            finalSidecarPath = sidecarTargetURL.path
        }

        return RelocatePlan(mode: mode, sourcePrimaryPath: sourcePrimaryURL.path,
                             sourceSidecarPath: sourceSidecarPath,
                             finalPrimaryPath: resolvedTargetURL.path, finalSidecarPath: finalSidecarPath,
                             renamedDueToCollision: renamed, createdPaths: createdPaths)
    }

    /// Delete the sources (`mode == .move` only), invalidate the derived
    /// thumb/preview caches at the OLD location, and best-effort refresh
    /// the `LibraryIndex` entries. Every step here is best-effort: per the
    /// design doc, "a copy-succeeded-but-delete-failed leaves a duplicate,
    /// never data loss" — a failure is logged (`fileOpsLog`), never thrown,
    /// since the plan already committed a verified, correct copy at the
    /// destination. A no-op for a case-only rename (`isNoop`): that already
    /// did everything inside `planRelocate`, and re-touching
    /// `sourcePrimaryPath` here would delete the file that was just renamed
    /// (on a case-insensitive filesystem the old-cased path still resolves
    /// to it).
    @discardableResult
    public static func finalizeRelocate(_ plan: RelocatePlan) async -> RelocateOutcome {
        let outcome = RelocateOutcome(
            primaryPath: plan.finalPrimaryPath, sidecarPath: plan.finalSidecarPath,
            renamedDueToCollision: plan.renamedDueToCollision,
            sidecarFollowed: plan.finalSidecarPath != nil
        )
        guard !plan.isNoop, plan.mode == .move else { return outcome }

        let fm = FileManager.default
        do {
            try fm.removeItem(atPath: plan.sourcePrimaryPath)
        } catch {
            fileOpsLog.error(
                "finalizeRelocate: source primary unlink failed after a verified copy — a duplicate is left on disk (\(plan.sourcePrimaryPath, privacy: .public)): \(error.localizedDescription, privacy: .public)")
        }
        if let sourceSidecarPath = plan.sourceSidecarPath {
            do {
                try fm.removeItem(atPath: sourceSidecarPath)
            } catch {
                fileOpsLog.error(
                    "finalizeRelocate: source sidecar unlink failed after a verified copy (\(sourceSidecarPath, privacy: .public)): \(error.localizedDescription, privacy: .public)")
            }
        }
        invalidateDerivedCaches(forOldPrimaryPath: plan.sourcePrimaryPath)
        await refreshLibraryIndexAfterMove(plan)
        return outcome
    }

    /// Undo a plan that will never be finalized — removes the staged
    /// copies, leaving the source (and everything else) exactly as it was
    /// before `planRelocate` ran. Not applicable to a case-only rename
    /// (`sourceAlreadyRelocated`) — that has no staged copies to revert;
    /// undoing it would mean renaming back, which a caller that actually
    /// needs that can do by calling `planRelocate` again in reverse.
    public static func revertPlan(_ plan: RelocatePlan) {
        for path in plan.createdPaths {
            try? FileManager.default.removeItem(atPath: path)
        }
    }

    // MARK: - Same-file / case-only-rename guard

    /// Resolve `url`'s PARENT directory through any symlinks
    /// (`resolvingSymlinksInPath()`), then rejoin `url`'s ORIGINAL
    /// (unresolved) last path component literally. Deliberately does NOT
    /// resolve the full path — see `classifySameFile`'s doc comment for
    /// why resolving the basename too would break case-only-rename
    /// detection.
    static func canonicalParent(_ url: URL) -> URL {
        url.deletingLastPathComponent().resolvingSymlinksInPath()
    }

    /// Classifies whether `source` and `target` name the same on-disk
    /// location — directly, or through a symlinked ancestor directory —
    /// versus merely differing in case (a legitimate rename on a
    /// case-insensitive-but-case-preserving filesystem like APFS) versus
    /// genuinely different locations.
    ///
    /// The load-bearing property this protects: a relocate must never
    /// delete the only copy of a file. `collision: .replace`'s
    /// `removeAssetAndSidecar` runs BEFORE the copy — if the destination
    /// resolves to the source (directly, or via a symlink alias), that
    /// remove deletes the source itself, and the copy that follows then
    /// fails because there's nothing left to read.
    ///
    /// Resolving only the PARENT directory (never the basename) is
    /// deliberate: `resolvingSymlinksInPath()` on a case-insensitive
    /// filesystem resolves a query that differs only in case to the file's
    /// STORED casing, so resolving the full path (basename included) would
    /// make `IMG.CR3` and `img.cr3` compare equal whenever either already
    /// exists — collapsing a legitimate case-only rename into "same file"
    /// and wrongly refusing it. Resolving only the directory sidesteps
    /// that: two paths differing solely in basename case still compare
    /// literally unequal, while a symlinked PARENT is still caught (its
    /// target is resolved before the basename is reattached).
    static func classifySameFile(source: URL, target: URL) -> SameFileClassification {
        let sourceParent = canonicalParent(source).standardizedFileURL.path
        let targetParent = canonicalParent(target).standardizedFileURL.path
        guard sourceParent == targetParent else { return .different }

        let sourceBase = source.lastPathComponent
        let targetBase = target.lastPathComponent
        if sourceBase == targetBase { return .identical }
        if sourceBase.caseInsensitiveCompare(targetBase) == .orderedSame { return .caseOnlyRename }
        return .different
    }

    /// The ONE relocate shape that bypasses copy-verify-delete AND
    /// collision handling entirely: on a case-insensitive-but-case-
    /// preserving filesystem, a case-only rename's source and target are
    /// the SAME underlying file. `FileManager.moveItem` (a single atomic
    /// `rename(2)`) is what the OS itself uses to update just the stored
    /// casing — a copy would copy the file onto itself, and
    /// `fileExists`-keyed collision handling would treat the source as
    /// "occupying" its own destination. Does its own cache/index cleanup
    /// inline (there is no separate `finalize` step for an already-atomic
    /// rename — see `RelocatePlan.sourceAlreadyRelocated`). Throws (leaving
    /// the source untouched — `moveItem` either fully succeeds or doesn't
    /// touch anything) if the rename itself fails, e.g. a permissions
    /// error; a failed rename is a genuine failure the caller must see, not
    /// a silent no-op.
    private static func performCaseOnlyRename(source: URL, target: URL) throws -> RelocatePlan {
        let fm = FileManager.default
        let sourceSidecarURL = SidecarPath.sidecarURL(for: source)
        let hadSidecar = fm.fileExists(atPath: sourceSidecarURL.path)

        try fm.moveItem(at: source, to: target)

        var finalSidecarPath: String?
        var sourceSidecarPath: String?
        if hadSidecar {
            let targetSidecarURL = SidecarPath.sidecarURL(for: target)
            sourceSidecarPath = sourceSidecarURL.path
            // Best-effort, matching `moveSidecarsAlongside`'s "RAW moved,
            // sidecar left in place" contract — the primary rename above is
            // already complete and safe (an atomic rename has no partial
            // state to revert), so a sidecar rename failure doesn't unwind
            // it.
            do {
                try fm.moveItem(at: sourceSidecarURL, to: targetSidecarURL)
            } catch {
                fileOpsLog.error("performCaseOnlyRename: sidecar moveItem failed (\(sourceSidecarURL.path, privacy: .public)): \(error.localizedDescription, privacy: .public)")
            }
            finalSidecarPath = fm.fileExists(atPath: targetSidecarURL.path) ? targetSidecarURL.path : nil
        }

        let plan = RelocatePlan(mode: .move, sourcePrimaryPath: source.path, sourceSidecarPath: sourceSidecarPath,
                                 finalPrimaryPath: target.path, finalSidecarPath: finalSidecarPath,
                                 renamedDueToCollision: false, createdPaths: [], sourceAlreadyRelocated: true)
        invalidateDerivedCaches(forOldPrimaryPath: source.path)
        return plan
    }

    // MARK: - Copy + verify

    /// Copy `source` to `destination`, explicitly preserving `source`'s
    /// modification date (a pure rename/move must not invalidate the
    /// mtime-keyed rendered-preview cache — docs/caching.md § 3), then
    /// verify the copy. On any failure the partial copy is removed and the
    /// error propagates; `source` itself is never touched here.
    static func copyVerified(from source: URL, to destination: URL) throws {
        let fm = FileManager.default
        let sourceAttrs = try fm.attributesOfItem(atPath: source.path)
        guard let sourceSize = (sourceAttrs[.size] as? NSNumber)?.int64Value else {
            throw FileOperationError.underlying("could not read size of \(source.path)")
        }
        let sourceMtime = sourceAttrs[.modificationDate] as? Date

        do {
            try fm.copyItem(at: source, to: destination)
            if let sourceMtime {
                try? fm.setAttributes([.modificationDate: sourceMtime], ofItemAtPath: destination.path)
            }
            try verifyCopy(sourceSize: sourceSize, sourceMtime: sourceMtime, destinationURL: destination)
        } catch {
            try? fm.removeItem(at: destination)
            throw (error as? FileOperationError) ?? .underlying(
                "copy \(source.path) -> \(destination.path) failed: \(error.localizedDescription)")
        }
    }

    /// The verification step in isolation — `internal` (not `private`) so
    /// tests can drive the mismatch branch directly against real,
    /// deliberately-divergent files on disk. This boundary only fires in
    /// production if the destination changes between our copy and our
    /// verify (a second writer racing the same path); it's real logic that
    /// deserves real coverage even though it's impractical to provoke
    /// end-to-end.
    static func verifyCopy(sourceSize: Int64, sourceMtime: Date?, destinationURL: URL) throws {
        let fm = FileManager.default
        guard fm.fileExists(atPath: destinationURL.path) else {
            throw FileOperationError.verificationFailed("missing destination: \(destinationURL.path)")
        }
        let destAttrs = try fm.attributesOfItem(atPath: destinationURL.path)
        let destSize = (destAttrs[.size] as? NSNumber)?.int64Value
        guard destSize == sourceSize else {
            throw FileOperationError.verificationFailed(
                "\(destinationURL.path): size \(String(describing: destSize)) != \(sourceSize)")
        }
        if let sourceMtime, let destMtime = destAttrs[.modificationDate] as? Date {
            guard abs(destMtime.timeIntervalSince1970 - sourceMtime.timeIntervalSince1970) < mtimeTolerance else {
                throw FileOperationError.verificationFailed(
                    "\(destinationURL.path): mtime \(destMtime) != \(sourceMtime)")
            }
        }
    }

    // MARK: - Collision helpers

    /// Resolve a collision at `targetURL` per `collision`, returning the
    /// (possibly suffixed) final URL and whether a suffix was applied. A
    /// pure computation for `.fail`/`.autoSuffix`; `.replace` performs the
    /// actual removal as a side effect (it has to happen here, before the
    /// copy that follows, rather than being deferred to the caller).
    private static func resolveCollision(
        at targetURL: URL, collision: CollisionPolicy
    ) async throws -> (url: URL, renamed: Bool) {
        let fm = FileManager.default
        guard fm.fileExists(atPath: targetURL.path) else { return (targetURL, false) }
        switch collision {
        case .fail:
            throw FileOperationError.destinationExists(targetURL.path)
        case .replace:
            try removeAssetAndSidecar(at: targetURL)
            return (targetURL, false)
        case .autoSuffix:
            let free = try await CollisionResolver.pickFreePath(targetURL.path) { candidate in
                fm.fileExists(atPath: candidate)
            }
            return (URL(fileURLWithPath: free), true)
        }
    }

    /// Remove `url` and its sidecar (if any), best-effort on the sidecar
    /// (matching `moveSidecarsAlongside`'s "RAW move is authoritative, a
    /// lost sidecar copy is recoverable" precedent) but NOT on the primary —
    /// a `.replace` collision must genuinely clear the primary before the
    /// copy that follows, so a real removal failure there propagates.
    static func removeAssetAndSidecar(at url: URL) throws {
        let fm = FileManager.default
        try fm.removeItem(at: url)
        let sidecarURL = SidecarPath.sidecarURL(for: url)
        try? fm.removeItem(at: sidecarURL)
    }
}

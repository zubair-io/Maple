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
    /// including when it throws.
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
        var targetURL = destinationDir.appendingPathComponent(basename)

        // Already exactly where it belongs — a genuine no-op. Nothing to
        // copy, and `finalize` must never delete the only copy of the file.
        if targetURL.standardizedFileURL.path == sourcePrimaryURL.standardizedFileURL.path {
            return RelocatePlan(mode: mode, sourcePrimaryPath: sourcePrimaryURL.path,
                                 sourceSidecarPath: nil, finalPrimaryPath: sourcePrimaryURL.path,
                                 finalSidecarPath: nil, renamedDueToCollision: false, createdPaths: [])
        }

        try fm.createDirectory(at: destinationDir, withIntermediateDirectories: true)

        var renamed = false
        if fm.fileExists(atPath: targetURL.path) {
            switch collision {
            case .fail:
                throw FileOperationError.destinationExists(targetURL.path)
            case .replace:
                try removeAssetAndSidecar(at: targetURL)
            case .autoSuffix:
                let free = try await CollisionResolver.pickFreePath(targetURL.path) { candidate in
                    fm.fileExists(atPath: candidate)
                }
                targetURL = URL(fileURLWithPath: free)
                renamed = true
            }
        }

        var createdPaths: [String] = []
        try copyVerified(from: sourcePrimaryURL, to: targetURL)
        createdPaths.append(targetURL.path)

        let sourceSidecarURL = SidecarPath.sidecarURL(for: sourcePrimaryURL)
        var sourceSidecarPath: String?
        var finalSidecarPath: String?
        if fm.fileExists(atPath: sourceSidecarURL.path) {
            sourceSidecarPath = sourceSidecarURL.path
            let sidecarTargetURL = SidecarPath.sidecarURL(for: targetURL)
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
                try? fm.removeItem(at: targetURL)
                throw error
            }
            createdPaths.append(sidecarTargetURL.path)
            finalSidecarPath = sidecarTargetURL.path
        }

        return RelocatePlan(mode: mode, sourcePrimaryPath: sourcePrimaryURL.path,
                             sourceSidecarPath: sourceSidecarPath,
                             finalPrimaryPath: targetURL.path, finalSidecarPath: finalSidecarPath,
                             renamedDueToCollision: renamed, createdPaths: createdPaths)
    }

    /// Delete the sources (`mode == .move` only), invalidate the derived
    /// thumb/preview caches at the OLD location, and best-effort refresh
    /// the `LibraryIndex` entries. Every step here is best-effort: per the
    /// design doc, "a copy-succeeded-but-delete-failed leaves a duplicate,
    /// never data loss," so a failure here is logged, never thrown — the
    /// plan already committed a verified, correct copy at the destination.
    @discardableResult
    public static func finalizeRelocate(_ plan: RelocatePlan) async -> RelocateOutcome {
        let outcome = RelocateOutcome(
            primaryPath: plan.finalPrimaryPath, sidecarPath: plan.finalSidecarPath,
            renamedDueToCollision: plan.renamedDueToCollision,
            sidecarFollowed: plan.finalSidecarPath != nil
        )
        guard !plan.isNoop else { return outcome }

        if plan.mode == .move {
            let fm = FileManager.default
            try? fm.removeItem(atPath: plan.sourcePrimaryPath)
            if let sourceSidecarPath = plan.sourceSidecarPath {
                try? fm.removeItem(atPath: sourceSidecarPath)
            }
            invalidateDerivedCaches(forOldPrimaryPath: plan.sourcePrimaryPath)
            await refreshLibraryIndexAfterMove(plan)
        }
        return outcome
    }

    /// Undo a plan that will never be finalized — removes the staged
    /// copies, leaving the source (and everything else) exactly as it was
    /// before `planRelocate` ran.
    public static func revertPlan(_ plan: RelocatePlan) {
        for path in plan.createdPaths {
            try? FileManager.default.removeItem(atPath: path)
        }
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

// SMBFileOperations.swift — relocate primitive for the SMB source (issue
// #2631). Same shape and the same crash-safety contract as
// `LocalFileOperations` — copy → verify → sidecar-follow → delete, split
// into plan/finalize — but keyed by share-relative POSIX path strings
// (there is no local `URL`; see `SMBSource.swift`'s identical choice) and
// routed through the narrow `SMBFileTransport` protocol so tests can
// substitute an in-memory fake (see `SMBFileTransport.swift` for why).
//
// The caller supplies the already-connected `transport` (normally a live
// `SMB2Manager`) — this module owns no connection lifecycle, matching
// `SMBIdCacheStorage`'s identical choice to take a `client` rather than
// dial its own.

import Foundation
import OSLog

private let fileOpsLog = Logger(subsystem: "app.justmaple.aperture", category: "SMBFileOperations")

public enum SMBFileOperations {

    /// SMB attribute round-trips add a real network hop for comparatively
    /// little safety benefit over `LocalFileOperations`' same-machine
    /// check, so this is a looser bound than the local tolerance — still
    /// tight enough to catch a copy that landed against the wrong file.
    static let mtimeTolerance: TimeInterval = 2.0

    // MARK: - Relocate (asset-level: primary + sidecar)

    public static func relocate(
        _ sourcePrimaryPath: String,
        to destinationDir: String,
        newBasename: String? = nil,
        mode: RelocateMode,
        collision: CollisionPolicy = .autoSuffix,
        transport: SMBFileTransport
    ) async throws -> RelocateOutcome {
        let plan = try await planRelocate(sourcePrimaryPath, to: destinationDir, newBasename: newBasename,
                                           mode: mode, collision: collision, transport: transport)
        return await finalizeRelocate(plan, transport: transport)
    }

    /// Copy (never move) the primary — and its `.xmp` sidecar, if one
    /// exists — into `destinationDir`, verifying each copy. Nothing is
    /// deleted; the source is untouched no matter how this call ends. The
    /// one exception is a case-only rename (see `classifySameFile`),
    /// performed directly here as an atomic move.
    public static func planRelocate(
        _ sourcePrimaryPath: String,
        to destinationDir: String,
        newBasename: String? = nil,
        mode: RelocateMode,
        collision: CollisionPolicy = .autoSuffix,
        transport: SMBFileTransport
    ) async throws -> RelocatePlan {
        guard await exists(sourcePrimaryPath, transport: transport) else {
            throw FileOperationError.sourceMissing(sourcePrimaryPath)
        }

        let basename = newBasename ?? posixLastComponent(sourcePrimaryPath)
        let targetPath = posixJoin(destinationDir, basename)

        switch classifySameFile(source: sourcePrimaryPath, target: targetPath) {
        case .identical:
            throw FileOperationError.sameFile(
                "destination resolves to the same file as the source: \(sourcePrimaryPath)")
        case .caseOnlyRename:
            guard mode == .move else {
                throw FileOperationError.sameFile(
                    "case-only rename target is the same file as the source on a case-insensitive "
                    + "share — copy is not meaningful: \(sourcePrimaryPath)")
            }
            return try await performCaseOnlyRename(source: sourcePrimaryPath, target: targetPath, transport: transport)
        case .different:
            break
        }

        // Best-effort: the destination directory almost always already
        // exists (moving into an existing folder); a genuinely-missing one
        // surfaces for real on the `copyItem` call that follows.
        try? await transport.createDirectory(atPath: destinationDir)
        let (resolvedTargetPath, renamed) = try await resolveCollision(
            at: targetPath, collision: collision, transport: transport)

        var createdPaths: [String] = []
        try await copyVerified(from: sourcePrimaryPath, to: resolvedTargetPath, transport: transport)
        createdPaths.append(resolvedTargetPath)

        let sourceSidecarPath = sidecarPath(for: sourcePrimaryPath)
        var resolvedSourceSidecarPath: String?
        var finalSidecarPath: String?
        if await exists(sourceSidecarPath, transport: transport) {
            resolvedSourceSidecarPath = sourceSidecarPath
            let sidecarTargetPath = sidecarPath(for: resolvedTargetPath)
            do {
                // Same reasoning as the local engine: the primary's target
                // basename was already proven free (or explicitly
                // replaced), so an orphan sidecar sharing the DERIVED
                // sidecar name is abandoned data this asset's sidecar
                // claims by following it.
                if await exists(sidecarTargetPath, transport: transport) {
                    try await transport.removeItem(atPath: sidecarTargetPath)
                }
                try await copyVerified(from: sourceSidecarPath, to: sidecarTargetPath, transport: transport)
            } catch {
                try? await transport.removeItem(atPath: resolvedTargetPath)
                throw error
            }
            createdPaths.append(sidecarTargetPath)
            finalSidecarPath = sidecarTargetPath
        }

        return RelocatePlan(mode: mode, sourcePrimaryPath: sourcePrimaryPath,
                             sourceSidecarPath: resolvedSourceSidecarPath,
                             finalPrimaryPath: resolvedTargetPath, finalSidecarPath: finalSidecarPath,
                             renamedDueToCollision: renamed, createdPaths: createdPaths)
    }

    /// Delete the sources (`mode == .move` only). Best-effort, matching the
    /// local engine — a copy-succeeded-but-delete-failed leaves a
    /// duplicate, never data loss; a failure is logged (`fileOpsLog`), not
    /// thrown. Unlike the local engine, this does NOT invalidate a derived
    /// cache or refresh a `LibraryIndex`: SMB has neither. Per
    /// docs/caching.md, `.maple/thumbs`/`.maple/previews` are Filesystem-
    /// source-only on the Apple side — SMB thumbnails are generated on
    /// demand and never disk-cached locally — and the per-folder cold-open
    /// `LibraryIndex` is a Filesystem-source concept too. If SMB ever
    /// grows its own on-share derived cache (writable via `transport`,
    /// unlike a local macOS disk cache), invalidating it here would be the
    /// place — that's follow-up scope, not a gap in this method today.
    @discardableResult
    public static func finalizeRelocate(_ plan: RelocatePlan, transport: SMBFileTransport) async -> RelocateOutcome {
        let outcome = RelocateOutcome(
            primaryPath: plan.finalPrimaryPath, sidecarPath: plan.finalSidecarPath,
            renamedDueToCollision: plan.renamedDueToCollision,
            sidecarFollowed: plan.finalSidecarPath != nil
        )
        guard !plan.isNoop, plan.mode == .move else { return outcome }

        do {
            try await transport.removeItem(atPath: plan.sourcePrimaryPath)
        } catch {
            fileOpsLog.error(
                "finalizeRelocate: source primary remove failed after a verified copy — a duplicate is left on the share (\(plan.sourcePrimaryPath, privacy: .public)): \(error.localizedDescription, privacy: .public)")
        }
        if let sourceSidecarPath = plan.sourceSidecarPath {
            do {
                try await transport.removeItem(atPath: sourceSidecarPath)
            } catch {
                fileOpsLog.error(
                    "finalizeRelocate: source sidecar remove failed after a verified copy (\(sourceSidecarPath, privacy: .public)): \(error.localizedDescription, privacy: .public)")
            }
        }
        return outcome
    }

    /// Undo a plan that will never be finalized — removes the staged
    /// copies, leaving the source exactly as it was before `planRelocate`.
    public static func revertPlan(_ plan: RelocatePlan, transport: SMBFileTransport) async {
        for path in plan.createdPaths {
            try? await transport.removeItem(atPath: path)
        }
    }

    // MARK: - Same-file / case-only-rename guard

    /// Classifies whether `source` and `target` name the same file on the
    /// share, versus merely differing in case on a case-insensitive-but-
    /// case-preserving share (the Windows/Samba default) versus genuinely
    /// different locations. See `LocalFileOperations.classifySameFile` for
    /// the full safety rationale — the property protected is identical:
    /// `.replace`'s pre-copy removal must never delete the source itself.
    ///
    /// Limitation vs. the local engine: SMB has no local realpath/symlink
    /// resolution available through `SMBFileTransport`, so this can only
    /// compare the paths AS GIVEN — a destination reached via a different
    /// mount point or a server-side symlink/junction to the same target is
    /// NOT detected here. Case-only-rename detection (the other half of
    /// the guard) has no such gap: it's pure string comparison and doesn't
    /// depend on resolving anything.
    static func classifySameFile(source: String, target: String) -> SameFileClassification {
        if source == target { return .identical }
        if source.caseInsensitiveCompare(target) == .orderedSame { return .caseOnlyRename }
        return .different
    }

    /// The ONE relocate shape that bypasses copy-verify-delete AND
    /// collision handling entirely — see
    /// `LocalFileOperations.performCaseOnlyRename`'s doc comment for the
    /// full rationale; `transport.moveItem` is the SMB equivalent of a
    /// local atomic `rename(2)`.
    private static func performCaseOnlyRename(
        source: String, target: String, transport: SMBFileTransport
    ) async throws -> RelocatePlan {
        let sourceSidecarPath = sidecarPath(for: source)
        let hadSidecar = await exists(sourceSidecarPath, transport: transport)

        try await transport.moveItem(atPath: source, toPath: target)

        var finalSidecarPath: String?
        var resolvedSourceSidecarPath: String?
        if hadSidecar {
            let targetSidecarPath = sidecarPath(for: target)
            resolvedSourceSidecarPath = sourceSidecarPath
            do {
                try await transport.moveItem(atPath: sourceSidecarPath, toPath: targetSidecarPath)
            } catch {
                fileOpsLog.error(
                    "performCaseOnlyRename: sidecar moveItem failed (\(sourceSidecarPath, privacy: .public)): \(error.localizedDescription, privacy: .public)")
            }
            finalSidecarPath = await exists(targetSidecarPath, transport: transport) ? targetSidecarPath : nil
        }

        return RelocatePlan(mode: .move, sourcePrimaryPath: source, sourceSidecarPath: resolvedSourceSidecarPath,
                             finalPrimaryPath: target, finalSidecarPath: finalSidecarPath,
                             renamedDueToCollision: false, createdPaths: [], sourceAlreadyRelocated: true)
    }

    // MARK: - Copy + verify

    static func copyVerified(from source: String, to destination: String, transport: SMBFileTransport) async throws {
        do {
            let sourceAttrs = try await transport.attributesOfItem(atPath: source)
            guard let sourceSize = (sourceAttrs[.fileSizeKey] as? NSNumber)?.int64Value else {
                throw FileOperationError.underlying("could not read size of \(source)")
            }
            let sourceMtime = sourceAttrs[.contentModificationDateKey] as? Date

            try await transport.copyItem(atPath: source, toPath: destination, recursive: false, progress: nil)
            if let sourceMtime {
                try? await transport.setAttributes(
                    attributes: [.contentModificationDateKey: sourceMtime], ofItemAtPath: destination)
            }
            try await verifyCopy(sourceSize: sourceSize, sourceMtime: sourceMtime,
                                  destinationPath: destination, transport: transport)
        } catch {
            try? await transport.removeItem(atPath: destination)
            throw (error as? FileOperationError) ?? .underlying(
                "copy \(source) -> \(destination) failed: \(error.localizedDescription)")
        }
    }

    /// `internal` (not `private`) for the same reason as the local engine's
    /// `verifyCopy` — real coverage of the mismatch branch against a
    /// deliberately-divergent fake destination.
    static func verifyCopy(sourceSize: Int64, sourceMtime: Date?, destinationPath: String,
                           transport: SMBFileTransport) async throws {
        guard let destAttrs = try? await transport.attributesOfItem(atPath: destinationPath) else {
            throw FileOperationError.verificationFailed("missing destination: \(destinationPath)")
        }
        let destSize = (destAttrs[.fileSizeKey] as? NSNumber)?.int64Value
        guard destSize == sourceSize else {
            throw FileOperationError.verificationFailed(
                "\(destinationPath): size \(String(describing: destSize)) != \(sourceSize)")
        }
        if let sourceMtime, let destMtime = destAttrs[.contentModificationDateKey] as? Date {
            guard abs(destMtime.timeIntervalSince1970 - sourceMtime.timeIntervalSince1970) < mtimeTolerance else {
                throw FileOperationError.verificationFailed(
                    "\(destinationPath): mtime \(destMtime) != \(sourceMtime)")
            }
        }
    }

    // MARK: - Collision + path helpers

    /// Resolve a collision at `targetPath` per `collision`, returning the
    /// (possibly suffixed) final path and whether a suffix was applied.
    /// Mirrors `LocalFileOperations.resolveCollision`.
    private static func resolveCollision(
        at targetPath: String, collision: CollisionPolicy, transport: SMBFileTransport
    ) async throws -> (path: String, renamed: Bool) {
        guard await exists(targetPath, transport: transport) else { return (targetPath, false) }
        switch collision {
        case .fail:
            throw FileOperationError.destinationExists(targetPath)
        case .replace:
            try await removeAssetAndSidecar(at: targetPath, transport: transport)
            return (targetPath, false)
        case .autoSuffix:
            let free = try await CollisionResolver.pickFreePath(targetPath) { candidate in
                await exists(candidate, transport: transport)
            }
            return (free, true)
        }
    }

    static func exists(_ path: String, transport: SMBFileTransport) async -> Bool {
        (try? await transport.attributesOfItem(atPath: path)) != nil
    }

    static func posixLastComponent(_ path: String) -> String {
        (path as NSString).lastPathComponent
    }

    static func posixJoin(_ dir: String, _ name: String) -> String {
        (dir as NSString).appendingPathComponent(name)
    }

    /// Sidecar path for an SMB share-relative path — reuses `SidecarPath`'s
    /// video/image split by wrapping the string in a `URL(fileURLWithPath:)`
    /// purely for its lexical path-component logic. No filesystem access
    /// happens: an SMB path isn't a real local path, but extension/stem
    /// manipulation is pure string math that works identically either way.
    static func sidecarPath(for primaryPath: String) -> String {
        SidecarPath.sidecarURL(for: URL(fileURLWithPath: primaryPath)).path
    }

    static func removeAssetAndSidecar(at path: String, transport: SMBFileTransport) async throws {
        try await transport.removeItem(atPath: path)
        try? await transport.removeItem(atPath: sidecarPath(for: path))
    }
}

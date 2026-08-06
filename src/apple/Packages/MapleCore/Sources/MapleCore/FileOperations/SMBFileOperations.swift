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
    /// deleted; the source is untouched no matter how this call ends.
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
        var targetPath = posixJoin(destinationDir, basename)

        // Already exactly where it belongs — nothing to copy, and finalize
        // must never delete the only copy of the file.
        if targetPath == sourcePrimaryPath {
            return RelocatePlan(mode: mode, sourcePrimaryPath: sourcePrimaryPath, sourceSidecarPath: nil,
                                 finalPrimaryPath: sourcePrimaryPath, finalSidecarPath: nil,
                                 renamedDueToCollision: false, createdPaths: [])
        }

        // Best-effort: the destination directory almost always already
        // exists (moving into an existing folder); a genuinely-missing one
        // surfaces for real on the `copyItem` call that follows.
        try? await transport.createDirectory(atPath: destinationDir)

        var renamed = false
        if await exists(targetPath, transport: transport) {
            switch collision {
            case .fail:
                throw FileOperationError.destinationExists(targetPath)
            case .replace:
                try await removeAssetAndSidecar(at: targetPath, transport: transport)
            case .autoSuffix:
                targetPath = try await CollisionResolver.pickFreePath(targetPath) { candidate in
                    await exists(candidate, transport: transport)
                }
                renamed = true
            }
        }

        var createdPaths: [String] = []
        try await copyVerified(from: sourcePrimaryPath, to: targetPath, transport: transport)
        createdPaths.append(targetPath)

        let sourceSidecarPath = sidecarPath(for: sourcePrimaryPath)
        var resolvedSourceSidecarPath: String?
        var finalSidecarPath: String?
        if await exists(sourceSidecarPath, transport: transport) {
            resolvedSourceSidecarPath = sourceSidecarPath
            let sidecarTargetPath = sidecarPath(for: targetPath)
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
                try? await transport.removeItem(atPath: targetPath)
                throw error
            }
            createdPaths.append(sidecarTargetPath)
            finalSidecarPath = sidecarTargetPath
        }

        return RelocatePlan(mode: mode, sourcePrimaryPath: sourcePrimaryPath,
                             sourceSidecarPath: resolvedSourceSidecarPath,
                             finalPrimaryPath: targetPath, finalSidecarPath: finalSidecarPath,
                             renamedDueToCollision: renamed, createdPaths: createdPaths)
    }

    /// Delete the sources (`mode == .move` only) and invalidate the derived
    /// caches at the OLD location. Best-effort, matching the local engine —
    /// a copy-succeeded-but-delete-failed leaves a duplicate, never data
    /// loss. There is no SMB-side `LibraryIndex` equivalent to refresh: the
    /// per-folder cold-open index is a Filesystem-source concept.
    @discardableResult
    public static func finalizeRelocate(_ plan: RelocatePlan, transport: SMBFileTransport) async -> RelocateOutcome {
        let outcome = RelocateOutcome(
            primaryPath: plan.finalPrimaryPath, sidecarPath: plan.finalSidecarPath,
            renamedDueToCollision: plan.renamedDueToCollision,
            sidecarFollowed: plan.finalSidecarPath != nil
        )
        guard !plan.isNoop else { return outcome }

        if plan.mode == .move {
            try? await transport.removeItem(atPath: plan.sourcePrimaryPath)
            if let sourceSidecarPath = plan.sourceSidecarPath {
                try? await transport.removeItem(atPath: sourceSidecarPath)
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

    // MARK: - Path helpers

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

// RelocateTypes.swift — shared vocabulary for the relocate primitive
// (issue #2631), implemented independently by `LocalFileOperations`
// (Filesystem) and `SMBFileOperations` (SMB). Mirrors the 8-step contract in
// docs/superpowers/specs/2026-08-04-file-management-design.md § "Core
// architecture" and the API's `moveBackupAsset` / `planAndPlace` split
// (src/api/src/workers/migration/move-backup-asset.ts,
// restructure-fs.ts) — plan (copy + verify, no deletes) then finalize
// (delete sources, invalidate caches), so a crash between the two leaves the
// original untouched and the operation safe to retry.

import Foundation

// MARK: - RelocateMode

public enum RelocateMode: Sendable, Equatable {
    /// Delete the source (primary + sidecar) once the copy is verified.
    case move
    /// Leave the source in place — the destination is a duplicate.
    case copy
}

// MARK: - CollisionPolicy

/// How to resolve a destination that's already occupied. Mirrors the design
/// doc: auto-suffix for unattended/background operations (migrations,
/// external-reconciliation), the other two for user-initiated operations
/// that have already resolved a Skip/Replace/Keep-Both prompt.
public enum CollisionPolicy: Sendable, Equatable {
    /// Append `.N` before the extension until free — never overwrites.
    /// Matches the API's `pickFreePath` (`src/api/src/fs/trash.ts`).
    case autoSuffix
    /// Fail with `FileOperationError.destinationExists` rather than touch
    /// an existing file. The right default for a user-facing operation that
    /// hasn't asked the user yet.
    case fail
    /// Overwrite the existing destination (primary + its sidecar, if any) —
    /// the user explicitly chose Replace.
    case replace
}

// MARK: - RelocatePlan

/// The result of the copy+verify phase. Carries everything `finalize` (or
/// `revert`) needs; holding no destination information back inside a
/// private/opaque type keeps the crash-safety invariant testable directly —
/// a test can call `planRelocate` alone and assert BOTH the source and the
/// staged copy exist, which is exactly the on-disk state a real crash
/// between `plan` and `finalize` would leave behind.
public struct RelocatePlan: Sendable, Equatable {
    public let mode: RelocateMode
    public let sourcePrimaryPath: String
    public let sourceSidecarPath: String?
    public let finalPrimaryPath: String
    public let finalSidecarPath: String?
    public let renamedDueToCollision: Bool
    /// Paths this planning step created (the staged copies). `revert` (and
    /// a `finalize` that decides not to proceed) removes exactly these,
    /// leaving the source and everything else untouched. Mirrors
    /// `PlacePlan.createdPaths` in `restructure-fs.ts`.
    public let createdPaths: [String]

    public init(mode: RelocateMode, sourcePrimaryPath: String, sourceSidecarPath: String?,
                finalPrimaryPath: String, finalSidecarPath: String?,
                renamedDueToCollision: Bool, createdPaths: [String]) {
        self.mode = mode
        self.sourcePrimaryPath = sourcePrimaryPath
        self.sourceSidecarPath = sourceSidecarPath
        self.finalPrimaryPath = finalPrimaryPath
        self.finalSidecarPath = finalSidecarPath
        self.renamedDueToCollision = renamedDueToCollision
        self.createdPaths = createdPaths
    }

    /// True when the plan is a genuine no-op (destination resolved to the
    /// exact source path — nothing was copied). `finalize` must never
    /// delete the source in this case.
    public var isNoop: Bool { createdPaths.isEmpty && finalPrimaryPath == sourcePrimaryPath }
}

// MARK: - RelocateOutcome

public struct RelocateOutcome: Sendable, Equatable {
    public let primaryPath: String
    public let sidecarPath: String?
    public let renamedDueToCollision: Bool
    public let sidecarFollowed: Bool

    public init(primaryPath: String, sidecarPath: String?,
                renamedDueToCollision: Bool, sidecarFollowed: Bool) {
        self.primaryPath = primaryPath
        self.sidecarPath = sidecarPath
        self.renamedDueToCollision = renamedDueToCollision
        self.sidecarFollowed = sidecarFollowed
    }
}

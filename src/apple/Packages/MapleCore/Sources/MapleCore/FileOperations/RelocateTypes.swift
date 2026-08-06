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
    /// `PlacePlan.createdPaths` in `restructure-fs.ts`. Empty for a
    /// case-only rename (`sourceAlreadyRelocated`) — nothing was COPIED,
    /// the source itself was renamed in place.
    public let createdPaths: [String]
    /// True when `planRelocate` already fully relocated the source itself
    /// — the case-only-rename shape (see `classifySameFile`), performed as
    /// a single atomic `moveItem` because source and target are the SAME
    /// underlying file on a case-insensitive-but-case-preserving
    /// filesystem. `finalize` must NOT attempt to delete
    /// `sourcePrimaryPath` when this is true: on such a filesystem that
    /// path now resolves to the very file that was just renamed.
    public let sourceAlreadyRelocated: Bool

    public init(mode: RelocateMode, sourcePrimaryPath: String, sourceSidecarPath: String?,
                finalPrimaryPath: String, finalSidecarPath: String?,
                renamedDueToCollision: Bool, createdPaths: [String],
                sourceAlreadyRelocated: Bool = false) {
        self.mode = mode
        self.sourcePrimaryPath = sourcePrimaryPath
        self.sourceSidecarPath = sourceSidecarPath
        self.finalPrimaryPath = finalPrimaryPath
        self.finalSidecarPath = finalSidecarPath
        self.renamedDueToCollision = renamedDueToCollision
        self.createdPaths = createdPaths
        self.sourceAlreadyRelocated = sourceAlreadyRelocated
    }

    /// True when `finalize` has nothing left to do — either a case-only
    /// rename already did everything (`sourceAlreadyRelocated`), or
    /// (defensively, for a plan built by hand rather than by
    /// `planRelocate`) nothing was ever staged.
    public var isNoop: Bool { createdPaths.isEmpty }
}

// MARK: - SameFileClassification

/// Classifies whether a relocate's source and (pre-collision-resolution)
/// target name the same on-disk location, versus merely differing in case
/// on a case-insensitive-but-case-preserving filesystem (APFS/SMB default),
/// versus genuinely different locations. `LocalFileOperations` and
/// `SMBFileOperations` each implement their own `classifySameFile` (the
/// Filesystem engine can resolve a symlinked ancestor directory; SMB, with
/// no local realpath, can only compare the given paths) but share this
/// result type and the safety contract it encodes: `.identical` must be
/// refused before any remove/copy runs, `.caseOnlyRename` must be handled
/// as a direct atomic move rather than copy-verify-delete or the collision
/// branch.
public enum SameFileClassification: Sendable, Equatable {
    case different
    case identical
    case caseOnlyRename
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

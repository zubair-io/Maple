// RelocateTypes.cs — shared vocabulary for the relocate primitive (issue
// #2632), used by `LocalFileOperations`. Mirrors the 8-step contract in
// docs/superpowers/specs/2026-08-04-file-management-design.md § "Core
// architecture" and Apple's `RelocateTypes.swift` — plan (copy + verify, no
// deletes) then finalize (delete sources), so a crash between the two leaves
// the original untouched and the operation safe to retry.

using System.Collections.Generic;

namespace Maple.WinUI.Services.FileOperations
{
    public enum RelocateMode
    {
        /// <summary>Delete the source (primary + sidecar) once the copy is verified.</summary>
        Move,
        /// <summary>Leave the source in place — the destination is a duplicate.</summary>
        Copy,
    }

    /// <summary>How to resolve a destination that's already occupied.</summary>
    public enum CollisionPolicy
    {
        /// <summary>Append `.N` before the extension until free — never overwrites.
        /// Matches the API's `pickFreePath` (`src/api/src/fs/trash.ts`).</summary>
        AutoSuffix,
        /// <summary>Fail with <see cref="FileOperationErrorKind.DestinationExists"/>
        /// rather than touch an existing file. The right default for a
        /// user-facing operation that hasn't asked the user yet.</summary>
        Fail,
        /// <summary>Overwrite the existing destination (primary + its sidecar,
        /// if any) — the user explicitly chose Replace.</summary>
        Replace,
    }

    /// <summary>
    /// Classifies whether a relocate's source and (pre-collision-resolution)
    /// target name the same on-disk location, versus merely differing in
    /// case on NTFS (case-insensitive-but-case-preserving, like APFS),
    /// versus genuinely different locations. `.Identical` must be refused
    /// before any remove/copy runs; `.CaseOnlyRename` must be handled as a
    /// direct atomic move rather than copy-verify-delete or the collision
    /// branch. See <see cref="LocalFileOperations.ClassifySameFile"/>.
    /// </summary>
    public enum SameFileClassification
    {
        Different,
        Identical,
        CaseOnlyRename,
    }

    /// <summary>
    /// The result of the copy+verify phase. Carries everything `Finalize`
    /// (or `Revert`) needs — holding no destination information back keeps
    /// the crash-safety invariant directly testable: a test can call
    /// <see cref="LocalFileOperations.PlanRelocateAsync"/> alone and assert
    /// BOTH the source and the staged copy exist, which is exactly the
    /// on-disk state a real crash between plan and finalize would leave
    /// behind.
    /// </summary>
    /// <param name="SourceAlreadyRelocated">True when planning already fully
    /// relocated the source itself — the case-only-rename shape, performed as
    /// a single atomic move because source and target are the SAME
    /// underlying file on a case-insensitive-but-case-preserving filesystem.
    /// `Finalize` must NOT attempt to delete `SourcePrimaryPath` when this is
    /// true: on such a filesystem that path now resolves to the very file
    /// that was just renamed.</param>
    public sealed record RelocatePlan(
        RelocateMode Mode,
        string SourcePrimaryPath,
        string? SourceSidecarPath,
        string FinalPrimaryPath,
        string? FinalSidecarPath,
        bool RenamedDueToCollision,
        IReadOnlyList<string> CreatedPaths,
        bool SourceAlreadyRelocated = false)
    {
        /// <summary>True when `Finalize` has nothing left to do — either a
        /// case-only rename already did everything, or (defensively) nothing
        /// was ever staged.</summary>
        public bool IsNoop => CreatedPaths.Count == 0;
    }

    public sealed record RelocateOutcome(
        string PrimaryPath,
        string? SidecarPath,
        bool RenamedDueToCollision,
        bool SidecarFollowed);
}

// LocalFileOperations.cs — relocate primitive for the local Filesystem/SMB
// source (issue #2632). Copy → verify → sidecar-follow → delete, split into
// `PlanRelocateAsync` (copy + verify, no deletes) and `FinalizeRelocate`
// (delete) so the crash-safety invariant is directly testable: call
// `PlanRelocateAsync` alone and both the source and the staged copy exist on
// disk, which is exactly the state a real crash between the two phases would
// leave behind. See docs/superpowers/specs/2026-08-04-file-management-
// design.md § "Core architecture", and this module's twin ports:
// `src/api/src/fs/relocate.ts` (TS) and `LocalFileOperations.swift` (Apple).
//
// A port of Apple's contract with one deliberate correction: Apple's
// `copyVerified` copies straight to the FINAL destination path, so a hard
// crash mid-copy can leave a truncated file sitting at that final name —
// exactly the crash-window bug the TS implementation's header comment
// documents fixing (copy to a temp sibling, verify, THEN atomically publish
// via rename). This port keeps Apple's split/plan-finalize shape but
// restores the TS temp+rename publish step (`LocalFileOperations.
// CopyVerify.cs`) rather than repeating the regression on a third platform.
//
// Stateless by design (a namespace of static methods, like `SidecarStore`)
// — there is no per-instance state to protect.

using System;
using System.Collections.Generic;
using System.IO;
using System.Threading.Tasks;
using Maple.WinUI.Services;
using Maple.WinUI.Services.Xmp;

namespace Maple.WinUI.Services.FileOperations
{
    public static partial class LocalFileOperations
    {
        // MARK: - Relocate (asset-level: primary + sidecar)

        /// <summary>Convenience: plan then finalize in one call. Most callers
        /// want this; `PlanRelocateAsync`/`FinalizeRelocate` exist separately
        /// for crash-safety testing (see the file header) and so a caller
        /// can inspect a plan before committing to it.</summary>
        public static async Task<RelocateOutcome> RelocateAsync(
            string sourcePrimaryPath,
            string destinationDir,
            string? newBasename,
            RelocateMode mode,
            CollisionPolicy collision = CollisionPolicy.AutoSuffix)
        {
            var plan = await PlanRelocateAsync(sourcePrimaryPath, destinationDir, newBasename, mode, collision)
                .ConfigureAwait(false);
            return FinalizeRelocate(plan);
        }

        /// <summary>
        /// Copy (never move) the primary file — and its `.xmp` sidecar, if
        /// one exists — into <paramref name="destinationDir"/>, verifying
        /// each copy. Nothing is deleted and the source is untouched no
        /// matter how this call ends, including when it throws. The one
        /// exception is a case-only rename (see
        /// <see cref="ClassifySameFile"/>), performed directly here as an
        /// atomic move — there is no meaningful "staged copy" for it.
        /// </summary>
        public static async Task<RelocatePlan> PlanRelocateAsync(
            string sourcePrimaryPath,
            string destinationDir,
            string? newBasename,
            RelocateMode mode,
            CollisionPolicy collision = CollisionPolicy.AutoSuffix)
        {
            if (!File.Exists(sourcePrimaryPath))
                throw new FileOperationException(FileOperationErrorKind.SourceMissing, sourcePrimaryPath);

            var basename = newBasename ?? Path.GetFileName(sourcePrimaryPath);
            var targetPath = Path.Combine(destinationDir, basename);

            switch (ClassifySameFile(sourcePrimaryPath, targetPath))
            {
                case SameFileClassification.Identical:
                    throw new FileOperationException(FileOperationErrorKind.SameFile,
                        $"destination resolves to the same file as the source: {sourcePrimaryPath}");
                case SameFileClassification.CaseOnlyRename:
                    if (mode != RelocateMode.Move)
                        throw new FileOperationException(FileOperationErrorKind.SameFile,
                            "case-only rename target is the same file as the source on a case-insensitive "
                            + $"filesystem — copy is not meaningful: {sourcePrimaryPath}");
                    return PerformCaseOnlyRename(sourcePrimaryPath, targetPath);
            }

            Directory.CreateDirectory(destinationDir);
            var (resolvedTargetPath, renamed) = await ResolveCollisionAsync(targetPath, collision).ConfigureAwait(false);

            var createdPaths = new List<string>();
            CopyVerified(sourcePrimaryPath, resolvedTargetPath);
            createdPaths.Add(resolvedTargetPath);

            var sourceSidecarPath = SidecarStore.SidecarPathFor(sourcePrimaryPath);
            string? usedSourceSidecarPath = null;
            string? finalSidecarPath = null;
            if (File.Exists(sourceSidecarPath))
            {
                usedSourceSidecarPath = sourceSidecarPath;
                var sidecarTargetPath = SidecarStore.SidecarPathFor(resolvedTargetPath);
                try
                {
                    // The primary's target basename was already proven free
                    // (or explicitly replaced) above; an orphan sidecar that
                    // happens to share the DERIVED sidecar name is abandoned
                    // data, not a live asset's — this asset's sidecar
                    // following it is what "the sidecar always follows the
                    // primary" means, so it claims that name the same way
                    // `.Replace` would.
                    if (File.Exists(sidecarTargetPath)) File.Delete(sidecarTargetPath);
                    CopyVerified(sourceSidecarPath, sidecarTargetPath);
                }
                catch
                {
                    // A plan either fully succeeds or leaves NO trace — roll
                    // back the primary copy so a caller that sees this throw
                    // never has to guess what's on disk.
                    TryDelete(resolvedTargetPath);
                    throw;
                }
                createdPaths.Add(sidecarTargetPath);
                finalSidecarPath = sidecarTargetPath;
            }

            return new RelocatePlan(
                mode, sourcePrimaryPath, usedSourceSidecarPath,
                resolvedTargetPath, finalSidecarPath, renamed, createdPaths);
        }

        /// <summary>
        /// Delete the sources (<see cref="RelocateMode.Move"/> only). Every
        /// step here is best-effort: per the design doc, "a copy-succeeded-
        /// but-delete-failed leaves a duplicate, never data loss" — a
        /// failure is logged, never thrown, since the plan already committed
        /// a verified, correct copy at the destination. A no-op for a
        /// case-only rename (<see cref="RelocatePlan.SourceAlreadyRelocated"/>):
        /// that already did everything inside `PlanRelocateAsync`, and
        /// re-touching `SourcePrimaryPath` here would delete the file that
        /// was just renamed (on a case-insensitive filesystem the old-cased
        /// path still resolves to it).
        /// </summary>
        public static RelocateOutcome FinalizeRelocate(RelocatePlan plan)
        {
            var outcome = new RelocateOutcome(
                plan.FinalPrimaryPath, plan.FinalSidecarPath,
                plan.RenamedDueToCollision, plan.FinalSidecarPath != null);

            if (plan.IsNoop || plan.Mode != RelocateMode.Move) return outcome;

            TryDeleteLogged(plan.SourcePrimaryPath, "primary");
            if (plan.SourceSidecarPath != null)
                TryDeleteLogged(plan.SourceSidecarPath, "sidecar");

            return outcome;
        }

        /// <summary>
        /// Undo a plan that will never be finalized — removes the staged
        /// copies, leaving the source (and everything else) exactly as it
        /// was before <see cref="PlanRelocateAsync"/> ran. Not applicable to
        /// a case-only rename (<see cref="RelocatePlan.SourceAlreadyRelocated"/>)
        /// — that has no staged copies to revert.
        /// </summary>
        public static void RevertPlan(RelocatePlan plan)
        {
            foreach (var path in plan.CreatedPaths)
                TryDelete(path);
        }

        // MARK: - Same-file / case-only-rename guard

        /// <summary>
        /// Resolve <paramref name="path"/>'s PARENT directory through any
        /// reparse point (<see cref="Directory.ResolveLinkTarget"/>), then
        /// rejoin the ORIGINAL (unresolved) file name literally. Deliberately
        /// does NOT resolve the full path — see <see cref="ClassifySameFile"/>
        /// for why resolving the file name too would break case-only-rename
        /// detection. Falls back to <see cref="Path.GetFullPath(string)"/>
        /// when the parent doesn't exist, isn't a link, or can't be
        /// inspected.
        /// </summary>
        internal static string CanonicalParent(string path)
        {
            var full = Path.GetFullPath(path);
            var parent = Path.GetDirectoryName(full) ?? Path.GetPathRoot(full) ?? full;
            try
            {
                if (Directory.Exists(parent))
                {
                    var target = Directory.ResolveLinkTarget(parent, returnFinalTarget: true);
                    if (target != null) return target.FullName;
                }
            }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
            return parent;
        }

        /// <summary>
        /// Classifies whether <paramref name="source"/> and
        /// <paramref name="target"/> name the same on-disk location —
        /// directly, or through a symlinked/junction ancestor directory —
        /// versus merely differing in case (a legitimate rename on NTFS,
        /// case-insensitive-but-case-preserving like APFS) versus genuinely
        /// different locations.
        ///
        /// The load-bearing property this protects: a relocate must never
        /// delete the only copy of a file. <see cref="CollisionPolicy.Replace"/>'s
        /// pre-copy removal runs BEFORE the copy — if the destination
        /// resolves to the source (directly, or via a symlinked/junction
        /// alias), that removal deletes the source itself, and the copy that
        /// follows then fails because there's nothing left to read.
        ///
        /// Resolving only the PARENT directory (never the file name) is
        /// deliberate: resolving the FULL path (name included) would, on
        /// resolution of an existing reparse point, potentially fold two
        /// names that differ only in case to the same canonical string —
        /// collapsing a legitimate case-only rename into "same file" and
        /// wrongly refusing it. Comparing parents case-insensitively (NTFS
        /// directories are case-insensitive) while comparing file names
        /// first ordinally, then case-insensitively, keeps the two outcomes
        /// distinct.
        /// </summary>
        internal static SameFileClassification ClassifySameFile(string source, string target)
        {
            var sourceParent = CanonicalParent(source);
            var targetParent = CanonicalParent(target);
            if (!string.Equals(sourceParent, targetParent, StringComparison.OrdinalIgnoreCase))
                return SameFileClassification.Different;

            var sourceName = Path.GetFileName(source);
            var targetName = Path.GetFileName(target);
            if (string.Equals(sourceName, targetName, StringComparison.Ordinal))
                return SameFileClassification.Identical;
            if (string.Equals(sourceName, targetName, StringComparison.OrdinalIgnoreCase))
                return SameFileClassification.CaseOnlyRename;
            return SameFileClassification.Different;
        }

        // MARK: - Shared helpers

        /// <summary>Best-effort delete — swallows the two expected failure
        /// modes (in use / permissions) without logging, for cleanup paths
        /// where the file may legitimately not exist.</summary>
        internal static void TryDelete(string path)
        {
            try
            {
                if (File.Exists(path)) File.Delete(path);
            }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
        }

        /// <summary>Best-effort delete with a diagnostic trace on failure —
        /// used for the delete-of-original step, where a failure is the
        /// accepted "duplicate left on disk, never data loss" outcome but is
        /// still worth surfacing for troubleshooting.</summary>
        private static void TryDeleteLogged(string path, string label)
        {
            try
            {
                File.Delete(path);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                DiagLog.Write(
                    $"[FileOperations] source {label} unlink failed after a verified copy — "
                    + $"a duplicate is left on disk ({path}): {ex.Message}");
            }
        }
    }
}

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
using Maple.WinUI.Generated;
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
            if (newBasename != null) ValidateBareFileName(newBasename);

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
            var sourceSidecarPath = SidecarStore.SidecarPathFor(sourcePrimaryPath);
            var (resolvedTargetPath, renamed) = await ResolveCollisionAsync(targetPath, collision, sourceSidecarPath)
                .ConfigureAwait(false);

            // Every sidecar decision is made before any byte moves (#4758,
            // docs/xmp-canonical-format.md § "Moving, renaming and trashing a
            // photo"): a refusal must leave nothing on disk to roll back.
            var sidecarTargetPath = SidecarStore.SidecarPathFor(resolvedTargetPath);
            var hasSourceSidecar = File.Exists(sourceSidecarPath);
            var sidecarMapsOntoItself = SameSidecarPath(sourceSidecarPath, sidecarTargetPath);
            var destinationSidecarOwned = SidecarStemClaimedBySibling(resolvedTargetPath, sourcePrimaryPath);
            var destinationSidecarOccupied = !sidecarMapsOntoItself && PathOccupied(sidecarTargetPath);
            var joinsCarriedSidecar = hasSourceSidecar && destinationSidecarOccupied
                && SidecarAlreadyCarried(sourceSidecarPath, sidecarTargetPath);
            var replacesDestinationSidecar = destinationSidecarOccupied && !joinsCarriedSidecar;
            if (hasSourceSidecar && replacesDestinationSidecar
                && (collision != CollisionPolicy.Replace || destinationSidecarOwned))
                throw new FileOperationException(FileOperationErrorKind.DestinationExists,
                    $"destination sidecar belongs to another photo: {sidecarTargetPath}");
            var sourceSidecarStays = sidecarMapsOntoItself
                || (hasSourceSidecar && SidecarStemClaimedBySibling(sourcePrimaryPath, resolvedTargetPath));

            var createdPaths = new List<string>();
            CopyVerified(sourcePrimaryPath, resolvedTargetPath);
            createdPaths.Add(resolvedTargetPath);

            string? usedSourceSidecarPath = null;
            string? finalSidecarPath = null;
            if (hasSourceSidecar)
            {
                usedSourceSidecarPath = sourceSidecarPath;
                if (!sidecarMapsOntoItself && !joinsCarriedSidecar)
                {
                    try
                    {
                        // Overwrites only an occupant Replace was cleared to
                        // remove above; anything else at this name fails the
                        // publish instead of being clobbered.
                        CopyVerified(sourceSidecarPath, sidecarTargetPath, overwrite: replacesDestinationSidecar);
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
                }
                finalSidecarPath = sidecarTargetPath;
            }
            else if (collision == CollisionPolicy.Replace && !destinationSidecarOwned)
            {
                // The incoming asset has no sidecar of its own, but `.Replace`
                // means "the destination now reflects EXACTLY the incoming
                // asset" — the PREVIOUS occupant's sidecar must not survive and
                // get misattributed to this one (#2633 parity harness; the TS
                // and Swift twins do the same). A sidecar another same-stem
                // photo there still uses is not stale (#4758). Runs only AFTER
                // the primary was verified and published. Best-effort.
                TryDelete(sidecarTargetPath);
            }

            return new RelocatePlan(
                mode, sourcePrimaryPath, usedSourceSidecarPath,
                resolvedTargetPath, finalSidecarPath, renamed, createdPaths,
                SourceSidecarStays: sourceSidecarStays);
        }

        /// <summary>
        /// Delete the sources (<see cref="RelocateMode.Move"/> only). Every
        /// step here is best-effort: per the design doc, "a copy-succeeded-
        /// but-delete-failed leaves a duplicate, never data loss" — a
        /// failure is logged, never thrown, since the plan already committed
        /// a verified, correct copy at the destination. The source-file
        /// deletes are a no-op for a case-only rename
        /// (<see cref="RelocatePlan.SourceAlreadyRelocated"/>): that already
        /// did everything inside `PlanRelocateAsync`, and re-touching
        /// `SourcePrimaryPath` here would delete the file that was just
        /// renamed (on a case-insensitive filesystem the old-cased path
        /// still resolves to it).
        ///
        /// Every Move also reclaims the old identity's shared thumbnail cache
        /// entries (`&lt;old parent&gt;\.maple\thumbs\…`, #2710/#3083/#4793)
        /// through <see cref="ReclaimSharedThumbs"/>: the entry is keyed by
        /// filename inside the old folder, so nothing will ever resolve it
        /// again once the source leaves. Apple's `invalidateDerivedCaches`
        /// semantics — synchronous and best-effort on the relocate path.
        /// </summary>
        public static RelocateOutcome FinalizeRelocate(RelocatePlan plan)
        {
            var outcome = new RelocateOutcome(
                plan.FinalPrimaryPath, plan.FinalSidecarPath,
                plan.RenamedDueToCollision, plan.FinalSidecarPath != null);

            if (plan.Mode != RelocateMode.Move) return outcome;

            ReclaimSharedThumbs(plan.SourcePrimaryPath, plan.FinalPrimaryPath);

            if (plan.IsNoop) return outcome;

            TryDeleteLogged(plan.SourcePrimaryPath, "primary");
            if (plan.SourceSidecarPath != null && !plan.SourceSidecarStays)
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
        /// destroy the only copy of a file. If the destination resolves to
        /// the source (directly, or via a symlinked/junction alias), copying
        /// the source onto itself and then, in move mode, deleting "the
        /// source" would delete the only remaining copy — this guard refuses
        /// that combination outright, before any copy or publish runs.
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

        // MARK: - Bare file-name validation (destination basenames and
        // folder names — anywhere a caller hands this module a name rather
        // than a full path)

        /// <summary>
        /// Validates that <paramref name="name"/> is a bare file/folder name
        /// this module is safe to <see cref="Path.Combine(string, string)"/>
        /// into a destination directory — never a relative or absolute path
        /// of its own. Without this, a caller-supplied rename target like
        /// `..\..\escaped.dng` combines with the destination directory and
        /// relocates OUTSIDE it — a directory-traversal escape, not a
        /// rename. Also rejects the reserved MS-DOS device names, which are
        /// invalid file/folder names on Windows regardless of extension.
        /// </summary>
        internal static void ValidateBareFileName(string name)
        {
            if (string.IsNullOrEmpty(name) || name.Contains('/') || name.Contains('\\') ||
                name.StartsWith('.') || name.EndsWith('.') || name.EndsWith(' '))
                throw new FileOperationException(FileOperationErrorKind.InvalidDestination,
                    $"not a valid bare file name: {name}");

            // raw-core checks the stem before the FIRST extension, so
            // CON.tar.gz is just as reserved as CON.txt, on every host.
            var stem = name.Split('.')[0];
            if (FilenameVocabulary.ReservedWindowsNames.Contains(stem))
                throw new FileOperationException(FileOperationErrorKind.InvalidDestination,
                    $"'{stem}' is a reserved Windows device name: {name}");
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

        /// <summary>Reclaims the old identity's shared thumbnail entries
        /// after a move or rename: the legacy hashed `.v25` file, and the
        /// filename-keyed entry. A case-only rename keeps its entry and only
        /// fixes the casing, so case-sensitive readers of the share still
        /// resolve it.</summary>
        internal static void ReclaimSharedThumbs(string oldAssetPath, string newAssetPath)
        {
            var oldThumbPath = ThumbCachePaths.SharedThumbPathFor(oldAssetPath);
            var newThumbPath = ThumbCachePaths.SharedThumbPathFor(newAssetPath);
            if (string.Equals(oldThumbPath, newThumbPath, StringComparison.Ordinal)) return;
            TryDelete(ThumbCachePaths.LegacySharedThumbPathFor(oldAssetPath));
            if (!string.Equals(oldThumbPath, newThumbPath, StringComparison.OrdinalIgnoreCase))
            {
                TryDelete(oldThumbPath);
                return;
            }
            try
            {
                if (File.Exists(oldThumbPath)) File.Move(oldThumbPath, newThumbPath);
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

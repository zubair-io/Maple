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
                    // No pre-delete of any occupant at `sidecarTargetPath` —
                    // same "delete-then-hope" hazard `ResolveCollisionAsync`
                    // documents avoiding for the primary. `CopyVerified`
                    // publishes via a verified temp-then-atomic-`File.Move`
                    // (`overwrite: true`), which replaces whatever's there
                    // (a stale orphan sidecar, or the destination's old
                    // sidecar under `.Replace`) in one step, only after the
                    // new sidecar is fully copied and verified.
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
            else if (collision == CollisionPolicy.Replace)
            {
                // The incoming asset has no sidecar of its own, but `.Replace`
                // means "the destination now reflects EXACTLY the incoming
                // asset" — the PREVIOUS occupant's sidecar must not survive and
                // get misattributed to this one, silently handing the new photo
                // the old photo's edits. Found by the #2633 parity harness on
                // its first Windows run; the TS and Swift twins already do this
                // (see `relocate.ts`'s matching comment).
                //
                // Safe here, unlike a pre-copy delete: this only runs AFTER the
                // primary above was verified and published, so a copy failure
                // can never reach this point. Best-effort, like every other
                // sidecar cleanup path.
                TryDelete(SidecarStore.SidecarPathFor(resolvedTargetPath));
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
        /// a verified, correct copy at the destination. The source-file
        /// deletes are a no-op for a case-only rename
        /// (<see cref="RelocatePlan.SourceAlreadyRelocated"/>): that already
        /// did everything inside `PlanRelocateAsync`, and re-touching
        /// `SourcePrimaryPath` here would delete the file that was just
        /// renamed (on a case-insensitive filesystem the old-cased path
        /// still resolves to it).
        ///
        /// Every Move — the case-only rename included, since the basename
        /// hash is case-sensitive — also reclaims the old identity's shared
        /// thumbnail cache entry (`&lt;old parent&gt;\.maple\thumbs\…`,
        /// #2710/#3083): the entry is keyed by basename inside the old
        /// folder, so nothing will ever resolve it again once the source
        /// leaves. Apple's `invalidateDerivedCaches` semantics — a
        /// synchronous, best-effort delete on the relocate path itself.
        /// </summary>
        public static RelocateOutcome FinalizeRelocate(RelocatePlan plan)
        {
            var outcome = new RelocateOutcome(
                plan.FinalPrimaryPath, plan.FinalSidecarPath,
                plan.RenamedDueToCollision, plan.FinalSidecarPath != null);

            if (plan.Mode != RelocateMode.Move) return outcome;

            var oldThumbPath = ThumbCachePaths.SharedThumbPathFor(plan.SourcePrimaryPath);
            if (!string.Equals(oldThumbPath, ThumbCachePaths.SharedThumbPathFor(plan.FinalPrimaryPath),
                    StringComparison.OrdinalIgnoreCase))
                TryDelete(oldThumbPath);

            if (plan.IsNoop) return outcome;

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

        /// <summary>Reserved MS-DOS device names — invalid as a file OR
        /// folder base name (extension-insensitive: `NUL.txt` is just as
        /// reserved as `NUL`) anywhere on an NTFS/FAT volume, regardless of
        /// directory.</summary>
        private static readonly HashSet<string> ReservedDeviceNames = new(StringComparer.OrdinalIgnoreCase)
        {
            "CON", "PRN", "AUX", "NUL",
            "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
            "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
        };

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
            if (string.IsNullOrEmpty(name) || Path.GetFileName(name) != name)
                throw new FileOperationException(FileOperationErrorKind.InvalidDestination,
                    $"not a valid bare file name: {name}");

            var stem = Path.GetFileNameWithoutExtension(name);
            if (ReservedDeviceNames.Contains(stem))
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

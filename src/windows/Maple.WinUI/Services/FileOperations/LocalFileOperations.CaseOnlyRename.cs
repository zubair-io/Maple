// LocalFileOperations.CaseOnlyRename.cs — the ONE relocate shape that
// bypasses copy-verify-delete AND collision handling entirely (issue #2632).
//
// NTFS is case-insensitive-but-case-preserving by default, exactly like
// APFS: a same-parent rename that differs only in case (`img.cr3` →
// `IMG.CR3`) targets the SAME underlying file. `File.Move` — a single
// `MoveFileEx` rename — is what Explorer itself uses to update just the
// stored casing; a copy would copy the file onto itself, and
// `File.Exists`-keyed collision handling would treat the source as
// "occupying" its own destination.

using System.IO;
using Maple.WinUI.Services;
using Maple.WinUI.Services.Xmp;

namespace Maple.WinUI.Services.FileOperations
{
    public static partial class LocalFileOperations
    {
        /// <summary>
        /// Performs the case-only rename directly (no staged copy — see
        /// <see cref="RelocatePlan.SourceAlreadyRelocated"/>). Throws
        /// (leaving the source untouched — `File.Move` either fully succeeds
        /// or doesn't touch anything) if the rename itself fails, e.g. a
        /// sharing violation; a failed rename is a genuine failure the
        /// caller must see, not a silent no-op.
        /// </summary>
        private static RelocatePlan PerformCaseOnlyRename(string source, string target)
        {
            var sourceSidecarPath = SidecarStore.SidecarPathFor(source);
            var hadSidecar = File.Exists(sourceSidecarPath);

            File.Move(source, target);

            string? finalSidecarPath = null;
            string? usedSourceSidecarPath = null;
            if (hadSidecar)
            {
                var targetSidecarPath = SidecarStore.SidecarPathFor(target);
                usedSourceSidecarPath = sourceSidecarPath;
                try
                {
                    File.Move(sourceSidecarPath, targetSidecarPath);
                }
                catch (System.Exception ex) when (ex is IOException or UnauthorizedAccessException)
                {
                    // Best-effort, matching the primary rename's "already
                    // complete and safe" precedent — the primary move above
                    // has no partial state to revert, so a sidecar failure
                    // doesn't unwind it; the original sidecar is left in
                    // place.
                    DiagLog.Write(
                        $"[FileOperations] case-only-rename sidecar move failed ({sourceSidecarPath}): {ex.Message}");
                }
                finalSidecarPath = File.Exists(targetSidecarPath) ? targetSidecarPath : null;
            }

            return new RelocatePlan(
                RelocateMode.Move, source, usedSourceSidecarPath,
                target, finalSidecarPath, RenamedDueToCollision: false,
                CreatedPaths: System.Array.Empty<string>(), SourceAlreadyRelocated: true);
        }
    }
}

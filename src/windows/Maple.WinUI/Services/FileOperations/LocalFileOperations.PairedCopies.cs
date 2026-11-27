// A photo's conflict and workflow edit copies travel with it into and out of
// `.maple/trash` (#6133), as on the server and in Apple's restore; ordinary
// moves, renames and copies carry the canonical sidecar alone. Pairing is
// `PairedSidecarNames`; this file decides which paired names are really the
// photo's, and moves them through the same copy-verify-then-delete plan.

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Maple.WinUI.Services.Xmp;

namespace Maple.WinUI.Services.FileOperations
{
    internal enum PairedCopyCarry { None, IntoTrash, OutOfTrash }

    /// <param name="Carriable">Copies that move with the photo.</param>
    /// <param name="Stranded">Paired files that cannot be carried (a link, a file
    /// that cannot be inspected or vanished): they stay where they are.</param>
    internal sealed record PairedCopyScan(IReadOnlyList<string> Carriable, IReadOnlyList<string> Stranded)
    {
        public static readonly PairedCopyScan None = new(Array.Empty<string>(), Array.Empty<string>());
    }

    /// <summary>The two folders one relocate plan reads, each listed once.</summary>
    internal sealed record RelocateFolders(FolderListing Source, FolderListing Destination, PairedCopyScan Paired)
    {
        public static RelocateFolders Open(string sourcePrimaryPath, string destinationDir, PairedCopyCarry carry)
        {
            var source = new FolderListing(Path.GetDirectoryName(Path.GetFullPath(sourcePrimaryPath)) ?? string.Empty);
            var paired = carry == PairedCopyCarry.None
                ? PairedCopyScan.None
                : LocalFileOperations.ScanPairedCopies(sourcePrimaryPath, source);
            if (carry == PairedCopyCarry.OutOfTrash) LocalFileOperations.ThrowIfRestoreWouldStrand(paired);
            return new RelocateFolders(source, new FolderListing(Path.GetFullPath(destinationDir)), paired);
        }
    }

    public static partial class LocalFileOperations
    {
        /// <summary>The paired names in <paramref name="names"/> that belong to
        /// <paramref name="primaryName"/> and are not its canonical sidecar. A name
        /// that is another media file's own sidecar (`photo (conflict from
        /// Mac).xmp` beside `photo (conflict from Mac).dng`) is that photo's, and
        /// where the folder keeps case apart the stem must match exactly.</summary>
        internal static IReadOnlyList<string> PairedCopyNames(
            IReadOnlyCollection<string> names, string primaryName, bool foldsCase)
        {
            var canonical = SidecarStore.SidecarPathFor(primaryName);
            var stem = SidecarBase(primaryName);
            var ownedByOtherPhotos = names
                .Where(name => IsMediaFile(name) && !string.Equals(name, primaryName, StringComparison.Ordinal))
                .Select(name => SidecarStore.SidecarPathFor(name))
                .ToHashSet(StringComparer.OrdinalIgnoreCase);
            return PairedSidecarNames(names, primaryName)
                .Where(name => !string.Equals(name, canonical, StringComparison.OrdinalIgnoreCase))
                .Where(name => foldsCase || name.StartsWith(stem, StringComparison.Ordinal))
                .Where(name => !ownedByOtherPhotos.Contains(name))
                .OrderBy(name => name, StringComparer.Ordinal)
                .ToList();
        }

        internal static PairedCopyScan ScanPairedCopies(string primaryPath, FolderListing listing)
        {
            var name = Path.GetFileName(primaryPath);
            if (!IsMediaFile(name)) return PairedCopyScan.None;
            var inspected = PairedCopyNames(listing.FileNames, name, listing.FoldsCase)
                .Select(copy => Path.Combine(listing.Directory, copy))
                .ToLookup(CanBeCarried);
            return new PairedCopyScan(inspected[true].ToList(), inspected[false].ToList());
        }

        private static bool CanBeCarried(string path)
        {
            try
            {
                var info = new FileInfo(path);
                if (info.Exists && info.LinkTarget == null) return true;
                DiagLog.Write(info.Exists
                    ? $"[FileOperations] edit file is a link, it is not carried: {path}"
                    : $"[FileOperations] edit file is gone or not a file, it is not carried: {path}");
                return false;
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                DiagLog.Write($"[FileOperations] edit file could not be inspected, it is not carried ({path}): {ex.Message}");
                return false;
            }
        }

        /// <summary>A restore that cannot bring every paired file back would leave
        /// the rest in the trash, where nothing lists it: it refuses before any
        /// byte moves.</summary>
        internal static void ThrowIfRestoreWouldStrand(PairedCopyScan scan)
        {
            if (scan.Stranded.Count == 0) return;
            throw new FileOperationException(FileOperationErrorKind.Underlying,
                "These edit files in the trash cannot be restored with their photo, so nothing was restored: "
                + string.Join(", ", scan.Stranded.Select(Path.GetFileName)));
        }

        internal static void RejectPairedCopiesWithReplace(PairedCopyCarry carry, CollisionPolicy collision)
        {
            if (carry != PairedCopyCarry.None && collision == CollisionPolicy.Replace)
                throw new ArgumentException("Edit copies travel only with a policy that never replaces.", nameof(collision));
        }

        /// <summary>The copy's name once its photo is named
        /// <paramref name="targetPrimaryPath"/>: the new stem, then whatever
        /// followed the old stem (the base swap the server and Apple make).</summary>
        internal static string PairedCopyTarget(string copyPath, string sourcePrimaryPath, string targetPrimaryPath)
        {
            var oldStemLength = SidecarBase(Path.GetFileName(sourcePrimaryPath)).Length;
            var renamed = SidecarBase(Path.GetFileName(targetPrimaryPath)) + Path.GetFileName(copyPath)[oldStemLength..];
            return Path.Combine(Path.GetDirectoryName(targetPrimaryPath) ?? string.Empty, renamed);
        }

        private static IReadOnlyList<PairedCopy> PlanPairedCopies(
            PairedCopyScan scan, string sourcePrimaryPath, string targetPrimaryPath) =>
            scan.Carriable
                .Select(copy => new PairedCopy(copy, PairedCopyTarget(copy, sourcePrimaryPath, targetPrimaryPath)))
                .Where(copy => !SameSidecarPath(copy.Source, copy.Target))
                .ToList();

        /// <summary>True when the destination holds an edit file the photo would
        /// adopt at <paramref name="candidatePrimaryPath"/> that is not its own
        /// byte-identical copy. The canonical sidecar counts only when asked: the
        /// relocate plan decides that one itself.</summary>
        internal static bool AdoptableNameHeldByOther(
            PairedCopyScan scan, string sourcePrimaryPath, string candidatePrimaryPath,
            IReadOnlyList<string> destinationNames, bool includeCanonical)
        {
            var directory = Path.GetDirectoryName(candidatePrimaryPath) ?? string.Empty;
            var canonicalName = Path.GetFileName(SidecarStore.SidecarPathFor(candidatePrimaryPath));
            if (CopyLandsOnAnotherPhotosSidecar(scan, sourcePrimaryPath, candidatePrimaryPath, destinationNames))
                return true;
            var ownTargets = scan.Carriable
                .Select(copy => (Copy: copy, Name: Path.GetFileName(PairedCopyTarget(copy, sourcePrimaryPath, candidatePrimaryPath))))
                .ToList();
            return PairedSidecarNames(destinationNames, Path.GetFileName(candidatePrimaryPath)).Any(name =>
            {
                var occupant = Path.Combine(directory, name);
                if (string.Equals(name, canonicalName, StringComparison.OrdinalIgnoreCase))
                    return includeCanonical
                        && !SidecarAlreadyCarried(SidecarStore.SidecarPathFor(sourcePrimaryPath), occupant);
                return !ownTargets.Any(own =>
                    string.Equals(own.Name, name, StringComparison.OrdinalIgnoreCase) && FilesIdentical(own.Copy, occupant));
            });
        }

        /// <summary>True when a copy would be published under the canonical (or
        /// full-name) sidecar name of another media file already at the
        /// destination: that photo would read, and later rewrite, the copy.</summary>
        internal static bool CopyLandsOnAnotherPhotosSidecar(
            PairedCopyScan scan, string sourcePrimaryPath, string candidatePrimaryPath,
            IReadOnlyList<string> destinationNames)
        {
            var sidecarsOfOthers = destinationNames
                .Where(IsMediaFile)
                .Select(name => SidecarStore.SidecarPathFor(name))
                .ToHashSet(StringComparer.OrdinalIgnoreCase);
            return scan.Carriable.Any(copy => sidecarsOfOthers.Contains(
                Path.GetFileName(PairedCopyTarget(copy, sourcePrimaryPath, candidatePrimaryPath))));
        }

        /// <summary>Equal size, then equal bytes read as a stream: a file of any
        /// size compares, and one that cannot be read is never taken as identical.</summary>
        internal static bool FilesIdentical(string first, string second)
        {
            try
            {
                var (a, b) = (new FileInfo(first), new FileInfo(second));
                if (!a.Exists || !b.Exists || a.Length != b.Length) return false;
                using var streamA = new FileStream(first, FileMode.Open, FileAccess.Read, FileShare.Read);
                using var streamB = new FileStream(second, FileMode.Open, FileAccess.Read, FileShare.Read);
                var (bufferA, bufferB) = (new byte[81920], new byte[81920]);
                while (true)
                {
                    var read = streamA.ReadAtLeast(bufferA, bufferA.Length, throwOnEndOfStream: false);
                    if (read != streamB.ReadAtLeast(bufferB, bufferB.Length, throwOnEndOfStream: false)
                        || !bufferA.AsSpan(0, read).SequenceEqual(bufferB.AsSpan(0, read)))
                        return false;
                    if (read == 0) return true;
                }
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                return false;
            }
        }

        /// <summary>Copies and verifies each edit copy under an exclusive claim,
        /// joining a target that already holds identical bytes. A failure removes
        /// only the paths this plan created (the photo and what it carried before,
        /// never a joined file) and rethrows, so the source side is as it was.</summary>
        private static void PublishPairedCopies(IReadOnlyList<PairedCopy> copies, List<string> createdPaths)
        {
            try
            {
                foreach (var copy in copies.Where(copy => !(PathOccupied(copy.Target) && FilesIdentical(copy.Source, copy.Target))))
                {
                    CopyVerified(copy.Source, copy.Target, overwrite: false);
                    createdPaths.Add(copy.Target);
                }
            }
            catch
            {
                foreach (var created in createdPaths) TryDelete(created);
                throw;
            }
        }
    }
}

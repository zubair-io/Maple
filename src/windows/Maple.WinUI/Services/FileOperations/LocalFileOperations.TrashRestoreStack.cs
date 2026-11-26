using System;
using Maple.WinUI.Generated;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Maple.WinUI.Services.Xmp;

namespace Maple.WinUI.Services.FileOperations
{
    public static partial class LocalFileOperations
    {
        /// <summary>The other half of a RAW+JPEG pair still sitting in
        /// `.maple/trash` beside <paramref name="trashPath"/>, or null. The
        /// two must read one sidecar (the fold's pairing decision) and have
        /// come from the same folder under the same stem, so a JPEG trashed
        /// elsewhere is never taken for this RAW's.</summary>
        public static string? TrashedCompanionOf(string trashPath, string libraryRoot)
        {
            var dir = Path.GetDirectoryName(trashPath);
            var name = Path.GetFileName(trashPath);
            if (dir == null || !Directory.Exists(dir)) return null;
            var pairs = RawJpegPairing.LocalPairs(Directory.EnumerateFiles(dir));
            var companion = RawJpegPairing.IsRaw(trashPath)
                ? pairs.FirstOrDefault(pair => Path.GetFileName(pair.Key) == name).Value
                : pairs.FirstOrDefault(pair => Path.GetFileName(pair.Value) == name).Key;
            return companion != null && CameFromOneFolderAndStem(trashPath, companion, libraryRoot)
                ? companion
                : null;
        }

        private static bool CameFromOneFolderAndStem(string trashA, string trashB, string libraryRoot)
        {
            var (a, b) = (ComputeOriginalRelativePath(trashA, libraryRoot), ComputeOriginalRelativePath(trashB, libraryRoot));
            return string.Equals(Path.GetDirectoryName(a), Path.GetDirectoryName(b), StringComparison.OrdinalIgnoreCase)
                && RawJpegPairing.Stem(a) == RawJpegPairing.Stem(b);
        }

        private static async Task<RelocateOutcome> RestoreStackFromMapleTrashAsync(
            string requestedTrashPath, string companionTrashPath, string libraryRoot)
        {
            var (rawTrash, jpegTrash) = RawJpegPairing.IsRaw(requestedTrashPath)
                ? (requestedTrashPath, companionTrashPath)
                : (companionTrashPath, requestedTrashPath);
            var rawTarget = ResolveRestoreTargetPath(ComputeOriginalRelativePath(rawTrash, libraryRoot), libraryRoot);
            var jpegTarget = ResolveRestoreTargetPath(ComputeOriginalRelativePath(jpegTrash, libraryRoot), libraryRoot);
            var destinationDir = Path.GetDirectoryName(rawTarget) ?? libraryRoot;
            var rawName = PickFreeRestoredStackBasename(
                destinationDir, Path.GetFileName(rawTarget), Path.GetFileName(jpegTarget));

            var outcome = await RelocateStackAsync(
                rawTrash, jpegTrash, destinationDir, rawName, RelocateMode.Move, CollisionPolicy.Fail)
                .ConfigureAwait(false);
            TryDelete(OriginalPathMarkerFor(rawTrash));
            TryDelete(OriginalPathMarkerFor(jpegTrash));
            return requestedTrashPath == rawTrash
                ? outcome
                : outcome with { PrimaryPath = outcome.CompanionPath!, CompanionPath = outcome.PrimaryPath };
        }

        private static string PickFreeRestoredStackBasename(string destinationDir, string rawName, string jpegName)
        {
            var extension = Path.GetExtension(rawName);
            var stem = rawName[..^extension.Length];

            bool Free(string candidateRawName)
            {
                var candidateJpegName = RawJpegPairing.CompanionFileName(jpegName, rawName, candidateRawName);
                var raw = Path.Combine(destinationDir, candidateRawName);
                return !PathOccupied(raw)
                    && !PathOccupied(Path.Combine(destinationDir, candidateJpegName))
                    && !PathOccupied(SidecarStore.SidecarPathFor(raw));
            }

            if (Free(rawName)) return rawName;
            var first = $"{stem}{FilenameVocabulary.RestoreCollisionSuffix}{extension}";
            if (Free(first)) return first;
            for (var n = 1; n <= CollisionResolver.MaxAttempts; n++)
            {
                var candidate = $"{stem}{FilenameVocabulary.RestoreCollisionSuffix}.{n}{extension}";
                if (Free(candidate)) return candidate;
            }
            throw new FileOperationException(FileOperationErrorKind.Underlying,
                $"exceeded {CollisionResolver.MaxAttempts} candidate names restoring {rawName}");
        }
    }
}

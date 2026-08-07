// LocalFileOperations.CopyVerify.cs — copy + verify + atomic publish (issue
// #2632). Copies to a TEMP sibling of the destination, verifies, then
// publishes via `File.Move` — never a direct copy onto the final name. This
// is the crash-safety correction called out in `LocalFileOperations.cs`'s
// header: a straight `File.Copy` onto the final path can leave a truncated
// file sitting at the real destination if the process dies mid-copy; the
// temp+rename publish (matching `src/api/src/fs/relocate.ts`'s
// `copyVerifiedIntoPlace`) means the final path either has nothing, or has
// the fully-verified file — never a partial one.

using System;
using System.IO;

namespace Maple.WinUI.Services.FileOperations
{
    public static partial class LocalFileOperations
    {
        /// <summary>Tolerance for the post-copy mtime check — a round-trip
        /// through `File.SetLastWriteTimeUtc` and the filesystem's own clock
        /// precision doesn't guarantee exact equality even for a
        /// byte-perfect copy.</summary>
        internal static readonly TimeSpan MtimeTolerance = TimeSpan.FromSeconds(2);

        /// <summary>`.tmp.` must appear in the file name — a convention any
        /// future mirror/replication watcher can use to recognise (and skip
        /// replicating) this module's temp-then-publish idiom, matching
        /// `fs/relocate.ts`'s `tempPathFor`.</summary>
        private static string TempPathFor(string finalDestination) =>
            $"{finalDestination}.tmp.{Environment.ProcessId}-{Guid.NewGuid():N}";

        /// <summary>
        /// Copy <paramref name="source"/> to <paramref name="destination"/>
        /// via a verified temp-then-publish sequence: copy to a temp sibling
        /// of the destination, preserve the source's mtime (a pure
        /// rename/move must not invalidate an mtime-keyed cache), verify,
        /// then atomically publish via `File.Move` (a same-volume rename,
        /// never a byte-for-byte second write). On any failure the temp file
        /// is removed and the error propagates; neither `source` nor any
        /// prior occupant of `destination` is ever touched.
        /// </summary>
        internal static void CopyVerified(string source, string destination)
        {
            var sourceInfo = new FileInfo(source);
            if (!sourceInfo.Exists)
                throw new FileOperationException(FileOperationErrorKind.SourceMissing, source);

            var sourceSize = sourceInfo.Length;
            var sourceMtimeUtc = sourceInfo.LastWriteTimeUtc;
            var tmp = TempPathFor(destination);

            try
            {
                File.Copy(source, tmp, overwrite: false);
                // Deliberately NOT swallowed: if this throws (e.g. an
                // UnauthorizedAccessException on the freshly-written temp
                // file), letting it propagate to the outer catch reports the
                // REAL cause. Swallowing it here used to mean `VerifyCopy`
                // failed two lines later on a stale-mtime mismatch instead,
                // masking the actual error behind a misleading
                // `VerificationFailed`.
                File.SetLastWriteTimeUtc(tmp, sourceMtimeUtc);

                VerifyCopy(sourceSize, sourceMtimeUtc, tmp);

                File.Move(tmp, destination, overwrite: true);
            }
            catch (Exception ex)
            {
                TryDelete(tmp);
                if (ex is FileOperationException) throw;
                throw new FileOperationException(
                    FileOperationErrorKind.Underlying,
                    $"copy {source} -> {destination} failed: {ex.Message}", ex);
            }
        }

        /// <summary>
        /// The verification step in isolation — `internal` (not `private`)
        /// so tests can drive the mismatch branch directly against real,
        /// deliberately-divergent files on disk. This boundary only fires in
        /// production if the temp file changes between the copy and this
        /// check (a second writer racing the same temp name, which its
        /// random suffix makes vanishingly unlikely) — real logic that
        /// deserves real coverage even though it's impractical to provoke
        /// end-to-end.
        /// </summary>
        internal static void VerifyCopy(long sourceSize, DateTime sourceMtimeUtc, string destinationPath)
        {
            if (!File.Exists(destinationPath))
                throw new FileOperationException(FileOperationErrorKind.VerificationFailed,
                    $"missing destination: {destinationPath}");

            var destInfo = new FileInfo(destinationPath);
            if (destInfo.Length != sourceSize)
                throw new FileOperationException(FileOperationErrorKind.VerificationFailed,
                    $"{destinationPath}: size {destInfo.Length} != {sourceSize}");

            var delta = destInfo.LastWriteTimeUtc - sourceMtimeUtc;
            if (delta.Duration() > MtimeTolerance)
                throw new FileOperationException(FileOperationErrorKind.VerificationFailed,
                    $"{destinationPath}: mtime {destInfo.LastWriteTimeUtc:o} != {sourceMtimeUtc:o}");
        }
    }
}

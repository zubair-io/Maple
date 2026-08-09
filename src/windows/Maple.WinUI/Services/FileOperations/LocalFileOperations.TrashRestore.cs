// LocalFileOperations.TrashRestore.cs — restore out of `.maple/trash/<rel>`
// back to an asset's original location (#2654 UI; #2632 laid the trash-IN
// half only, with no restore counterpart). Windows has no OS-level way to
// restore FROM the Recycle Bin through this module — a Recycle Bin item
// restores through Explorer, never here (see LocalFileOperations.Trash.cs's
// header) — so this file exists purely for the `.maple/trash` fallback path
// (SMB, or any local-fixed-drive delete where the Recycle Bin call itself
// failed).
//
// Mirrors the API's `moveOutOfTrash` (`src/api/src/fs/trash.ts`): the
// original relative path is recovered by inverting
// `TrashPaths.TrashDestinationDir`'s path math (trash preserves relative
// directory structure so restore can reconstruct it), and a destination
// that's already occupied gets a `.restored[.N]` suffix — the same
// intentionally different, human-legible naming `pickFreeRestoredPath`
// established server-side — rather than the generic `.N` CollisionResolver
// uses elsewhere in this module.

using System;
using System.IO;
using System.Threading.Tasks;

namespace Maple.WinUI.Services.FileOperations
{
    public static partial class LocalFileOperations
    {
        /// <summary>Restore <paramref name="trashPrimaryPath"/> (and its
        /// paired sidecar, if any — followed automatically by
        /// <see cref="RelocateAsync"/>, the same way every other relocate in
        /// this module follows a sidecar) from `.maple/trash/&lt;rel&gt;`
        /// back to its original location under <paramref name="libraryRoot"/>.
        /// The destination directory is created if the original folder no
        /// longer exists (e.g. the user deleted an otherwise-now-empty
        /// folder after trashing its last photo).</summary>
        public static async Task<RelocateOutcome> RestoreFromMapleTrashAsync(
            string trashPrimaryPath, string libraryRoot)
        {
            var relativePath = ComputeOriginalRelativePath(trashPrimaryPath, libraryRoot);
            var targetPath = Path.Combine(libraryRoot, relativePath);
            var destinationDir = Path.GetDirectoryName(targetPath) ?? libraryRoot;
            var basename = Path.GetFileName(targetPath);

            var occupied = File.Exists(targetPath) || Directory.Exists(targetPath);
            var finalBasename = occupied ? PickFreeRestoredBasename(destinationDir, basename) : basename;

            // finalBasename is already guaranteed free (either it was free
            // to begin with, or PickFreeRestoredBasename found a free
            // `.restored[.N]` variant) — CollisionPolicy.Replace tells
            // RelocateAsync to use it as-is rather than re-running its own
            // (differently-named) auto-suffix logic on top of a name this
            // method already resolved.
            return await RelocateAsync(trashPrimaryPath, destinationDir, finalBasename,
                RelocateMode.Move, CollisionPolicy.Replace).ConfigureAwait(false);
        }

        /// <summary>Inverts <see cref="TrashPaths.TrashDestinationDir"/>:
        /// given a path inside `&lt;libraryRoot&gt;/.maple/trash/…`, returns
        /// the relative path (directory + filename) it originally occupied
        /// under <paramref name="libraryRoot"/>.</summary>
        internal static string ComputeOriginalRelativePath(string trashItemPath, string libraryRoot)
        {
            var rootFull = TrashPaths.NormalizeDir(Path.GetFullPath(libraryRoot));
            var itemFull = Path.GetFullPath(trashItemPath);
            var trashRoot = TrashPaths.NormalizeDir(Path.Combine(rootFull, ".maple", "trash"));

            var isRoot = string.Equals(itemFull, trashRoot, StringComparison.OrdinalIgnoreCase);
            var isUnderRoot = itemFull.StartsWith(
                trashRoot + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase);
            if (isRoot || !isUnderRoot)
                throw new FileOperationException(FileOperationErrorKind.InvalidDestination,
                    $"{trashItemPath} is not inside the Maple trash for {libraryRoot}");

            return itemFull[(trashRoot.Length + 1)..];
        }

        /// <summary>`&lt;stem&gt;.restored&lt;ext&gt;`, then
        /// `&lt;stem&gt;.restored.N&lt;ext&gt;` — mirrors the API's
        /// `pickFreeRestoredPath` naming exactly, bounded the same way
        /// <see cref="CollisionResolver"/> bounds the generic `.N`
        /// scheme.</summary>
        internal static string PickFreeRestoredBasename(string destinationDir, string basename)
        {
            var ext = Path.GetExtension(basename);
            var stem = ext.Length > 0 ? basename[..^ext.Length] : basename;

            var first = $"{stem}.restored{ext}";
            if (!Occupied(destinationDir, first)) return first;

            for (var n = 1; n <= CollisionResolver.MaxAttempts; n++)
            {
                var candidate = $"{stem}.restored.{n}{ext}";
                if (!Occupied(destinationDir, candidate)) return candidate;
            }

            throw new FileOperationException(FileOperationErrorKind.Underlying,
                $"pickFreeRestoredBasename: exceeded {CollisionResolver.MaxAttempts} candidate paths for {basename}");
        }

        private static bool Occupied(string dir, string basename)
        {
            var candidate = Path.Combine(dir, basename);
            return File.Exists(candidate) || Directory.Exists(candidate);
        }
    }
}

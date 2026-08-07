// TrashPaths.cs — `.maple/trash/<rel>` path computation (issue #2632),
// shared by asset trash (`LocalFileOperations.Trash.cs`) and folder trash
// (`LocalFileOperations.Folders.cs`). Mirrors the API's `computeTrashPath`
// (`src/api/src/fs/trash.ts`) and Apple's `trashDestinationDir`
// (`LocalFileOperations+Trash.swift`): preserves the item's relative
// position under the library root so Restore can reconstruct the original
// tree.

using System.IO;

namespace Maple.WinUI.Services.FileOperations
{
    internal static class TrashPaths
    {
        /// <summary>
        /// `&lt;libraryRoot&gt;/.maple/trash/&lt;relative-parent-directory&gt;`.
        /// Works for both a file and a folder: it only cares about
        /// <paramref name="itemPath"/>'s PARENT directory, so folder-delete
        /// reuses it verbatim to compute where the folder itself should
        /// land.
        /// </summary>
        public static string TrashDestinationDir(string itemPath, string libraryRoot)
        {
            var rootFull = NormalizeDir(Path.GetFullPath(libraryRoot));
            var itemFull = Path.GetFullPath(itemPath);
            var parentFull = NormalizeDir(Path.GetDirectoryName(itemFull) ?? itemFull);

            var isRoot = string.Equals(parentFull, rootFull, System.StringComparison.OrdinalIgnoreCase);
            var isUnderRoot = parentFull.StartsWith(
                rootFull + Path.DirectorySeparatorChar, System.StringComparison.OrdinalIgnoreCase);
            if (!isRoot && !isUnderRoot)
                throw new FileOperationException(FileOperationErrorKind.InvalidDestination,
                    $"{itemPath} is not under library root {libraryRoot}");

            var trashRoot = Path.Combine(libraryRoot, ".maple", "trash");
            if (isRoot) return trashRoot;

            var relSuffix = parentFull[(rootFull.Length + 1)..];
            return Path.Combine(trashRoot, relSuffix);
        }

        internal static string NormalizeDir(string path) =>
            path.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
    }
}

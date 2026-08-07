// LocalFileOperations.Folders.cs — folder CRUD for the local Filesystem/SMB
// source (issue #2632). Unlike an asset relocate, a directory rename/move
// moves no file bytes — it's a single atomic filesystem-level rename, so
// none of these need the copy-verify-delete contract. Mirrors the API's
// `POST /:id/mkdir` / `POST /:id/move` (`src/api/src/routes/folders.ts`) and
// Apple's `LocalFileOperations+Folders.swift`: rename/move only, self-
// subtree guard, no silent overwrite.
//
// NTFS is case-insensitive-but-case-preserving, exactly like APFS, and that
// property governs every path comparison below: containment/collision
// checks compare case-INSENSITIVELY (so `C:\Folder` moved into
// `c:\folder\sub` is still caught as moving it into its own subtree), while
// telling "the same folder, different casing" apart from "genuinely the
// same path" reuses the file side's three-way `ClassifySameFile` — a
// case-only folder rename is a real, meaningful operation (performed as a
// direct atomic `Directory.Move`, matching how NTFS itself updates stored
// casing), not a same-path no-op and not a destination collision.

using System;
using System.IO;
using System.Threading.Tasks;

namespace Maple.WinUI.Services.FileOperations
{
    public static partial class LocalFileOperations
    {
        /// <summary>Create <paramref name="name"/> inside
        /// <paramref name="parentDir"/>. Fails on collision rather than
        /// auto-suffixing — matches the API's `mkdir`, which 409s rather
        /// than silently picking a sibling name the user didn't ask
        /// for.</summary>
        public static string CreateFolder(string name, string parentDir)
        {
            ValidateBareFileName(name);
            var target = Path.Combine(parentDir, name);
            if (Directory.Exists(target) || File.Exists(target))
                throw new FileOperationException(FileOperationErrorKind.DestinationExists, target);
            Directory.CreateDirectory(target);
            return target;
        }

        /// <summary>Rename <paramref name="folderPath"/> in place.</summary>
        public static string RenameFolder(string folderPath, string newName)
        {
            var parent = Path.GetDirectoryName(Path.GetFullPath(folderPath));
            if (parent is null)
                throw new FileOperationException(FileOperationErrorKind.InvalidDestination,
                    $"cannot rename a root directory: {folderPath}");
            return MoveFolder(folderPath, parent, newName);
        }

        /// <summary>
        /// Move <paramref name="folderPath"/> (optionally renaming it) into
        /// <paramref name="newParentDir"/>. Refuses to move a folder into
        /// its own subtree and refuses to silently overwrite an existing
        /// item at the destination — except when the destination names the
        /// SAME folder under different casing, which is a legitimate
        /// case-only rename (see <see cref="ClassifySameFile"/>).
        /// </summary>
        public static string MoveFolder(string folderPath, string newParentDir, string? newName = null)
        {
            if (newName != null) ValidateBareFileName(newName);

            var sourceFull = TrashPaths.NormalizeDir(Path.GetFullPath(folderPath));
            var name = newName ?? Path.GetFileName(sourceFull);
            var targetParentFull = TrashPaths.NormalizeDir(Path.GetFullPath(newParentDir));

            // Case-INSENSITIVE containment check: NTFS resolves
            // `c:\folder\sub` and `C:\Folder\sub` to the same location, so a
            // case-sensitive comparison here would let a folder be moved
            // into its own subtree just by varying the case of the path.
            if (string.Equals(targetParentFull, sourceFull, StringComparison.OrdinalIgnoreCase) ||
                targetParentFull.StartsWith(sourceFull + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
            {
                throw new FileOperationException(FileOperationErrorKind.InvalidDestination,
                    $"cannot move {folderPath} into its own subtree {newParentDir}");
            }

            var target = Path.Combine(newParentDir, name);
            var targetFull = TrashPaths.NormalizeDir(Path.GetFullPath(target));

            switch (ClassifySameFile(sourceFull, targetFull))
            {
                case SameFileClassification.Identical:
                    return folderPath; // already there — a genuine no-op
                case SameFileClassification.CaseOnlyRename:
                    // The "destination occupied" check below would see this
                    // folder occupying its own new name and wrongly refuse
                    // it — a case-only rename needs the same direct-move
                    // bypass the file side gives `PerformCaseOnlyRename`.
                    Directory.Move(folderPath, target);
                    return target;
                case SameFileClassification.Different:
                    break;
            }

            if (Directory.Exists(target) || File.Exists(target))
                throw new FileOperationException(FileOperationErrorKind.DestinationExists, target);

            Directory.CreateDirectory(newParentDir);
            Directory.Move(folderPath, target);
            return target;
        }

        /// <summary>
        /// Recursively trash <paramref name="folderPath"/> — the whole
        /// subtree moves as one unit (a directory move, not a per-file
        /// walk), which is exactly what "preserving relative structure so
        /// restore can reconstruct the tree" requires: nothing inside is
        /// touched individually.
        /// </summary>
        public static Task<string> DeleteFolderAsync(
            string folderPath, string libraryRoot, IRecycleBinService? recycleBin = null)
        {
            recycleBin ??= RecycleBinService.Instance;
            if (IsOnLocalFixedDrive(folderPath) && recycleBin.TrySendToRecycleBin(folderPath))
                return Task.FromResult(folderPath);

            return Task.FromResult(TrashFolderToMapleFolder(folderPath, libraryRoot));
        }

        /// <summary>`.maple/trash/&lt;rel&gt;` fallback for folder delete —
        /// SMB always, plus a local-fixed-drive Recycle Bin call that
        /// failed.</summary>
        internal static string TrashFolderToMapleFolder(string folderPath, string libraryRoot)
        {
            var trashParent = TrashPaths.TrashDestinationDir(folderPath, libraryRoot);
            Directory.CreateDirectory(trashParent);

            // A directory move, not an asset relocate — the numeric-suffix
            // collision handling is inlined rather than routed through
            // `CollisionResolver`/`RelocateAsync`, which are sized for the
            // copy-verify-delete file contract this operation doesn't need.
            // Bounded the same way `CollisionResolver.MaxAttempts` bounds
            // the file side, rather than looping unbounded against a
            // directory that already has 1000 numbered siblings.
            var folderName = Path.GetFileName(TrashPaths.NormalizeDir(Path.GetFullPath(folderPath)));
            var target = Path.Combine(trashParent, folderName);
            var suffix = 1;
            while (Directory.Exists(target) || File.Exists(target))
            {
                if (suffix > CollisionResolver.MaxAttempts)
                    throw new FileOperationException(FileOperationErrorKind.Underlying,
                        $"trashFolderToMapleFolder: exceeded {CollisionResolver.MaxAttempts} candidate paths for {folderPath}");
                target = Path.Combine(trashParent, $"{folderName}.{suffix}");
                suffix++;
            }

            Directory.Move(folderPath, target);
            return target;
        }
    }
}

// FolderTreeCrudLogic.cs — pure path-string helpers behind the sources-tree
// context flyout (#2647: New Folder / Rename / Move to Trash). WinUI-free by
// construction, like RenameLogic.cs (see that file's header for why that
// matters for this codebase's test setup): plain System.IO string
// manipulation, no filesystem access, no WinUI types. Links into
// Maple.WinUI.Tests via this directory's existing wildcard Compile Include.
//
// The actual tree-node mutation (ObservableCollection<FolderNode>,
// App.MainDispatcherQueue marshaling) lives in
// EditSessionViewModel.FolderCrud.cs; the actual filesystem calls live in
// LocalFileOperations.Folders.cs / .Trash.cs (#2632). Neither belongs here.

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;

namespace Maple.WinUI.Services.FileOperations
{
    public static class FolderTreeCrudLogic
    {
        /// <summary>The registered library root that owns <paramref
        /// name="path"/> — itself, or whichever entry in <paramref
        /// name="libraryRoots"/> is an ancestor directory of it — compared
        /// case-insensitively (NTFS). The LONGEST matching root wins, so a
        /// path under a root that itself sits inside another registered root
        /// still resolves to its nearest owner. Null when no root in the
        /// list owns the path, which shouldn't happen for anything the
        /// sources tree itself produced.</summary>
        public static string? FindLibraryRoot(IEnumerable<string> libraryRoots, string path) =>
            libraryRoots
                .Where(root => IsSameOrDescendant(root, path))
                .OrderByDescending(root => root.Length)
                .FirstOrDefault();

        /// <summary>True when <paramref name="path"/> IS <paramref
        /// name="ancestor"/>, or sits inside it — compared
        /// case-insensitively and normalized against a trailing separator,
        /// matching NTFS's case-insensitive-but-case-preserving semantics
        /// (the same rule LocalFileOperations.Folders.cs's self-subtree
        /// guard already applies).</summary>
        public static bool IsSameOrDescendant(string ancestor, string path)
        {
            var normalizedAncestor = TrashPaths.NormalizeDir(ancestor);
            var normalizedPath = TrashPaths.NormalizeDir(path);
            return string.Equals(normalizedAncestor, normalizedPath, StringComparison.OrdinalIgnoreCase)
                || normalizedPath.StartsWith(
                    normalizedAncestor + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase);
        }

        /// <summary>Rewrites <paramref name="path"/> onto the same relative
        /// position under <paramref name="newAncestor"/> that it held under
        /// <paramref name="oldAncestor"/> — e.g. renaming `C:\Lib\A` to
        /// `C:\Lib\Renamed` turns a browsed path of `C:\Lib\A\Sub` into
        /// `C:\Lib\Renamed\Sub`. Callers only call this after establishing
        /// <see cref="IsSameOrDescendant"/>(oldAncestor, path); it does not
        /// re-check that here.</summary>
        public static string RewriteDescendantPath(string oldAncestor, string newAncestor, string path)
        {
            var normalizedOld = TrashPaths.NormalizeDir(oldAncestor);
            var normalizedPath = TrashPaths.NormalizeDir(path);
            if (normalizedPath.Length <= normalizedOld.Length)
                return newAncestor;
            var suffix = normalizedPath[normalizedOld.Length..].TrimStart(
                Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            return Path.Combine(newAncestor, suffix);
        }

        /// <summary>The human-facing description of where a folder trash
        /// lands, for the confirmation dialog and its primary button — the
        /// design doc's "must be visible in the UI rather than silently
        /// different": a real Recycle Bin call (local fixed drives) vs the
        /// `.maple/trash` fallback (SMB, or a Recycle Bin call that itself
        /// failed).</summary>
        public static string TrashDestinationDescription(bool isOnLocalFixedDrive) =>
            isOnLocalFixedDrive
                ? "the Recycle Bin"
                : "Maple's Trash (.maple\\trash — permanently deleted after 30 days)";
    }
}

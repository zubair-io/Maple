// EditSessionViewModel.FolderCrud.cs — New Folder / Rename / Move to Trash
// for the sources-tree FOLDERS list (#2647). Routes through the already-
// merged Windows file-operations service (#2632, LocalFileOperations.
// Folders.cs / .Trash.cs) — no new file-op logic here, only tree/settings
// reconciliation, the same split MainWindow.Rename.cs /
// EditSessionViewModel.Rename.cs already uses for single-asset rename.
//
// Every local FOLDERS node — root or subfolder — supports all three actions:
// unlike the Apple sibling (#2645, which also has SMB and Cloud rows to
// gate) or the Web sibling (#2643, which disables Rename/Trash on a library
// root because its server-side "library" identity can't survive a path
// change), this tree is 100% local Filesystem/SMB (Cloud lives in its own
// "MAPLE CLOUD" ListView, not this TreeView — MainWindow.xaml), and
// LocalFileOperations.Folders.cs already performs a real rename/move/trash
// on a root exactly like any other directory. So instead of disabling those
// actions on a root, a root rename/trash here is followed by rewriting the
// matching AppSettings.LibraryFolders entry (mirrors Apple's
// reconcileSavedFolder) — a fuller, not a lesser, feature. Flagging for
// conflict-checking against #2654 (concurrent Windows grid-trash ticket):
// this file only ADDS to LocalFileOperations.Folders.cs/.Trash.cs's already-
// merged call surface, it does not modify either.
//
// Name validation goes through the shared raw-core engine
// (Services/FilenameValidation.cs -> maple_validate_filename), same as
// inline single-asset rename — no hand-rolled rule set. The no-op check
// reuses RenameLogic.IsNoopRename (ordinal comparison) rather than a fresh
// same-name pre-check, so a case-only rename ("Photos" -> "photos") is
// correctly treated as a real rename and reaches
// LocalFileOperations.RenameFolder's case-only-rename classification
// instead of being silently swallowed here first.

using System;
using System.Collections.ObjectModel;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Maple.WinUI.Services;
using Maple.WinUI.Services.FileOperations;

namespace Maple.WinUI.ViewModels
{
    public partial class EditSessionViewModel
    {
        // --- New Folder ---

        /// <summary>Creates <paramref name="name"/> inside <paramref
        /// name="parent"/> and refreshes its children so an already-expanded
        /// node shows the new folder without a manual collapse/re-expand.
        /// Returns the rejection reason (validation or a filesystem error)
        /// on failure; never throws.</summary>
        public async Task<(bool Ok, string? Error)> CreateFolderInTreeAsync(FolderNode parent, string name)
        {
            if (parent.IsPlaceholder)
                return (false, "Expand this folder first.");

            var validationError = FilenameValidation.ValidationError(name);
            if (validationError != null)
                return (false, validationError);

            try
            {
                await Task.Run(() => LocalFileOperations.CreateFolder(name, parent.Path));
            }
            catch (FileOperationException ex)
            {
                return (false, ex.Message);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                return (false, ex.Message);
            }

            await RefreshFolderChildrenAsync(parent);
            return (true, null);
        }

        // --- Rename ---

        /// <summary>Renames <paramref name="node"/> in place. A typed name
        /// that's ordinal-identical to the current one is treated as
        /// "nothing to do" (Ok, no error) rather than round-tripping through
        /// the relocate primitive — mirrors CommitRenameAsync's single-asset
        /// no-op handling.</summary>
        public async Task<(bool Ok, string? Error)> RenameFolderInTreeAsync(FolderNode node, string newName)
        {
            if (node.IsPlaceholder)
                return (false, "That item can't be renamed.");

            var trimmed = newName.Trim();
            if (RenameLogic.IsNoopRename(node.Name, trimmed))
                return (true, null);

            var validationError = FilenameValidation.ValidationError(trimmed);
            if (validationError != null)
                return (false, validationError);

            var oldPath = node.Path;
            string newPath;
            try
            {
                newPath = await Task.Run(() => LocalFileOperations.RenameFolder(oldPath, trimmed));
            }
            catch (FileOperationException ex)
            {
                return (false, ex.Message);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                return (false, ex.Message);
            }

            ApplyFolderRename(node, oldPath, newPath);
            return (true, null);
        }

        /// <summary>Post-rename bookkeeping: swaps the stale node for a
        /// fresh one at its new path (FolderNode.Path/Name are
        /// construction-only, so an in-place edit isn't possible), rewrites
        /// the matching AppSettings.LibraryFolders entry when the renamed
        /// folder was itself a registered root, and — the "avoid a dangling
        /// selection" requirement, same fix the Apple sibling needed a
        /// review round for — re-points the currently browsed folder onto
        /// its new location when it was the renamed folder OR a descendant
        /// of it.</summary>
        private void ApplyFolderRename(FolderNode node, string oldPath, string newPath)
        {
            var located = FindParentCollection(FolderTree, node);
            if (located is { } loc)
                loc.Collection[loc.Index] = BuildFolderNode(newPath);

            var rootMatch = LibraryFolders.FirstOrDefault(
                f => string.Equals(f, oldPath, StringComparison.OrdinalIgnoreCase));
            if (rootMatch != null)
            {
                LibraryFolders[LibraryFolders.IndexOf(rootMatch)] = newPath;
                var settings = AppSettings.Load();
                settings.LibraryFolders = LibraryFolders.ToList();
                settings.Save();
            }

            if (CurrentFolderPath.Length > 0 && FolderTreeCrudLogic.IsSameOrDescendant(oldPath, CurrentFolderPath))
                LoadDirectory(FolderTreeCrudLogic.RewriteDescendantPath(oldPath, newPath, CurrentFolderPath));
        }

        // --- Move to Trash ---

        /// <summary>Whether <paramref name="node"/> can be trashed at all —
        /// checked BEFORE the confirmation dialog even opens (review
        /// finding: a library root on a non-Recycle-Bin-capable path always
        /// failed, and showing "Move to Trash?" for an action guaranteed to
        /// fail is its own kind of silent-failure trap). False only for a
        /// library root with no real Recycle Bin available — see
        /// FolderTreeCrudLogic.RootTrashUnsupported's doc comment for why
        /// there's no `.maple/trash` fallback a root could use instead.
        /// <see cref="IsOnLocalFixedDrive"/> is returned alongside so a
        /// caller that also needs it for the confirmation copy (the
        /// Recycle-Bin-vs-Maple's-Trash destination description) doesn't
        /// have to make a second synchronous drive-type call of its
        /// own.</summary>
        public async Task<(bool CanTrash, string? BlockedReason, bool IsOnLocalFixedDrive)> CanTrashFolderAsync(
            FolderNode node)
        {
            if (node.IsPlaceholder)
                return (false, "That item can't be moved to Trash.", false);

            // Off the UI thread (#2948): IsOnLocalFixedDrive ultimately
            // calls `new DriveInfo(root).DriveType`, which stalls for the OS
            // timeout on a disconnected or sleeping mapped drive — same
            // hazard class, same fix, as MainWindow.Trash.cs's confirmation
            // counts and MainWindow.TrashRestore.cs's ListMapleTrash. Mirrors
            // InitializeLibrary's Task.Run pattern
            // (EditSessionViewModel.Library.cs).
            var isOnLocalFixedDrive = await Task.Run(() => LocalFileOperations.IsOnLocalFixedDrive(node.Path));
            var unsupported = FolderTreeCrudLogic.RootTrashUnsupported(IsLibraryRoot(node.Path), isOnLocalFixedDrive);
            return unsupported
                ? (false, FolderTreeCrudLogic.RootTrashUnsupportedReason, isOnLocalFixedDrive)
                : (true, null, isOnLocalFixedDrive);
        }

        /// <summary>Recursively trashes <paramref name="node"/> — Recycle
        /// Bin on a local fixed drive, `.maple/trash/&lt;rel&gt;` otherwise
        /// (LocalFileOperations.DeleteFolderAsync, #2632).</summary>
        public async Task<(bool Ok, string? Error)> TrashFolderInTreeAsync(FolderNode node)
        {
            var (canTrash, blockedReason, _) = await CanTrashFolderAsync(node);
            if (!canTrash)
                return (false, blockedReason);

            var isRoot = IsLibraryRoot(node.Path);
            var libraryRoot = FolderTreeCrudLogic.FindLibraryRoot(LibraryFolders, node.Path);
            if (libraryRoot == null)
                return (false, "Could not resolve this folder's library root.");

            try
            {
                // DeleteFolderAsync's own body runs synchronously under a
                // Task wrapper (a Recycle Bin shell call or a Directory.Move,
                // not real async I/O) — Task.Run keeps a slow SMB directory
                // move or a sluggish shell call from blocking the UI thread,
                // same reasoning as Create/Rename above.
                await Task.Run(() => LocalFileOperations.DeleteFolderAsync(node.Path, libraryRoot));
            }
            catch (FileOperationException ex) when (isRoot && ex.Kind == FileOperationErrorKind.InvalidDestination)
            {
                // CanTrashFolder's gate covers the PREDICTABLE case (SMB, or
                // any other non-fixed-drive root). This catches the rare
                // remaining one: a local-fixed-drive root where the Recycle
                // Bin shell call itself fails at runtime, which falls
                // through to the same circular `.maple/trash` fallback and
                // throws TrashPaths' internal "not under library root"
                // exception (Kind InvalidDestination) — accurate, but
                // meaningless to a user. Reworded rather than surfaced
                // verbatim. Filtered on Kind, not just isRoot, so any OTHER
                // FileOperationException a root delete could throw still
                // falls through to the generic handler below unmangled.
                return (false, "Couldn't send this library root to the Recycle Bin, and there's no "
                    + "other Trash location for a root's own folder. Remove it from the library "
                    + "instead, or delete it manually from Explorer.");
            }
            catch (FileOperationException ex)
            {
                return (false, ex.Message);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                return (false, ex.Message);
            }

            ApplyFolderTrash(node);
            return (true, null);
        }

        /// <summary>Post-trash bookkeeping: removes the node from the tree,
        /// drops the matching AppSettings.LibraryFolders entry when the
        /// trashed folder was itself a registered root (mirrors
        /// RemoveLibraryFolder, above), and falls back to the first
        /// remaining library folder — same as RemoveLibraryFolder — when the
        /// trashed folder was the browsed folder or an ancestor of it.
        /// Falling back on "ancestor of" too, not just an exact match, is
        /// the same dangling-selection fix the Apple sibling needed a review
        /// round for.</summary>
        private void ApplyFolderTrash(FolderNode node)
        {
            var located = FindParentCollection(FolderTree, node);
            if (located is { } loc)
                loc.Collection.RemoveAt(loc.Index);

            var rootMatch = LibraryFolders.FirstOrDefault(
                f => string.Equals(f, node.Path, StringComparison.OrdinalIgnoreCase));
            if (rootMatch != null)
            {
                LibraryFolders.Remove(rootMatch);
                var settings = AppSettings.Load();
                settings.LibraryFolders = LibraryFolders.ToList();
                settings.Save();
            }

            if (CurrentFolderPath.Length > 0 && FolderTreeCrudLogic.IsSameOrDescendant(node.Path, CurrentFolderPath))
            {
                _libraryCts?.Cancel();
                AllPhotos.Clear();
                ApplyFilters();
                Timeline.GroupPhotosByDate(AllPhotos);
                CurrentFolderPath = string.Empty;
                ActiveSectionName = "All Photos";
                var first = LibraryFolders.FirstOrDefault();
                if (first != null)
                    LoadDirectory(first);
            }
        }

        // --- Shared tree-walk helpers ---

        /// <summary>Force-reloads <paramref name="node"/>'s children
        /// regardless of ChildrenLoaded, awaitably — unlike the fire-and-
        /// forget LoadFolderChildren (Library.cs), so New Folder can wait
        /// for the tree to visibly update before its dialog closes.</summary>
        private Task RefreshFolderChildrenAsync(FolderNode node)
        {
            if (node.IsPlaceholder)
                return Task.CompletedTask;
            node.ChildrenLoaded = true;
            var tcs = new TaskCompletionSource();
            _ = Task.Run(() =>
            {
                var children = EnumerateChildFolderNodes(node.Path);
                App.MainDispatcherQueue?.TryEnqueue(() =>
                {
                    node.Children.Clear();
                    foreach (var child in children)
                        node.Children.Add(child);
                    tcs.SetResult();
                });
            });
            return tcs.Task;
        }

        /// <summary>Depth-first search by reference (not by Path — a rename
        /// is exactly the case where <paramref name="target"/>'s own Path no
        /// longer matches anything on disk) for the ObservableCollection
        /// that directly holds <paramref name="target"/>, and its index in
        /// that collection. <paramref name="roots"/> stands in for "the
        /// tree's own implicit root" so a top-level FolderTree entry and a
        /// nested Children entry are found the same way.</summary>
        private static (ObservableCollection<FolderNode> Collection, int Index)? FindParentCollection(
            ObservableCollection<FolderNode> roots, FolderNode target)
        {
            for (var i = 0; i < roots.Count; i++)
            {
                if (ReferenceEquals(roots[i], target))
                    return (roots, i);
            }
            foreach (var node in roots)
            {
                var found = FindParentCollection(node.Children, target);
                if (found != null)
                    return found;
            }
            return null;
        }
    }
}

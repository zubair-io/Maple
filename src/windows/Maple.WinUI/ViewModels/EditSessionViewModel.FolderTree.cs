using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Maple.WinUI.Services;

namespace Maple.WinUI.ViewModels
{
    /// <summary>The sources-tree side of the library: building/rebuilding
    /// FolderTree from LibraryFolders, lazy per-node expansion, root
    /// removal, and the shared subfolder enumeration + skip rules (dotfiles,
    /// hidden/system/reparse points) that both this file and
    /// EditSessionViewModel.FolderCrud.cs's forced-refresh path use. Split
    /// out of EditSessionViewModel.Library.cs (#3120) to stay under the
    /// file-size budget.</summary>
    public partial class EditSessionViewModel
    {
        private void RebuildFolderTree()
        {
            FolderTree.Clear();
            foreach (var root in LibraryFolders.ToList())
            {
                _ = Task.Run(() =>
                {
                    // Off the UI thread: Exists + enumeration can block on
                    // unreachable network roots without freezing the shell.
                    if (!Directory.Exists(root))
                    {
                        // #2651: a root dropped/added from removable or
                        // network storage may not be reachable at this
                        // launch. Degrades to a visible-but-inert tree row
                        // (FolderNode.IsUnavailable) rather than silently
                        // vanishing from the sidebar or popping an error
                        // dialog — the explanation lives in the row's own
                        // label/tooltip (MainWindow.xaml), not a dialog the
                        // user has to dismiss before doing anything else.
                        var missing = BuildUnavailableFolderNode(root);
                        DiagLog.Write($"[library] root unavailable: {root}");
                        App.MainDispatcherQueue?.TryEnqueue(() => FolderTree.Add(missing));
                        return;
                    }
                    var node = BuildFolderNode(root);
                    App.MainDispatcherQueue?.TryEnqueue(() =>
                    {
                        FolderTree.Add(node);
                        SynchronizeFolderSelection();
                    });
                });
            }
        }

        // BuildUnavailableFolderNode lives in EditSessionViewModel.DropMount.cs
        // (same partial class, so RebuildFolderTree above can still call it
        // directly) — kept out of this file for the same line-budget reason.

        /// <summary>Build ONE tree node: name + an expander stub when the
        /// folder has subfolders. No recursion — children load on expand.</summary>
        private static FolderNode BuildFolderNode(string path)
        {
            var name = Path.GetFileName(path.TrimEnd(Path.DirectorySeparatorChar));
            var node = new FolderNode
            {
                Name = name.Length > 0 ? name : path,
                Path = path,
            };
            if (HasVisibleSubdirectory(path))
                node.Children.Add(new FolderNode { Name = "…", IsPlaceholder = true });
            return node;
        }

        private static bool HasVisibleSubdirectory(string path)
        {
            try
            {
                return Directory.EnumerateDirectories(path).Any(d => !IsSkippableDirectory(d));
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                return false;
            }
        }

        public bool IsLibraryRoot(string path) =>
            LibraryFolders.Contains(path, StringComparer.OrdinalIgnoreCase);

        /// <summary>Unregister a library root. Never touches the folder on
        /// disk — originals and sidecars stay exactly where they are.</summary>
        public void RemoveLibraryFolder(string path)
        {
            var match = LibraryFolders.FirstOrDefault(
                f => string.Equals(f, path, StringComparison.OrdinalIgnoreCase));
            if (match == null)
                return;
            LibraryFolders.Remove(match);
            var settings = AppSettings.Load();
            settings.LibraryFolders = LibraryFolders.ToList();
            settings.Save();

            var node = FolderTree.FirstOrDefault(
                n => string.Equals(n.Path, path, StringComparison.OrdinalIgnoreCase));
            if (node != null)
                FolderTree.Remove(node);

            if (CurrentFolderPath.StartsWith(path, StringComparison.OrdinalIgnoreCase))
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

        /// <summary>Lazy expand: replace the stub with the folder's immediate
        /// subfolders, enumerated off the UI thread.</summary>
        public void LoadFolderChildren(FolderNode node)
        {
            if (node.ChildrenLoaded || node.IsPlaceholder)
                return;
            node.ChildrenLoaded = true;
            _ = Task.Run(() =>
            {
                var children = EnumerateChildFolderNodes(node.Path);
                App.MainDispatcherQueue?.TryEnqueue(() =>
                {
                    node.Children.Clear();
                    foreach (var child in children)
                        node.Children.Add(child);
                    SynchronizeFolderSelection();
                });
            });
        }

        /// <summary>Off-UI-thread enumeration of one folder's immediate
        /// subfolders as fresh <see cref="FolderNode"/>s — the shared body
        /// behind <see cref="LoadFolderChildren"/> (lazy first expand) and
        /// EditSessionViewModel.FolderCrud.cs's forced refresh after New
        /// Folder / Rename / Move to Trash (#2647) mutate the subtree. Pure
        /// with respect to view state: callers own marshaling the result
        /// back onto the UI thread.</summary>
        private static List<FolderNode> EnumerateChildFolderNodes(string path)
        {
            try
            {
                return Directory.EnumerateDirectories(path)
                    .Where(d => !IsSkippableDirectory(d))
                    .OrderBy(d => d, StringComparer.OrdinalIgnoreCase)
                    .Select(BuildFolderNode)
                    .ToList();
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                return new List<FolderNode>();
            }
        }

        private static bool IsSkippableDirectory(string dir)
        {
            var name = Path.GetFileName(dir);
            if (name.StartsWith('.'))
                return true;
            try
            {
                var attrs = File.GetAttributes(dir);
                // ReparsePoint skip keeps the walk out of junction cycles and
                // cloud-placeholder mounts below a root.
                return attrs.HasFlag(FileAttributes.Hidden)
                    || attrs.HasFlag(FileAttributes.System)
                    || attrs.HasFlag(FileAttributes.ReparsePoint);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                return true;
            }
        }
    }
}

using System;
using System.Collections.Generic;

namespace Maple.WinUI.ViewModels
{
    public static class FolderNavigation
    {
        public static void Synchronize(
            IEnumerable<FolderNode> folderTree, IEnumerable<CloudFolderNode> cloudTree,
            string? selectedLocalFolder, CloudFolderNode? selectedCloudFolder,
            Action<FolderNode> loadLocalChildren, Action<CloudFolderNode> loadCloudChildren)
        {
            void Local(IEnumerable<FolderNode> nodes)
            {
                foreach (var node in nodes)
                {
                    node.IsSelected = !node.IsPlaceholder && string.Equals(
                        node.Path, selectedLocalFolder, StringComparison.OrdinalIgnoreCase);
                    if (!node.IsPlaceholder && selectedLocalFolder != null &&
                        selectedLocalFolder.StartsWith(node.Path.TrimEnd('\\', '/') + "\\", StringComparison.OrdinalIgnoreCase))
                    {
                        node.IsExpanded = true;
                        loadLocalChildren(node);
                    }
                    Local(node.Children);
                }
            }
            void Cloud(IEnumerable<CloudFolderNode> nodes)
            {
                foreach (var node in nodes)
                {
                    var sameLibrary = !node.IsPlaceholder && selectedCloudFolder != null &&
                        node.LibrarySlug == selectedCloudFolder.LibrarySlug;
                    node.IsSelected = sameLibrary && node.RelativePath == selectedCloudFolder!.RelativePath;
                    if (sameLibrary && !node.IsSelected && (node.RelativePath.Length == 0 ||
                        selectedCloudFolder!.RelativePath.StartsWith(node.RelativePath + "/", StringComparison.Ordinal)))
                    {
                        node.IsExpanded = true;
                        loadCloudChildren(node);
                    }
                    Cloud(node.Children);
                }
            }
            Local(folderTree);
            Cloud(cloudTree);
        }
    }
}

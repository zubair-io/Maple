using System;
using System.Threading;
using CommunityToolkit.Mvvm.ComponentModel;

namespace Maple.WinUI.ViewModels
{
    public partial class EditSessionViewModel
    {
        [ObservableProperty] private bool _isLibraryLoading;
        [ObservableProperty] private string _libraryLoadStatus = string.Empty;
        private string? _selectedLocalFolder;
        private CloudFolderNode? _selectedCloudFolder;
        private bool _isCloudTimeline;

        public System.Collections.Generic.IEnumerable<(string Label, Action Navigate)> BrowseAncestors()
        {
            var result = new System.Collections.Generic.List<(string, Action)>();
            if (_selectedCloudFolder is { } cloud)
            {
                var path = cloud.Path.TrimEnd('/');
                var root = System.Linq.Enumerable.FirstOrDefault(CloudTree, n => n.LibrarySlug == cloud.LibrarySlug);
                while (root != null && (path == root.Path.TrimEnd('/') || path.StartsWith(root.Path.TrimEnd('/') + "/", StringComparison.Ordinal)))
                {
                    var node = new CloudFolderNode { Name = path[(path.LastIndexOf('/') + 1)..], Path = path, LibrarySlug = cloud.LibrarySlug };
                    result.Insert(0, (node.Name.Length == 0 ? path : node.Name, () => { _ = LoadCloudDirectoryAsync(node); }));
                    var slash = path.LastIndexOf('/');
                    if (slash < 0) break;
                    path = path[..slash];
                }
            }
            else if (_selectedLocalFolder is { } local)
            {
                for (var path = local; !string.IsNullOrEmpty(path); path = System.IO.Path.GetDirectoryName(path.TrimEnd(System.IO.Path.DirectorySeparatorChar)))
                {
                    var target = path;
                    result.Insert(0, (path, () => LoadDirectory(target)));
                    if (path == System.IO.Path.GetPathRoot(path)) break;
                }
            }
            return result;
        }

        private void BeginBrowse(string? local = null, CloudFolderNode? cloud = null, bool timeline = false)
        {
            _selectedLocalFolder = local;
            _selectedCloudFolder = cloud;
            _isCloudTimeline = timeline;
            HasMoreTimeline = false;
            CanRetryCloudSearch = false;
            DateFilterStart = null;
            DateFilterEndExclusive = null;
            IsLibraryLoading = true;
            LibraryLoadStatus = "Loading…";
            SelectedPhoto = null;
            SyncSelectedPhotos(Array.Empty<PhotoItem>());
            AllPhotos.Clear();
            BrowseFolders.Clear();
            ApplyFilters();
            SynchronizeFolderSelection();
        }

        // Run again when lazy children arrive, so navigation from a tile,
        // picker, drop or a newly restored root reveals the same tree path.
        private void SynchronizeFolderSelection() => FolderNavigation.Synchronize(
            FolderTree, CloudTree, _selectedLocalFolder, _selectedCloudFolder,
            LoadFolderChildren, LoadCloudFolderChildren);

        private void FinishBrowse(CancellationTokenSource owner, string status)
        {
            if (_libraryCts != owner || owner.IsCancellationRequested) return;
            LibraryLoadStatus = status;
            IsLibraryLoading = false;
        }
    }
}

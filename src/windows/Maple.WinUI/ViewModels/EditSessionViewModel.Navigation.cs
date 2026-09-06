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

        private void BeginBrowse(string? local = null, CloudFolderNode? cloud = null, bool timeline = false)
        {
            _selectedLocalFolder = local;
            _selectedCloudFolder = cloud;
            _isCloudTimeline = timeline;
            HasMoreTimeline = false;
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

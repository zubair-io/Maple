using System;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Maple.WinUI.Services;
using Maple.WinUI.ViewModels;

namespace Maple.WinUI
{
    /// <summary>Browse mode: sidebar toggle, single-selection sync between the
    /// grid/filmstrip and the viewer's embedded-JPEG placeholder, and the
    /// sources-tree/timeline/format/rating/flag/search filters that drive
    /// ViewModel.Photos.</summary>
    public sealed partial class MainWindow
    {
        // --- Browse chrome ---

        private void OnToggleSidebar(object sender, RoutedEventArgs e)
        {
            var hidden = SidebarColDef.Width.Value > 0;
            SidebarColDef.Width = new GridLength(hidden ? 0 : Math.Max(_settings.LeftPanelWidth, 200));
            // Keeps the in-memory _settings field (read elsewhere this
            // session, e.g. SetMode above) in sync too — AppSettings.Update
            // below only fixes what actually goes to disk.
            _settings.LeftPanelHidden = hidden;
            // #2948: NOT `_settings.Save()`. _settings is loaded once at
            // construction and never refreshed, so saving it directly would
            // serialize that launch-time snapshot over the current file —
            // including LibraryFolders as it looked at launch — discarding
            // any folder added or renamed since. AppSettings.Update()
            // re-loads immediately before writing, per that type's
            // class-level invariant.
            AppSettings.Update(s => s.LeftPanelHidden = hidden);
        }

        // --- Selection ---
        // PhotoGrid's own SelectionChanged (Extended mode, multi-select) is
        // OnPhotoGridSelectionChanged in MainWindow.Selection.cs.

        private void OnGridDoubleTapped(object sender, DoubleTappedRoutedEventArgs e) => EnterPreview();

        // Stays for the Filmstrip, which is single-select (one photo at a
        // time while paging through Preview).
        private void OnGridSelectionChanged(object sender, SelectionChangedEventArgs e)
        {
            if (sender is ListViewBase list && list.SelectedItem is PhotoItem photo
                && !ReferenceEquals(photo, ViewModel.SelectedPhoto))
            {
                ViewModel.SelectedPhoto = photo;
            }
        }

        private PhotoItem? _previewSubscribed;

        private void OnSelectedPhotoChanged()
        {
            var photo = ViewModel.SelectedPhoto;
            RefreshPhotoInfo();
            if (photo == null)
                return;
            if (PhotoGrid.SelectedItem != photo)
                PhotoGrid.SelectedItem = photo;
            if (Filmstrip.SelectedItem != photo)
            {
                Filmstrip.SelectedItem = photo;
                Filmstrip.ScrollIntoView(photo);
            }
            UpdateStarRow();

            // The viewer shows the embedded JPEG until the Edit decode delivers
            // its first chain frame (the spec's placeholder-then-crossfade).
            _viewportBitmap = null;
            _gpuFrameDims = null;
            ViewportSwapChainPanel.Visibility = Visibility.Collapsed;
            ViewportImage.Visibility = Visibility.Visible;
            ResetZoom();  // zoom is per-image and resets on navigation (spec)
            // A stale clipping overlay must never sit over the next photo.
            ClipOverlayImage.Visibility = Visibility.Collapsed;
            ShowEmbeddedPreview(photo);
            if (_previewSubscribed != null)
                _previewSubscribed.PropertyChanged -= OnCurrentPhotoPropertyChanged;
            _previewSubscribed = photo;
            photo.PropertyChanged += OnCurrentPhotoPropertyChanged;

            if (_mode == ShellMode.Edit)
                ViewModel.EnsureDecoded();
        }

        private void OnCurrentPhotoPropertyChanged(object? sender, System.ComponentModel.PropertyChangedEventArgs e)
        {
            if (ReferenceEquals(sender, ViewModel.SelectedPhoto)) RefreshPhotoInfo();
            if (e.PropertyName is not (nameof(PhotoItem.PreviewPath) or nameof(PhotoItem.ThumbnailPath)))
                return;
            var photo = ViewModel.SelectedPhoto;
            // Only refresh while the embedded preview is still what's on screen.
            if (photo != null && ReferenceEquals(sender, photo) && _viewportBitmap == null)
                ShowEmbeddedPreview(photo);
        }

        private void ShowEmbeddedPreview(PhotoItem photo)
        {
            var source = photo.PreviewPath ?? photo.ThumbnailPath;
            ViewportImage.Source = source != null
                ? new Microsoft.UI.Xaml.Media.Imaging.BitmapImage(new Uri(source))
                : null;
        }

        // --- Library scopes / filters ---

        private void OnFolderNodeInvoked(TreeView sender, TreeViewItemInvokedEventArgs args)
        {
            if (args.InvokedItem is FolderNode { IsPlaceholder: false, IsUnavailable: false } node)
            {
                ViewModel.LoadDirectory(node.Path);
                SetMode(ShellMode.Browse);
            }
        }

        private void OnFolderExpanding(TreeView sender, TreeViewExpandingEventArgs args)
        {
            if (args.Item is FolderNode node)
                ViewModel.LoadFolderChildren(node);
        }

        private async void OnRemoveFolder(object sender, RoutedEventArgs e)
        {
            if ((sender as FrameworkElement)?.DataContext is not FolderNode node)
                return;
            if (!ViewModel.IsLibraryRoot(node.Path))
            {
                await ShowMessageAsync("Folders",
                    "Only top-level library folders can be removed — subfolders are part "
                    + "of their library root.");
                return;
            }
            // Unregisters only; nothing on disk (originals, sidecars) is touched.
            ViewModel.RemoveLibraryFolder(node.Path);
        }

        private async void OnTimelineInvoked(object sender, RoutedEventArgs e)
        {
            SetMode(ShellMode.Browse);
            await ViewModel.LoadCloudTimelineAsync();
        }

        private async void OnLoadMoreTimeline(object sender, RoutedEventArgs e) =>
            await ViewModel.LoadMoreTimelineAsync();

        private void OnFormatFilterChanged(object sender, SelectionChangedEventArgs e)
        {
            if (FormatFilterBox.SelectedItem is ComboBoxItem item && item.Tag is string tag)
                ViewModel.FormatFilter = tag;
        }

        private void OnRatingFilterChanged(object sender, SelectionChangedEventArgs e)
        {
            if (RatingFilterBox.SelectedItem is ComboBoxItem item && item.Tag is string tag)
                ViewModel.MinRatingFilter = int.Parse(tag);
        }

        private void OnFlagFilterChanged(object sender, SelectionChangedEventArgs e)
        {
            if (FlagFilterBox.SelectedItem is ComboBoxItem item && item.Tag is string tag)
                ViewModel.FlagFilter = tag;
        }

        private void OnSearchChanged(object sender, TextChangedEventArgs e) =>
            ViewModel.SearchText = SearchBox.Text;
    }
}

using System;
using System.IO;
using System.Linq;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Media.Imaging;
using Maple.WinUI.Services;
using Maple.WinUI.ViewModels;

namespace Maple.WinUI;

public sealed partial class MainWindow
{
    private bool _browseDesignReady;
    private bool _browseListDetail;
    private bool _syncingBrowseSelection;
    private bool _browseListCollapsed;
    private DataTemplate? _expandedBrowseTemplate;

    private void InitializeBrowseDesign()
    {
        _browseListDetail = _settings.BrowseListDetail;
        _expandedBrowseTemplate = BrowsePhotoList.ItemTemplate;
        foreach (var key in new[] { "ListViewItemBackgroundSelected", "ListViewItemBackgroundSelectedPointerOver", "ListViewItemBackgroundSelectedPressed" })
            BrowsePhotoList.Resources[key] = Application.Current.Resources["MaplePrimaryDim"];
        BrowsePhotoList.Resources["ListViewItemSelectionIndicatorBrush"] = Application.Current.Resources["MaplePrimary"];
        BrowsePhotoList.ContainerContentChanging += (_, e) =>
        {
            if (e.Item is PhotoItem photo)
                Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(e.ItemContainer, photo.FileName);
            if (!e.InRecycleQueue)
                e.RegisterUpdateCallback((_, next) =>
                {
                    if (next.ItemContainer.ContentTemplateRoot is FrameworkElement root &&
                        root.FindName("BrowseSelectionOutline") is Border outline)
                        outline.SetBinding(UIElement.VisibilityProperty, new Microsoft.UI.Xaml.Data.Binding
                        {
                            Source = next.ItemContainer,
                            Path = new PropertyPath("IsSelected"),
                            Converter = new Converters.BoolVisibleConverter()
                        });
                });
        };
        BrowseSortBox.SelectedIndex = (int)ViewModel.PhotoSort;
        BrowseDensityBox.SelectedIndex = _settings.ThumbnailSize <= 128 ? 0 : _settings.ThumbnailSize >= 240 ? 2 : 1;
        _browseDesignReady = true;
        UpdateBrowseLocation();
        PhotoGrid.Loaded += (_, _) => ApplyBrowseDensity();
        ViewModel.PropertyChanged += (_, e) =>
        {
            if (_closing) return;
            if (e.PropertyName is nameof(ViewModel.ActiveSectionName) or nameof(ViewModel.CurrentFolderPath))
            {
                UpdateBrowseLocation();
            }
        };
        UpdateBrowsePresentation();
    }

    private void OnToggleBrowseView(object sender, RoutedEventArgs e)
    {
        var anchor = BrowseScrollAnchor();
        var selected = ViewModel.SelectedPhotos.ToArray();
        var primary = ViewModel.SelectedPhoto;
        _browseListDetail = !_browseListDetail;
        AppSettings.Update(s => s.BrowseListDetail = _browseListDetail);
        UpdateBrowsePresentation();
        RestoreBrowseSelection(selected, primary);
        if (_browseListDetail && ViewModel.SelectedPhoto == null && ViewModel.Photos.Count > 0)
            RestoreBrowseSelection(new[] { ViewModel.Photos[0] }, ViewModel.Photos[0]);
        RestoreBrowseAnchor(anchor);
    }

    private void UpdateBrowsePresentation()
    {
        PhotoGrid.Visibility = _browseListDetail ? Visibility.Collapsed : Visibility.Visible;
        BrowseListDetail.Visibility = _browseListDetail ? Visibility.Visible : Visibility.Collapsed;
        BrowseViewButton.Label = _browseListDetail ? "Grid view" : "List / detail";
        BrowseCollapseButton.Visibility = _browseListDetail ? Visibility.Visible : Visibility.Collapsed;
        LibraryCountText.Visibility = _browseListDetail ? Visibility.Collapsed : Visibility.Visible;
        UpdateBrowseDetailImage();
    }

    private void UpdateBrowseDetailImage()
    {
        var photo = ViewModel.SelectedPhoto;
        var path = photo?.PreviewPath ?? photo?.ThumbnailPath;
        BrowseDetailImage.Source = path == null ? null : new BitmapImage(new Uri(path));
        BrowseDetailPane.Visibility = photo == null ? Visibility.Collapsed : Visibility.Visible;
        BrowseDetailEmpty.Visibility = photo == null ? Visibility.Visible : Visibility.Collapsed;
    }

    private void UpdateBrowseLocation()
    {
        var section = ViewModel.ActiveSectionName;
        SearchBox.PlaceholderText = ViewModel.IsServerSearch ? "Search Maple Cloud" : "Filter this folder";
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(SearchBox,
            ViewModel.IsServerSearch ? "Search Maple Cloud" : "Filter this folder by name, camera or lens");
        BrowseLocationButton.Label = string.IsNullOrWhiteSpace(section) || section == "Library"
            ? "Library" : "Library › " + section;
        ToolTipService.SetToolTip(BrowseLocationButton, ViewModel.CurrentFolderPath);
    }

    private void OnBrowseDetailSizeChanged(object sender, SizeChangedEventArgs e)
    {
        // Desktop keeps list/detail at smaller widths; controls scroll instead of
        // borrowing the phone editor's interaction model.
        BrowseListColumn.Width = new GridLength(_browseListCollapsed ? 100 : Math.Clamp(e.NewSize.Width * .30, 180, 340));
    }

    private void OnCollapseBrowseList(object sender, RoutedEventArgs e)
    {
        var anchor = BrowseScrollAnchor();
        _browseListCollapsed = !_browseListCollapsed;
        BrowseCollapseButton.Label = _browseListCollapsed ? "Expand list ›" : "Collapse list ‹";
        BrowseSelectButton.Visibility = _browseListCollapsed ? Visibility.Collapsed : Visibility.Visible;
        BrowsePhotoList.ItemTemplate = _browseListCollapsed
            ? (DataTemplate)BrowseListDetail.Resources["CompactBrowsePhotoTemplate"] : _expandedBrowseTemplate;
        BrowseListColumn.Width = new GridLength(_browseListCollapsed ? 100 : Math.Clamp(BrowseListDetail.ActualWidth * .30, 180, 340));
        RestoreBrowseAnchor(anchor);
    }

    private void OnBrowseSelectMode(object sender, RoutedEventArgs e)
    {
        var selected = ViewModel.SelectedPhotos.ToArray();
        var primary = ViewModel.SelectedPhoto;
        _syncingBrowseSelection = true;
        try
        {
            BrowsePhotoList.SelectionMode = BrowsePhotoList.SelectionMode == ListViewSelectionMode.Multiple
                ? ListViewSelectionMode.Extended : ListViewSelectionMode.Multiple;
            BrowseSelectButton.Label = BrowsePhotoList.SelectionMode == ListViewSelectionMode.Multiple ? "Done" : "Select";
        }
        finally { _syncingBrowseSelection = false; }
        RestoreBrowseSelection(selected, primary);
    }

    private void OnBrowseToolbarSizeChanged(object sender, SizeChangedEventArgs e)
    {
        var wide = e.NewSize.Width >= 1000;
        Grid.SetRow(BrowseSearchControls, wide ? 0 : 1);
        Grid.SetColumn(BrowseSearchControls, wide ? 1 : 0);
        Grid.SetColumnSpan(BrowseSearchControls, wide ? 1 : 2);
        SearchBox.Width = wide ? 200 : double.NaN;
    }

    private void OnBrowseListSelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (_syncingBrowseSelection || !_browseListDetail) return;
        var selected = BrowsePhotoList.SelectedItems.OfType<PhotoItem>().ToArray();
        _syncingBrowseSelection = true;
        try { ViewModel.SyncSelectedPhotos(selected); }
        finally { _syncingBrowseSelection = false; }
    }

    private void RestoreBrowseSelection(PhotoItem[] selected, PhotoItem? primary)
    {
        _syncingBrowseSelection = true;
        try
        {
            var availableSelection = selected.Where(ViewModel.Photos.Contains).ToArray();
            foreach (var list in new ListViewBase[] { PhotoGrid, BrowsePhotoList })
            {
                list.SelectedItems.Clear();
                foreach (var photo in availableSelection) list.SelectedItems.Add(photo);
            }
            ViewModel.SyncSelectedPhotos(availableSelection);
            if (primary != null && ViewModel.Photos.Contains(primary)) ViewModel.SelectedPhoto = primary;
        }
        finally { _syncingBrowseSelection = false; }
    }

    private PhotoItem? BrowseScrollAnchor()
    {
        var list = _browseListDetail ? (ListViewBase)BrowsePhotoList : PhotoGrid;
        var panel = list.ItemsPanelRoot;
        if (panel == null) return ViewModel.SelectedPhoto;
        foreach (var child in panel.Children.OfType<FrameworkElement>())
            if (child.DataContext is PhotoItem photo && child.TransformToVisual(list).TransformPoint(default).Y >= 0)
                return photo;
        return ViewModel.SelectedPhoto;
    }

    private void RestoreBrowseAnchor(PhotoItem? anchor)
    {
        if (anchor == null || !ViewModel.Photos.Contains(anchor)) return;
        DispatcherQueue.TryEnqueue(() =>
        {
            var list = _browseListDetail ? (ListViewBase)BrowsePhotoList : PhotoGrid;
            list.ScrollIntoView(anchor, ScrollIntoViewAlignment.Leading);
        });
    }

    private void OnBrowseSortChanged(object sender, SelectionChangedEventArgs e)
    {
        if (!_browseDesignReady || BrowseSortBox.SelectedIndex < 0) return;
        var anchor = BrowseScrollAnchor();
        var selected = ViewModel.SelectedPhotos.ToArray();
        var primary = ViewModel.SelectedPhoto;
        _syncingBrowseSelection = true;
        try
        {
            ViewModel.PhotoSort = (BrowseSort)BrowseSortBox.SelectedIndex;
            ViewModel.ApplyFilters();
        }
        finally { _syncingBrowseSelection = false; }
        RestoreBrowseSelection(selected, primary);
        RestoreBrowseAnchor(anchor);
        AppSettings.Update(s => s.BrowseSort = ViewModel.PhotoSort.ToString());
    }

    private void OnBrowseDensityChanged(object sender, SelectionChangedEventArgs e)
    {
        if (!_browseDesignReady) return;
        var anchor = BrowseScrollAnchor();
        ApplyBrowseDensity();
        RestoreBrowseAnchor(anchor);
        AppSettings.Update(s => s.ThumbnailSize = BrowseDensityBox.SelectedIndex switch { 0 => 128, 2 => 240, _ => 180 });
    }

    private void ApplyBrowseDensity()
    {
        if (PhotoGrid.ItemsPanelRoot is ItemsWrapGrid panel)
            panel.ItemWidth = panel.ItemHeight = BrowseDensityBox.SelectedIndex switch { 0 => 140, 2 => 252, _ => 192 };
    }

    private void OnBrowseLocation(object sender, RoutedEventArgs e)
    {
        var menu = new MenuFlyout();
        foreach (var location in ViewModel.BrowseAncestors())
        {
            var item = new MenuFlyoutItem { Text = location.Label };
            item.Click += (_, _) => location.Navigate();
            menu.Items.Add(item);
        }
        if (menu.Items.Count == 0)
            menu.Items.Add(new MenuFlyoutItem { Text = ViewModel.ActiveSectionName, IsEnabled = false });
        menu.ShowAt(BrowseLocationButton);
    }

    private void OnBrowseOpenPreview(object sender, RoutedEventArgs e) => EnterPreview();
    private void OnBrowseOpenEditor(object sender, RoutedEventArgs e)
    {
        EnterPreview();
        if (ViewModel.SelectedPhoto != null) OnEnterEdit(sender, e);
    }
    private void OnBrowseOpenInfo(object sender, RoutedEventArgs e)
    {
        EnterPreview();
        _infoPaneOpen = true;
        UpdateInfoPane();
    }
}

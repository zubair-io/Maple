using System;
using System.Linq;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Maple.WinUI.Services;
using Maple.WinUI.ViewModels;

namespace Maple.WinUI;

public sealed partial class MainWindow
{
    private bool _browseDesignReady;
    private bool _syncingBrowseSelection;

    private void InitializeBrowseDesign()
    {
        PhotoGrid.ContainerContentChanging += (_, e) =>
        {
            if (!e.InRecycleQueue)
                e.RegisterUpdateCallback((_, next) =>
                {
                    if (next.ItemContainer.ContentTemplateRoot is FrameworkElement root &&
                        root.FindName("GridSelectionOutline") is Border outline)
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
            if (e.PropertyName == nameof(ViewModel.SearchText) && SearchBox.Text != ViewModel.SearchText)
                SearchBox.Text = ViewModel.SearchText;
            if (e.PropertyName is nameof(ViewModel.SearchFacets) or nameof(ViewModel.OwnerFacets) or nameof(ViewModel.CloudConnected))
                UpdateSearchFacetControls();
            if (e.PropertyName is nameof(ViewModel.ActiveSectionName) or nameof(ViewModel.CurrentFolderPath))
            {
                UpdateBrowseLocation();
            }
        };
    }

    private void UpdateBrowseLocation()
    {
        var section = ViewModel.ActiveSectionName;
        UpdateSearchFacetControls();
        SearchBox.Placeholder = ViewModel.IsServerSearch ? "Search Maple Cloud" : "Filter this folder";
        SearchBox.AccessibleLabel = ViewModel.IsServerSearch ? "Search Maple Cloud" : "Filter this folder by name, camera or lens";
        BrowseLocationButton.Label = string.IsNullOrWhiteSpace(section) || section == "Library"
            ? "Library" : "Library › " + section;
        ToolTipService.SetToolTip(BrowseLocationButton, ViewModel.CurrentFolderPath);
    }

    private void OnBrowseToolbarSizeChanged(object sender, SizeChangedEventArgs e)
    {
        var wide = e.NewSize.Width >= 1000;
        Grid.SetRow(BrowseSearchControls, wide ? 0 : 1);
        Grid.SetColumn(BrowseSearchControls, wide ? 1 : 0);
        Grid.SetColumnSpan(BrowseSearchControls, wide ? 1 : 2);
        SearchBox.Width = wide ? 200 : double.NaN;
    }

    private void RestoreBrowseSelection(PhotoItem[] selected, PhotoItem? primary)
    {
        _syncingBrowseSelection = true;
        try
        {
            var availableSelection = selected.Where(ViewModel.Photos.Contains).ToArray();
            PhotoGrid.SelectedItems.Clear();
            foreach (var photo in availableSelection) PhotoGrid.SelectedItems.Add(photo);
            ViewModel.SyncSelectedPhotos(availableSelection);
            if (primary != null && ViewModel.Photos.Contains(primary)) ViewModel.SelectedPhoto = primary;
        }
        finally { _syncingBrowseSelection = false; }
    }

    private PhotoItem? BrowseScrollAnchor()
    {
        var list = PhotoGrid;
        var panel = list.ItemsPanelRoot;
        if (panel == null) return ViewModel.SelectedPhoto;
        PhotoItem? anchor = null;
        var firstY = double.PositiveInfinity;
        foreach (var child in panel.Children.OfType<FrameworkElement>())
        {
            var y = child.TransformToVisual(list).TransformPoint(default).Y;
            if (y + child.ActualHeight > 0 && y < list.ActualHeight && y < firstY &&
                list.ItemFromContainer(child) is PhotoItem photo)
            {
                anchor = photo;
                firstY = y;
            }
        }
        if (anchor != null) return anchor;
        return ViewModel.SelectedPhoto;
    }

    private void RestoreBrowseAnchor(PhotoItem? anchor)
    {
        if (anchor == null || !ViewModel.Photos.Contains(anchor)) return;
        DispatcherQueue.TryEnqueue(() =>
        {
            var list = PhotoGrid;
            ((FrameworkElement)Content).UpdateLayout();
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

}

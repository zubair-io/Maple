using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Maple.UI;

namespace Maple.UI.Pages
{
    /// <summary>
    /// Maple.UI Browse page (unified-component-catalog.md §6 — Split
    /// Layout template hosting Sidebar, Collection Grid, Timeline, Map
    /// Surface, and Toolbar). Windows Pages wave (#3012).
    ///
    /// Real cross-organism wiring, all funneled through the WinUI-free
    /// <see cref="MuiBrowsePageReducer"/>: picking a Sidebar folder
    /// filters the Collection Grid to that folder and its children;
    /// selecting a Map Surface cluster narrows the grid further to just
    /// those pins; the Timeline's "Last 14 days" range chip layers a
    /// recency filter on top of both. The Toolbar's Select All/Clear
    /// actions operate on whatever set is currently visible, not the
    /// full library — selecting "all" after a filter never reaches back
    /// into hidden folders.
    /// </summary>
    public sealed class MuiPageBrowse : ContentControl
    {
        private readonly MuiSidebar _sidebar = new();
        private readonly MuiToolbar _toolbar = new();
        private readonly MuiTimeline _timeline = new();
        private readonly MuiCollectionGrid _grid = new();
        private readonly MuiMapSurface _map = new();

        private string? _activeFolderId;
        private string _timelineRangeId = "all";
        private IReadOnlyList<string>? _mapSelection;
        private IReadOnlyList<string> _selectedIds = Array.Empty<string>();

        public MuiPageBrowse()
        {
            var header = new StackPanel { Orientation = Orientation.Vertical, Spacing = 12, Padding = new Thickness(16, 16, 16, 0) };
            header.Children.Add(_toolbar);
            header.Children.Add(_timeline);
            var gridHost = new Grid { Padding = new Thickness(16, 0, 16, 16) };
            gridHost.Children.Add(_grid);
            Grid.SetRow(gridHost, 1);

            var centerGrid = new Grid();
            centerGrid.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
            centerGrid.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
            Grid.SetRow(header, 0);
            centerGrid.Children.Add(header);
            centerGrid.Children.Add(gridHost);

            var split = new MuiSplitLayout
            {
                Sidebar = _sidebar,
                Center = centerGrid,
                Detail = _map,
                SidebarWidth = 220,
                DetailWidth = 300,
            };
            Content = split;
            HorizontalContentAlignment = HorizontalAlignment.Stretch;
            VerticalContentAlignment = VerticalAlignment.Stretch;

            _sidebar.Roots = BuildFolderTree();
            _sidebar.ToolbarEntries = new[]
            {
                MuiToolbarEntry.For(new MuiToolbarItem("import", "export", "Import")),
                MuiToolbarEntry.For(new MuiToolbarItem("new-album", "plus", "New Album")),
            };
            _sidebar.ItemActivated += (_, folderId) => { _activeFolderId = folderId; Recompute(); };

            _toolbar.Entries = new[]
            {
                MuiToolbarEntry.For(new MuiToolbarItem("select-all", "check", "Select All")),
                MuiToolbarEntry.For(new MuiToolbarItem("clear-selection", "x", "Clear")),
            };
            _toolbar.ItemSelected += (_, id) =>
            {
                _selectedIds = id == "select-all" ? CurrentVisibleIds() : Array.Empty<string>();
                _grid.SelectedIds = _selectedIds;
            };

            _timeline.RangeChips = new[] { new MuiChip("all", "All time"), new MuiChip("recent", "Last 14 days") };
            _timeline.SelectedRangeId = _timelineRangeId;
            _timeline.RangeSelected += (_, rangeId) => { _timelineRangeId = rangeId; Recompute(); };

            _grid.SelectionChanged += (_, ids) => { _selectedIds = ids; _grid.SelectedIds = ids; };

            _map.ClusterActivated += (_, ids) => { _mapSelection = ids; Recompute(); };

            _grid.EmptyTitle = "No photos in this view";
            Recompute();
        }

        private IReadOnlyList<string> CurrentVisibleIds()
        {
            if (_grid.Items is null) return Array.Empty<string>();
            return _grid.Items.Select(i => i.Id).ToList();
        }

        private void Recompute()
        {
            var byFolder = MuiBrowsePageReducer.VisibleAssetIds(MuiPageMockLibrary.Assets, _activeFolderId, _mapSelection);
            var visibleIds = MuiBrowsePageReducer.ApplyRecency(byFolder, MuiPageMockLibrary.Assets, _timelineRangeId, DateOnly.FromDateTime(DateTime.Today));
            var visibleSet = new HashSet<string>(visibleIds);
            var visibleAssets = MuiPageMockLibrary.Assets.Where(a => visibleSet.Contains(a.Id)).ToList();

            _sidebar.ActiveId = _activeFolderId;

            _grid.Items = visibleAssets.Select(ToGridItem).ToList();
            _selectedIds = _selectedIds.Where(visibleSet.Contains).ToList();
            _grid.SelectedIds = _selectedIds;

            _timeline.Items = visibleAssets
                .OrderByDescending(a => a.CapturedOn)
                .Select(a => new MuiTimelineItem(a.CapturedOn, ToGridItem(a)))
                .ToList();

            // MuiMapAsset.X/Y are the surface's own screen-space pixels,
            // not normalized fractions — MuiMockAsset.GeoX/GeoY (0..1) are
            // scaled against a nominal detail-pane canvas here so pins
            // land spread across the pane instead of clumped in one
            // corner near (0,0).
            _map.Assets = visibleAssets
                .Select(a => new MuiMapAsset(a.Id, a.GeoX * MapCanvasWidth, a.GeoY * MapCanvasHeight, MuiPageBitmap.ForAsset(a), a.Filename))
                .ToList();
        }

        private const double MapCanvasWidth = 260;
        private const double MapCanvasHeight = 500;

        private static MuiCollectionGridItem ToGridItem(MuiMockAsset asset) =>
            new(asset.Id, MuiPageBitmap.ForAsset(asset), asset.Filename, asset.Filename, Rating: asset.Rating);

        private static IReadOnlyList<MuiSidebarNode> BuildFolderTree()
        {
            MuiSidebarNode Build(MuiMockFolder folder)
            {
                var children = MuiPageMockLibrary.Folders
                    .Where(f => f.ParentId == folder.Id)
                    .Select(Build)
                    .ToList();
                return new MuiSidebarNode(
                    folder.Id, folder.Label, folder.IconName,
                    children.Count > 0 ? children : null,
                    MuiPageMockLibrary.CountFor(folder.Id));
            }

            return MuiPageMockLibrary.Folders.Where(f => f.ParentId is null).Select(Build).ToList();
        }
    }
}

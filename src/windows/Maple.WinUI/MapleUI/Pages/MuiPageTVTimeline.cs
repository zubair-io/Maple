using System.Collections.Generic;
using System.Linq;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Maple.UI;

namespace Maple.UI.Pages
{
    /// <summary>
    /// Maple.UI TV Timeline page (unified-component-catalog.md §6 — Tab
    /// Shell template hosting Timeline and Collection Grid as two tabs
    /// over the same filtered set). Windows Pages wave (#3012).
    ///
    /// Real wiring through <see cref="MuiTvTimelinePageReducer"/>: the
    /// Timeline's own range Chip Row picks which shoot is in view
    /// (Wedding/Iceland/Studio/All), and that selection carries over to
    /// the Grid tab too — switching tabs never resets the active range.
    /// </summary>
    public sealed class MuiPageTVTimeline : ContentControl
    {
        private readonly MuiTimeline _timeline = new();
        private readonly MuiCollectionGrid _grid = new();
        private readonly MuiTabShell _tabShell = new();
        private string _rangeId = "all";

        public MuiPageTVTimeline()
        {
            _timeline.RangeChips = new[]
            {
                new MuiChip("all", "All"),
                new MuiChip("wedding", "Ridgeline Farm Wedding"),
                new MuiChip("iceland", "Iceland Roadtrip"),
                new MuiChip("studio", "Studio Portraits"),
            };
            _timeline.SelectedRangeId = _rangeId;
            _timeline.RangeSelected += (_, rangeId) => { _rangeId = rangeId; _timeline.SelectedRangeId = rangeId; Refresh(); };

            var host = new Grid();
            host.Children.Add(_timeline);
            host.Children.Add(_grid);
            _grid.Visibility = Visibility.Collapsed;

            _tabShell.Tabs = new[] { new MuiTab("timeline", "Timeline"), new MuiTab("grid", "Grid") };
            _tabShell.ActiveId = "timeline";
            _tabShell.AriaLabel = "TV Timeline view";
            _tabShell.MainContent = host;
            _tabShell.ActiveIdChanged += (_, tabId) =>
            {
                _timeline.Visibility = tabId == "timeline" ? Visibility.Visible : Visibility.Collapsed;
                _grid.Visibility = tabId == "grid" ? Visibility.Visible : Visibility.Collapsed;
            };

            Content = _tabShell;
            HorizontalContentAlignment = HorizontalAlignment.Stretch;
            VerticalContentAlignment = VerticalAlignment.Stretch;

            Refresh();
        }

        private void Refresh()
        {
            var ids = new HashSet<string>(MuiTvTimelinePageReducer.AssetIdsForRange(MuiPageMockLibrary.Assets, _rangeId));
            var assets = MuiPageMockLibrary.Assets.Where(a => ids.Contains(a.Id)).ToList();

            _timeline.Items = assets
                .OrderByDescending(a => a.CapturedOn)
                .Select(a => new MuiTimelineItem(a.CapturedOn, ToGridItem(a)))
                .ToList();
            _grid.Items = assets.Select(ToGridItem).ToList();
        }

        private static MuiCollectionGridItem ToGridItem(MuiMockAsset asset) =>
            new(asset.Id, MuiPageBitmap.ForAsset(asset), asset.Filename, asset.Filename, Rating: asset.Rating);
    }
}

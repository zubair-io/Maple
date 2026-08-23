using System.Collections.Generic;
using System.Linq;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Maple.UI;
using Maple.UI.Atoms;

namespace Maple.UI.Pages
{
    /// <summary>
    /// Maple.UI TV Map page (unified-component-catalog.md §6 — Tab Shell
    /// template hosting a single Map Surface, tabbed by trip). Windows
    /// Pages wave (#3012).
    ///
    /// Real wiring through <see cref="MuiTvMapPageReducer"/>: past a
    /// pin-count threshold, individual pins stop being legible from a
    /// couch-distance TV screen, so the Map Surface switches to its
    /// heatmap density layer automatically — a tab with only 2-3 pins
    /// (Studio) stays as discrete pins, "All Trips" (12 pins) switches to
    /// heatmap.
    /// </summary>
    public sealed class MuiPageTVMap : ContentControl
    {
        private readonly MuiMapSurface _map = new();
        private readonly MuiText _selectionText = new() { Variant = MuiTextVariant.Body };
        private readonly MuiTabShell _tabShell = new();
        private string _tabId = "all";

        public MuiPageTVMap()
        {
            _map.ClusterActivated += (_, ids) =>
                _selectionText.Text = ids.Count == 0 ? "No pins selected" : $"{ids.Count} photo(s) selected";

            var host = new StackPanel { Orientation = Orientation.Vertical, Spacing = 8 };
            host.Children.Add(_selectionText);
            var mapHost = new Grid { Height = 400 };
            mapHost.Children.Add(_map);
            host.Children.Add(mapHost);

            _tabShell.Tabs = new[]
            {
                new MuiTab("all", "All Trips"),
                new MuiTab("wedding", "Ridgeline Farm Wedding"),
                new MuiTab("iceland", "Iceland Roadtrip"),
                new MuiTab("studio", "Studio Portraits"),
            };
            _tabShell.ActiveId = _tabId;
            _tabShell.AriaLabel = "TV Map trips";
            _tabShell.MainContent = host;
            _tabShell.ActiveIdChanged += (_, tabId) => { _tabId = tabId; Refresh(); };

            Content = _tabShell;
            HorizontalContentAlignment = HorizontalAlignment.Stretch;
            VerticalContentAlignment = VerticalAlignment.Stretch;

            Refresh();
        }

        private void Refresh()
        {
            var assets = _tabId == "all"
                ? MuiPageMockLibrary.Assets
                : MuiPageMockLibrary.Assets.Where(a => a.FolderId.StartsWith(_tabId)).ToList();

            // MuiMapAsset.X/Y are the surface's own screen-space pixels,
            // not normalized fractions — MuiMockAsset.GeoX/GeoY (0..1) are
            // scaled against a nominal full-width TV canvas here so pins
            // spread across the map instead of clumping near (0,0).
            _map.Assets = assets
                .Select(a => new MuiMapAsset(a.Id, a.GeoX * MapCanvasWidth, a.GeoY * MapCanvasHeight, MuiPageBitmap.ForAsset(a), a.Filename))
                .ToList();
            _map.ShowHeatmap = MuiTvMapPageReducer.ShouldShowHeatmap(assets.Count);
            _selectionText.Text = "No pins selected";
        }

        private const double MapCanvasWidth = 900;
        private const double MapCanvasHeight = 360;
    }
}

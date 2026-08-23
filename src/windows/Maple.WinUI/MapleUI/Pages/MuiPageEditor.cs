using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Maple.UI;

namespace Maple.UI.Pages
{
    /// <summary>
    /// Maple.UI Editor page (unified-component-catalog.md §6 — Split
    /// Layout template hosting Image Canvas, Tool Dock, Control Surface,
    /// Adjustments Panel, Inspector Panel, and Filmstrip). Windows Pages
    /// wave (#3012).
    ///
    /// The real wiring: every slider drag, whether it comes from the
    /// Tool Dock's currently-armed Control Surface or from the full
    /// Adjustments Panel tree, lands in ONE shared "slider id -&gt; value"
    /// map (<see cref="MuiEditorPageReducer"/>) — nudging Exposure from
    /// either surface updates the other's displayed value, the summary
    /// Value Chip row atop the Control Surface, and the Inspector
    /// Panel's read-only Info tab, all from the same source of truth.
    /// The Filmstrip switches which of three ceremony frames is loaded
    /// onto the Image Canvas.
    /// </summary>
    public sealed class MuiPageEditor : ContentControl
    {
        private static readonly MuiEditorPageReducer.SliderDef[] SliderDefs =
        {
            new("exposure", "Exposure", " EV"),
            new("contrast", "Contrast", ""),
            new("highlights", "Highlights", ""),
            new("shadows", "Shadows", ""),
            new("vibrance", "Vibrance", ""),
            new("saturation", "Saturation", ""),
            new("temp", "Temp", "K"),
            new("tint", "Tint", ""),
            new("texture", "Texture", ""),
            new("clarity", "Clarity", ""),
            new("dehaze", "Dehaze", ""),
        };

        private static readonly (string Id, string IconName, string Label)[] LightTools =
        {
            ("exposure", "tool-exposure", "Exposure"),
            ("contrast", "tool-contrast", "Contrast"),
            ("highlights", "tool-highlights", "Highlights"),
            ("shadows", "tool-shadows", "Shadows"),
        };

        private static readonly (string Id, string IconName, string Label)[] ColorTools =
        {
            ("vibrance", "tool-vibrance", "Vibrance"),
            ("saturation", "tool-saturation", "Saturation"),
            ("temp", "tool-temp", "Temp"),
            ("tint", "tool-tint", "Tint"),
        };

        private static readonly (string Id, string IconName, string Label)[] DetailTools =
        {
            ("texture", "tool-texture", "Texture"),
            ("clarity", "tool-clarity", "Clarity"),
            ("dehaze", "tool-dehaze", "Dehaze"),
        };

        private readonly MuiToolDock _toolDock = new();
        private readonly MuiImageCanvas _canvas = new();
        private readonly MuiFilmstrip _filmstrip = new();
        private readonly MuiControlSurface _controlSurface = new();
        private readonly MuiAdjustmentsPanel _adjustments = new();
        private readonly MuiInspectorPanel _inspector = new();
        private readonly MuiLabelValueGrid _infoGrid = new();

        private IReadOnlyDictionary<string, double> _values = new Dictionary<string, double>
        {
            ["exposure"] = 0.35,
            ["shadows"] = 12,
            ["vibrance"] = 8,
        };
        private string _armedToolId = "exposure";
        private string _activeAssetId;

        public MuiPageEditor()
        {
            var wedding = MuiPageMockLibrary.Assets.Where(a => a.FolderId == "wedding-ceremony").ToList();
            _activeAssetId = wedding[0].Id;

            _toolDock.Orientation = Orientation.Vertical;
            _toolDock.Groups = new[]
            {
                new MuiToolDockGroup(LightTools.Select(t => new MuiToolDockItem(t.Id, t.IconName, t.Label)).ToList()),
                new MuiToolDockGroup(ColorTools.Select(t => new MuiToolDockItem(t.Id, t.IconName, t.Label)).ToList()),
                new MuiToolDockGroup(DetailTools.Select(t => new MuiToolDockItem(t.Id, t.IconName, t.Label)).ToList()),
            };
            _toolDock.SelectedId = _armedToolId;
            _toolDock.SelectionChanged += (_, id) => { _armedToolId = id; RebuildControlSurface(); };

            _controlSurface.ValueChanged += (_, args) => ApplyValue(args.SliderId, args.Value);
            _adjustments.Categories = new[]
            {
                new MuiAdjustmentCategory("basic", "Basic", new[]
                {
                    new MuiAdjustmentGroup("light", "Light", LightTools.Select(ToSliderSpec).ToList()),
                    new MuiAdjustmentGroup("color", "Color", ColorTools.Select(ToSliderSpec).ToList()),
                }),
                new MuiAdjustmentCategory("detail", "Detail", new[]
                {
                    new MuiAdjustmentGroup("detail", "Detail", DetailTools.Select(ToSliderSpec).ToList()),
                }),
            };
            _adjustments.ActiveCategoryId = "basic";
            _adjustments.ValueChanged += (_, args) => ApplyValue(args.SliderId, args.Value);

            _inspector.Title = wedding[0].Filename;
            _inspector.Tabs = new[] { new MuiTab("adjust", "Adjust"), new MuiTab("info", "Info") };
            _inspector.ActiveTabId = "adjust";
            _inspector.TabContents = new Dictionary<string, UIElement>
            {
                ["adjust"] = _adjustments,
                ["info"] = _infoGrid,
            };

            _filmstrip.Items = wedding.Select(a => new MuiFilmstripItem(a.Id, MuiPageBitmap.ForAsset(a), a.Filename)).ToList();
            _filmstrip.ActiveId = _activeAssetId;
            _filmstrip.Activated += (_, id) => { _activeAssetId = id; RebuildCanvas(); RebuildInspectorTitle(); };

            _canvas.ImageWidth = 640;
            _canvas.ImageHeight = 427;
            _canvas.Zoom = 1.0;

            var centerGrid = new Grid();
            centerGrid.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
            centerGrid.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
            Grid.SetRow(_canvas, 0);
            Grid.SetRow(_filmstrip, 1);
            centerGrid.Children.Add(_canvas);
            centerGrid.Children.Add(_filmstrip);

            var detail = new StackPanel { Orientation = Orientation.Vertical, Spacing = 12 };
            detail.Children.Add(_controlSurface);
            var inspectorHost = new Grid();
            inspectorHost.Children.Add(_inspector);
            detail.Children.Add(inspectorHost);

            var split = new MuiSplitLayout
            {
                Sidebar = _toolDock,
                Center = centerGrid,
                Detail = detail,
                SidebarWidth = 72,
                SidebarMin = 72,
                SidebarMax = 72,
                DetailWidth = 320,
            };
            Content = split;
            HorizontalContentAlignment = HorizontalAlignment.Stretch;
            VerticalContentAlignment = VerticalAlignment.Stretch;

            RebuildCanvas();
            RebuildControlSurface();
            RebuildAdjustmentsValues();
            RebuildInfoGrid();
        }

        private static MuiAdjustmentSlider ToSliderSpec((string Id, string IconName, string Label) tool) =>
            new(tool.Id, tool.Label, 0, -100, 100);

        private void ApplyValue(string sliderId, double value)
        {
            _values = MuiEditorPageReducer.WithValue(_values, sliderId, value);
            RebuildControlSurface();
            RebuildAdjustmentsValues();
            RebuildInfoGrid();
        }

        private void RebuildCanvas()
        {
            var asset = MuiPageMockLibrary.Assets.First(a => a.Id == _activeAssetId);
            _canvas.Source = MuiPageBitmap.ForAsset(asset);
            _filmstrip.ActiveId = _activeAssetId;
        }

        private void RebuildInspectorTitle()
        {
            var asset = MuiPageMockLibrary.Assets.First(a => a.Id == _activeAssetId);
            _inspector.Title = asset.Filename;
        }

        private void RebuildControlSurface()
        {
            var def = SliderDefs.First(d => d.Id == _armedToolId);
            var value = _values.TryGetValue(_armedToolId, out var v) ? v : 0;
            _controlSurface.ToolLabel = def.Label;
            _controlSurface.Sliders = new[] { new MuiAdjustmentSlider(def.Id, def.Label, value, -100, 100) };
            _controlSurface.ValueChips = MuiEditorPageReducer.ValueChips(_values, SliderDefs)
                .Select(c => new MuiControlSurfaceValueChip(c.Label, c.Value))
                .ToList();
        }

        private void RebuildAdjustmentsValues()
        {
            IReadOnlyList<MuiAdjustmentSlider> WithValues((string Id, string IconName, string Label)[] tools) =>
                tools.Select(t => new MuiAdjustmentSlider(t.Id, t.Label, _values.TryGetValue(t.Id, out var v) ? v : 0, -100, 100)).ToList();

            _adjustments.Categories = new[]
            {
                new MuiAdjustmentCategory("basic", "Basic", new[]
                {
                    new MuiAdjustmentGroup("light", "Light", WithValues(LightTools)),
                    new MuiAdjustmentGroup("color", "Color", WithValues(ColorTools)),
                }),
                new MuiAdjustmentCategory("detail", "Detail", new[]
                {
                    new MuiAdjustmentGroup("detail", "Detail", WithValues(DetailTools)),
                }),
            };
        }

        private void RebuildInfoGrid()
        {
            var rows = MuiEditorPageReducer.ValueChips(_values, SliderDefs)
                .Select(c => new MuiLabelValueRow(c.Label, c.Value))
                .ToList();
            _infoGrid.Rows = rows.Count > 0
                ? rows
                : (IReadOnlyList<MuiLabelValueRow>)new[] { new MuiLabelValueRow("Adjustments", "None yet") };
        }
    }
}

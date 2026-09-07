using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Maple.UI.Atoms;

namespace Maple.UI
{
    /// <summary>One row in <see cref="MuiMaskPanel.Layers"/>: display text
    /// only — the panel never mutates the layer stack itself, it only
    /// raises events for the host to apply (mask-panel.md § Props: "Writes:
    /// through the mask session's API only").</summary>
    public readonly record struct MuiMaskLayerRow(string Id, string Name, string Subtitle, bool Selected, bool IsRadial);

    /// <summary>The eleven controls a mask layer can carry — a plain mirror
    /// of raw-core's `PartialAdjustments`, kept local to this design-system
    /// layer the same way <see cref="MuiCropRect"/> stays independent of
    /// <c>Maple.WinUI.Models.CropState</c>. `null` means "not set" (a true
    /// no-op on render), distinct from `0`.</summary>
    public readonly record struct MuiPartialAdjustments(
        double? Exposure = null, double? Contrast = null, double? Highlights = null, double? Shadows = null,
        double? Whites = null, double? Blacks = null, double? Saturation = null, double? Vibrance = null,
        double? Temperature = null, double? Tint = null, double? Hue = null);

    /// <summary>
    /// Maple.UI Mask Panel organism (docs/design/maple-ui/components/
    /// mask-panel.md) — add linear/radial, one List Row per layer with a
    /// trailing delete Button, and for the selected layer: Feather, Invert
    /// (radial only), the eleven local develop controls, and Reset. Composed
    /// entirely from Maple.UI molecules/atoms (List Row, Button, Drag Bar,
    /// Checkbox) per the contract — no ad-hoc XAML controls.
    ///
    /// The eleven controls are built ONCE in the constructor and their
    /// values updated in place on every <see cref="Adjustments"/> change
    /// rather than rebuilt, so a slider mid-drag never loses its own pointer
    /// capture when the host round-trips a committed value back down
    /// through this control (the same reason <see cref="MuiCropToolbar"/>
    /// mutates its inner molecules' values instead of replacing them).
    /// </summary>
    public sealed class MuiMaskPanel : ContentControl
    {
        private static readonly (string Field, string Label, double Min, double Max, double Step,
            Func<MuiPartialAdjustments, double?> Get)[] ControlDescriptors =
        {
            ("Exposure", "Exposure", -4, 4, 0.05, a => a.Exposure),
            ("Contrast", "Contrast", -100, 100, 1, a => a.Contrast),
            ("Highlights", "Highlights", -100, 100, 1, a => a.Highlights),
            ("Shadows", "Shadows", -100, 100, 1, a => a.Shadows),
            ("Whites", "Whites", -100, 100, 1, a => a.Whites),
            ("Blacks", "Blacks", -100, 100, 1, a => a.Blacks),
            ("Saturation", "Saturation", -100, 100, 1, a => a.Saturation),
            ("Vibrance", "Vibrance", -100, 100, 1, a => a.Vibrance),
            ("Temperature", "Temp", -2000, 2000, 10, a => a.Temperature),
            ("Tint", "Tint", -100, 100, 1, a => a.Tint),
            ("Hue", "Hue", -100, 100, 1, a => a.Hue),
        };

        public static readonly DependencyProperty LayersProperty =
            DependencyProperty.Register(nameof(Layers), typeof(IReadOnlyList<MuiMaskLayerRow>), typeof(MuiMaskPanel),
                new PropertyMetadata(Array.Empty<MuiMaskLayerRow>(), (d, _) => ((MuiMaskPanel)d).RebuildLayerList()));

        public static readonly DependencyProperty FeatherProperty =
            DependencyProperty.Register(nameof(Feather), typeof(double), typeof(MuiMaskPanel),
                new PropertyMetadata(50.0, (d, e) => ((MuiMaskPanel)d)._featherBar.Value = (double)e.NewValue));

        public static readonly DependencyProperty InvertProperty =
            DependencyProperty.Register(nameof(Invert), typeof(bool), typeof(MuiMaskPanel),
                new PropertyMetadata(false, (d, e) => ((MuiMaskPanel)d)._invertCheckbox.IsChecked = (bool)e.NewValue));

        public static readonly DependencyProperty AdjustmentsProperty =
            DependencyProperty.Register(nameof(Adjustments), typeof(MuiPartialAdjustments), typeof(MuiMaskPanel),
                new PropertyMetadata(default(MuiPartialAdjustments), (d, _) => ((MuiMaskPanel)d).SyncControlValues()));

        public IReadOnlyList<MuiMaskLayerRow> Layers
        {
            get => (IReadOnlyList<MuiMaskLayerRow>)GetValue(LayersProperty);
            set => SetValue(LayersProperty, value);
        }

        /// <summary>0-100, a percentage of the mask's own extent (feather.md
        /// convention shared with Vignette Feather).</summary>
        public double Feather { get => (double)GetValue(FeatherProperty); set => SetValue(FeatherProperty, value); }

        public bool Invert { get => (bool)GetValue(InvertProperty); set => SetValue(InvertProperty, value); }

        public MuiPartialAdjustments Adjustments
        {
            get => (MuiPartialAdjustments)GetValue(AdjustmentsProperty);
            set => SetValue(AdjustmentsProperty, value);
        }

        public event EventHandler? AddLinearRequested;
        public event EventHandler? AddRadialRequested;
        public event EventHandler<int>? LayerSelected;
        public event EventHandler<int>? LayerDeleteRequested;
        public event EventHandler<double>? FeatherChanged;
        public event EventHandler<bool>? InvertChanged;
        public event EventHandler<(string Field, double Value)>? AdjustmentChanged;
        public event EventHandler? ResetRequested;

        private readonly StackPanel _root = new() { Spacing = 10 };
        private readonly MuiButton _addLinear = new() { Label = "Add linear mask", Variant = MuiButtonVariant.Secondary, ButtonSize = MuiButtonSize.Sm };
        private readonly MuiButton _addRadial = new() { Label = "Add radial mask", Variant = MuiButtonVariant.Secondary, ButtonSize = MuiButtonSize.Sm };
        private readonly MuiText _emptyHint = new() { Text = "No masks yet — add a linear or radial layer to start a local edit.", Variant = MuiTextVariant.Body, ColorRole = MuiTextColorRole.Muted };
        private readonly StackPanel _layerList = new() { Spacing = 2 };
        private readonly StackPanel _selectedHost = new() { Spacing = 10, Visibility = Visibility.Collapsed };
        private readonly MuiDragBar _featherBar = new() { Label = "Feather", Minimum = 0, Maximum = 100, Step = 1 };
        private readonly MuiCheckbox _invertCheckbox = new() { Label = "Invert" };
        private readonly Dictionary<string, MuiDragBar> _controlBars = new();
        private readonly MuiButton _resetButton = new() { Label = "Reset", Variant = MuiButtonVariant.Ghost, ButtonSize = MuiButtonSize.Sm };

        public MuiMaskPanel()
        {
            var addRow = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8 };
            addRow.Children.Add(_addLinear);
            addRow.Children.Add(_addRadial);
            _root.Children.Add(addRow);
            _root.Children.Add(_emptyHint);
            _root.Children.Add(_layerList);

            _selectedHost.Children.Add(_featherBar);
            _selectedHost.Children.Add(_invertCheckbox);
            foreach (var (field, label, min, max, step, _) in ControlDescriptors)
            {
                var bar = new MuiDragBar { Label = label, Minimum = min, Maximum = max, Step = step };
                bar.ValueChanged += (_, v) => AdjustmentChanged?.Invoke(this, (field, v));
                _controlBars[field] = bar;
                _selectedHost.Children.Add(bar);
            }
            _selectedHost.Children.Add(_resetButton);
            _root.Children.Add(_selectedHost);
            Content = _root;

            _addLinear.Click += (_, _) => AddLinearRequested?.Invoke(this, EventArgs.Empty);
            _addRadial.Click += (_, _) => AddRadialRequested?.Invoke(this, EventArgs.Empty);
            _featherBar.ValueChanged += (_, v) => FeatherChanged?.Invoke(this, v);
            _invertCheckbox.Checked += (_, _) => InvertChanged?.Invoke(this, true);
            _invertCheckbox.Unchecked += (_, _) => InvertChanged?.Invoke(this, false);
            _resetButton.Click += (_, _) => ResetRequested?.Invoke(this, EventArgs.Empty);
            AutomationProperties.SetName(_addLinear, "Add linear mask");
            AutomationProperties.SetName(_addRadial, "Add radial mask");
            AutomationProperties.SetName(_resetButton, "Reset mask adjustments");
            AutomationProperties.SetName(this, "Mask panel");

            RebuildLayerList();
        }

        private void SyncControlValues()
        {
            var a = Adjustments;
            foreach (var (field, _, _, _, _, get) in ControlDescriptors)
                _controlBars[field].Value = get(a) ?? 0;
        }

        private void RebuildLayerList()
        {
            _layerList.Children.Clear();
            var layers = Layers;
            _emptyHint.Visibility = layers.Count == 0 ? Visibility.Visible : Visibility.Collapsed;
            var hasSelection = false;
            for (var i = 0; i < layers.Count; i++)
            {
                var row = layers[i];
                hasSelection |= row.Selected;
                var index = i;
                var delete = new MuiButton { IconName = "trash", Variant = MuiButtonVariant.Ghost, ButtonSize = MuiButtonSize.Sm };
                AutomationProperties.SetName(delete, $"Delete {row.Name}");
                delete.Click += (_, _) => LayerDeleteRequested?.Invoke(this, index);
                var listRow = new MuiListRow
                {
                    IconName = row.IsRadial ? "tool-vignette" : "tool-dehaze",
                    Label = row.Name,
                    Active = row.Selected,
                    TrailingContent = delete,
                };
                AutomationProperties.SetName(listRow, string.IsNullOrEmpty(row.Subtitle) ? row.Name : $"{row.Name}, {row.Subtitle}");
                listRow.Pressed += (_, _) => LayerSelected?.Invoke(this, index);
                _layerList.Children.Add(listRow);
            }
            _selectedHost.Visibility = hasSelection ? Visibility.Visible : Visibility.Collapsed;
            _invertCheckbox.Visibility = hasSelection && layers.Any(l => l.Selected && l.IsRadial)
                ? Visibility.Visible : Visibility.Collapsed;
        }
    }
}

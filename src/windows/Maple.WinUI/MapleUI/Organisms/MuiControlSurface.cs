using System;
using System.Collections.Generic;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Maple.UI.Atoms;

namespace Maple.UI
{
    /// <summary>One value-chip summary shown atop a Control Surface
    /// (e.g. "Exposure +0.3").</summary>
    public sealed record MuiControlSurfaceValueChip(string Label, string Value);

    /// <summary>
    /// Maple.UI Control Surface organism (unified-component-catalog.md
    /// §4.5, "Control Surface" row: "Panel for the armed tool", built
    /// from Tabs, Living Slider, Chip Row, Value Chip) — whichever tool
    /// is currently armed (from a <see cref="MuiToolDock"/>) renders its
    /// own parameter set here: an optional mode <see cref="MuiChipRow"/>,
    /// a mode <see cref="MuiTabs"/> strip, its <see cref="MuiLivingSlider"/>s,
    /// and a row of read-only <see cref="MuiValueChip"/> summaries.
    /// </summary>
    public sealed class MuiControlSurface : ContentControl
    {
        public static readonly DependencyProperty ToolLabelProperty =
            DependencyProperty.Register(nameof(ToolLabel), typeof(string), typeof(MuiControlSurface),
                new PropertyMetadata(string.Empty, (d, _) => ((MuiControlSurface)d).Rebuild()));

        public static readonly DependencyProperty ModeTabsProperty =
            DependencyProperty.Register(nameof(ModeTabs), typeof(IReadOnlyList<MuiTab>), typeof(MuiControlSurface),
                new PropertyMetadata(null, (d, e) => ((MuiControlSurface)d)._modeTabs.Tabs = (IReadOnlyList<MuiTab>?)e.NewValue));

        public static readonly DependencyProperty ActiveModeIdProperty =
            DependencyProperty.Register(nameof(ActiveModeId), typeof(string), typeof(MuiControlSurface),
                new PropertyMetadata(string.Empty, (d, e) => ((MuiControlSurface)d)._modeTabs.ActiveId = (string)e.NewValue));

        public static readonly DependencyProperty SlidersProperty =
            DependencyProperty.Register(nameof(Sliders), typeof(IReadOnlyList<MuiAdjustmentSlider>), typeof(MuiControlSurface),
                new PropertyMetadata(null, (d, _) => ((MuiControlSurface)d).Rebuild()));

        public static readonly DependencyProperty ValueChipsProperty =
            DependencyProperty.Register(nameof(ValueChips), typeof(IReadOnlyList<MuiControlSurfaceValueChip>), typeof(MuiControlSurface),
                new PropertyMetadata(null, (d, _) => ((MuiControlSurface)d).Rebuild()));

        public string ToolLabel { get => (string)GetValue(ToolLabelProperty); set => SetValue(ToolLabelProperty, value); }

        public IReadOnlyList<MuiTab>? ModeTabs
        {
            get => (IReadOnlyList<MuiTab>?)GetValue(ModeTabsProperty);
            set => SetValue(ModeTabsProperty, value);
        }

        public string ActiveModeId { get => (string)GetValue(ActiveModeIdProperty); set => SetValue(ActiveModeIdProperty, value); }

        public IReadOnlyList<MuiAdjustmentSlider>? Sliders
        {
            get => (IReadOnlyList<MuiAdjustmentSlider>?)GetValue(SlidersProperty);
            set => SetValue(SlidersProperty, value);
        }

        public IReadOnlyList<MuiControlSurfaceValueChip>? ValueChips
        {
            get => (IReadOnlyList<MuiControlSurfaceValueChip>?)GetValue(ValueChipsProperty);
            set => SetValue(ValueChipsProperty, value);
        }

        public event EventHandler<string>? ModeChanged;
        public event EventHandler<(string SliderId, double Value)>? ValueChanged;

        private readonly StackPanel _root = new() { Orientation = Orientation.Vertical, Spacing = 12 };
        private readonly MuiText _title = new() { Variant = MuiTextVariant.RowLabel };
        private readonly StackPanel _valueRow = new() { Orientation = Orientation.Horizontal, Spacing = 8 };
        private readonly MuiTabs _modeTabs = new();
        private readonly StackPanel _sliders = new() { Orientation = Orientation.Vertical, Spacing = 14 };

        public MuiControlSurface()
        {
            _root.Children.Add(_title);
            _root.Children.Add(_valueRow);
            _root.Children.Add(_modeTabs);
            _root.Children.Add(_sliders);
            Content = _root;

            _modeTabs.SelectionChanged += (_, id) => { ActiveModeId = id; ModeChanged?.Invoke(this, id); };

            Rebuild();
        }

        private void Rebuild()
        {
            _title.Text = ToolLabel;

            _valueRow.Children.Clear();
            foreach (var chip in ValueChips ?? Array.Empty<MuiControlSurfaceValueChip>())
                _valueRow.Children.Add(new MuiValueChip { Label = chip.Label, Value = chip.Value });

            _sliders.Children.Clear();
            foreach (var spec in Sliders ?? Array.Empty<MuiAdjustmentSlider>())
            {
                var slider = new MuiLivingSlider
                {
                    Label = spec.Label,
                    Value = spec.Value,
                    Minimum = spec.Minimum,
                    Maximum = spec.Maximum,
                    Step = spec.Step,
                    Unit = spec.Unit,
                    Bipolar = spec.Bipolar,
                };
                var sliderId = spec.Id;
                slider.ValueChanged += (_, value) => ValueChanged?.Invoke(this, (sliderId, value));
                _sliders.Children.Add(slider);
            }
        }
    }
}

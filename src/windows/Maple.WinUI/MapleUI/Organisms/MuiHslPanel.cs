using System;
using System.Collections.Generic;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace Maple.UI
{
    /// <summary>The per-band Hue/Saturation/Luminance triple an HSL Panel
    /// edits for one color band.</summary>
    public sealed record MuiHslBandValue(double Hue, double Saturation, double Luminance);

    /// <summary>
    /// Maple.UI HSL Panel organism (unified-component-catalog.md §4.3,
    /// "HSL Panel" row: "Per-band hue / sat / luminance", built from Chip
    /// Row, Living Slider) — an 8-band <see cref="MuiChipRow"/> (Reds,
    /// Oranges, Yellows, Greens, Aquas, Blues, Purples, Magentas, matching
    /// Maple's own band names) selects which band the three
    /// <see cref="MuiLivingSlider"/>s below edit.
    /// </summary>
    public sealed class MuiHslPanel : ContentControl
    {
        public static readonly IReadOnlyList<MuiChip> Bands = new[]
        {
            new MuiChip("red", "Reds"), new MuiChip("orange", "Oranges"), new MuiChip("yellow", "Yellows"),
            new MuiChip("green", "Greens"), new MuiChip("aqua", "Aquas"), new MuiChip("blue", "Blues"),
            new MuiChip("purple", "Purples"), new MuiChip("magenta", "Magentas"),
        };

        public static readonly DependencyProperty SelectedBandProperty =
            DependencyProperty.Register(nameof(SelectedBand), typeof(string), typeof(MuiHslPanel),
                new PropertyMetadata("red", (d, _) => ((MuiHslPanel)d).Rebuild()));

        public static readonly DependencyProperty ValuesProperty =
            DependencyProperty.Register(nameof(Values), typeof(IReadOnlyDictionary<string, MuiHslBandValue>), typeof(MuiHslPanel),
                new PropertyMetadata(null, (d, _) => ((MuiHslPanel)d).Rebuild()));

        public string SelectedBand { get => (string)GetValue(SelectedBandProperty); set => SetValue(SelectedBandProperty, value); }

        public IReadOnlyDictionary<string, MuiHslBandValue>? Values
        {
            get => (IReadOnlyDictionary<string, MuiHslBandValue>?)GetValue(ValuesProperty);
            set => SetValue(ValuesProperty, value);
        }

        public event EventHandler<string>? BandSelected;
        public event EventHandler<(string Band, MuiHslBandValue Value)>? ValueChanged;

        private readonly StackPanel _root = new() { Orientation = Orientation.Vertical, Spacing = 16 };
        private readonly MuiChipRow _bandChips = new() { Mode = MuiChipRowMode.Select, Chips = Bands };
        private readonly MuiLivingSlider _hue = new() { Label = "Hue", Minimum = -100, Maximum = 100, Bipolar = true };
        private readonly MuiLivingSlider _saturation = new() { Label = "Saturation", Minimum = -100, Maximum = 100, Bipolar = true };
        private readonly MuiLivingSlider _luminance = new() { Label = "Luminance", Minimum = -100, Maximum = 100, Bipolar = true };

        public MuiHslPanel()
        {
            _root.Children.Add(_bandChips);
            _root.Children.Add(_hue);
            _root.Children.Add(_saturation);
            _root.Children.Add(_luminance);
            Content = _root;

            _bandChips.SelectionChanged += (_, id) => { SelectedBand = id; BandSelected?.Invoke(this, id); };
            _hue.ValueChanged += (_, v) => Commit(v, _saturation.Value, _luminance.Value);
            _saturation.ValueChanged += (_, v) => Commit(_hue.Value, v, _luminance.Value);
            _luminance.ValueChanged += (_, v) => Commit(_hue.Value, _saturation.Value, v);

            Rebuild();
        }

        private void Commit(double hue, double saturation, double luminance) =>
            ValueChanged?.Invoke(this, (SelectedBand, new MuiHslBandValue(hue, saturation, luminance)));

        private void Rebuild()
        {
            _bandChips.SelectedId = SelectedBand;
            var value = Values is not null && Values.TryGetValue(SelectedBand, out var v) ? v : new MuiHslBandValue(0, 0, 0);
            _hue.Value = value.Hue;
            _saturation.Value = value.Saturation;
            _luminance.Value = value.Luminance;
        }
    }
}

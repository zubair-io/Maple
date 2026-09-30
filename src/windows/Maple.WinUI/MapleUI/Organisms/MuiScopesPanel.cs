using System.Collections.Generic;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace Maple.UI
{
    /// <summary>
    /// Maple.UI Scopes Panel organism (unified-component-catalog.md §4.3,
    /// "Scopes Panel" row: "Pinned four-up scope stack", built from
    /// Histogram, Waveform, Parade, Vectorscope) — the four scopes in a
    /// fixed 2x2 grid, all reading the same live per-pixel sample data.
    /// </summary>
    public sealed class MuiScopesPanel : ContentControl
    {
        public static readonly DependencyProperty RedValuesProperty =
            DependencyProperty.Register(nameof(RedValues), typeof(IReadOnlyList<double>), typeof(MuiScopesPanel),
                new PropertyMetadata(null, (d, e) =>
                {
                    var self = (MuiScopesPanel)d;
                    self._histogram.RedValues = (IReadOnlyList<double>?)e.NewValue;
                }));

        public static readonly DependencyProperty GreenValuesProperty =
            DependencyProperty.Register(nameof(GreenValues), typeof(IReadOnlyList<double>), typeof(MuiScopesPanel),
                new PropertyMetadata(null, (d, e) =>
                {
                    var self = (MuiScopesPanel)d;
                    self._histogram.GreenValues = (IReadOnlyList<double>?)e.NewValue;
                }));

        public static readonly DependencyProperty BlueValuesProperty =
            DependencyProperty.Register(nameof(BlueValues), typeof(IReadOnlyList<double>), typeof(MuiScopesPanel),
                new PropertyMetadata(null, (d, e) =>
                {
                    var self = (MuiScopesPanel)d;
                    self._histogram.BlueValues = (IReadOnlyList<double>?)e.NewValue;
                }));

        public static readonly DependencyProperty LumaValuesProperty =
            DependencyProperty.Register(nameof(LumaValues), typeof(IReadOnlyList<double>), typeof(MuiScopesPanel),
                new PropertyMetadata(null, (d, e) => ((MuiScopesPanel)d)._waveform.Luma = (IReadOnlyList<double>?)e.NewValue));

        public static readonly DependencyProperty SamplesProperty =
            DependencyProperty.Register(nameof(Samples), typeof(IReadOnlyList<MuiVectorscopeSample>), typeof(MuiScopesPanel),
                new PropertyMetadata(null, (d, e) => ((MuiScopesPanel)d)._vectorscope.Samples = (IReadOnlyList<MuiVectorscopeSample>?)e.NewValue));

        // Histogram counts and parade column means are different quantities.
        // Keep separate inputs, matching the Apple/web scopes sample (#3885).
        public static readonly DependencyProperty ParadeRedValuesProperty =
            DependencyProperty.Register(nameof(ParadeRedValues), typeof(IReadOnlyList<double>), typeof(MuiScopesPanel),
                new PropertyMetadata(null, (d, e) => ((MuiScopesPanel)d)._parade.RedValues = (IReadOnlyList<double>?)e.NewValue));
        public static readonly DependencyProperty ParadeGreenValuesProperty =
            DependencyProperty.Register(nameof(ParadeGreenValues), typeof(IReadOnlyList<double>), typeof(MuiScopesPanel),
                new PropertyMetadata(null, (d, e) => ((MuiScopesPanel)d)._parade.GreenValues = (IReadOnlyList<double>?)e.NewValue));
        public static readonly DependencyProperty ParadeBlueValuesProperty =
            DependencyProperty.Register(nameof(ParadeBlueValues), typeof(IReadOnlyList<double>), typeof(MuiScopesPanel),
                new PropertyMetadata(null, (d, e) => ((MuiScopesPanel)d)._parade.BlueValues = (IReadOnlyList<double>?)e.NewValue));

        public IReadOnlyList<double>? ParadeRedValues { get => (IReadOnlyList<double>?)GetValue(ParadeRedValuesProperty); set => SetValue(ParadeRedValuesProperty, value); }
        public IReadOnlyList<double>? ParadeGreenValues { get => (IReadOnlyList<double>?)GetValue(ParadeGreenValuesProperty); set => SetValue(ParadeGreenValuesProperty, value); }
        public IReadOnlyList<double>? ParadeBlueValues { get => (IReadOnlyList<double>?)GetValue(ParadeBlueValuesProperty); set => SetValue(ParadeBlueValuesProperty, value); }

        public IReadOnlyList<double>? RedValues { get => (IReadOnlyList<double>?)GetValue(RedValuesProperty); set => SetValue(RedValuesProperty, value); }
        public static readonly DependencyProperty VectorscopeBinsProperty =
            DependencyProperty.Register(nameof(VectorscopeBins), typeof(IReadOnlyList<uint>), typeof(MuiScopesPanel),
                new PropertyMetadata(null, (d, e) => ((MuiScopesPanel)d)._vectorscope.Bins = (IReadOnlyList<uint>?)e.NewValue));
        public IReadOnlyList<uint>? VectorscopeBins { get => (IReadOnlyList<uint>?)GetValue(VectorscopeBinsProperty); set => SetValue(VectorscopeBinsProperty, value); }
        public IReadOnlyList<double>? GreenValues { get => (IReadOnlyList<double>?)GetValue(GreenValuesProperty); set => SetValue(GreenValuesProperty, value); }
        public IReadOnlyList<double>? BlueValues { get => (IReadOnlyList<double>?)GetValue(BlueValuesProperty); set => SetValue(BlueValuesProperty, value); }
        public IReadOnlyList<double>? LumaValues { get => (IReadOnlyList<double>?)GetValue(LumaValuesProperty); set => SetValue(LumaValuesProperty, value); }
        public IReadOnlyList<MuiVectorscopeSample>? Samples { get => (IReadOnlyList<MuiVectorscopeSample>?)GetValue(SamplesProperty); set => SetValue(SamplesProperty, value); }

        private readonly Grid _root = new();
        private readonly MuiHistogram _histogram = new() { PlotWidth = 150, PlotHeight = 100 };
        private readonly MuiWaveform _waveform = new() { PlotWidth = 150, PlotHeight = 100 };
        private readonly MuiParade _parade = new() { PlotWidth = 150, PlotHeight = 100 };
        private readonly MuiVectorscope _vectorscope = new() { ScopeSize = 150 };

        public MuiScopesPanel()
        {
            _root.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            _root.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            _root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
            _root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
            _root.ColumnSpacing = 10;
            _root.RowSpacing = 10;

            Place(_histogram, "Histogram", 0, 0);
            Place(_waveform, "Luma waveform", 0, 1);
            Place(_parade, "RGB parade", 1, 0);
            Place(_vectorscope, "Vectorscope", 1, 1);
            Content = _root;
        }

        private void Place(FrameworkElement element, string title, int row, int column)
        {
            var cell = new StackPanel { Spacing = 4 };
            cell.Children.Add(new TextBlock { Text = title, FontSize = 12 });
            Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(element, title);
            cell.Children.Add(element);
            Grid.SetRow(cell, row);
            Grid.SetColumn(cell, column);
            _root.Children.Add(cell);
        }
    }
}

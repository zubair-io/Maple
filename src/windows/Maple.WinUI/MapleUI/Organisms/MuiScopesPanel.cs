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
                    self._parade.RedValues = (IReadOnlyList<double>?)e.NewValue;
                }));

        public static readonly DependencyProperty GreenValuesProperty =
            DependencyProperty.Register(nameof(GreenValues), typeof(IReadOnlyList<double>), typeof(MuiScopesPanel),
                new PropertyMetadata(null, (d, e) =>
                {
                    var self = (MuiScopesPanel)d;
                    self._histogram.GreenValues = (IReadOnlyList<double>?)e.NewValue;
                    self._parade.GreenValues = (IReadOnlyList<double>?)e.NewValue;
                }));

        public static readonly DependencyProperty BlueValuesProperty =
            DependencyProperty.Register(nameof(BlueValues), typeof(IReadOnlyList<double>), typeof(MuiScopesPanel),
                new PropertyMetadata(null, (d, e) =>
                {
                    var self = (MuiScopesPanel)d;
                    self._histogram.BlueValues = (IReadOnlyList<double>?)e.NewValue;
                    self._parade.BlueValues = (IReadOnlyList<double>?)e.NewValue;
                }));

        public static readonly DependencyProperty LumaValuesProperty =
            DependencyProperty.Register(nameof(LumaValues), typeof(IReadOnlyList<double>), typeof(MuiScopesPanel),
                new PropertyMetadata(null, (d, e) => ((MuiScopesPanel)d)._waveform.Luma = (IReadOnlyList<double>?)e.NewValue));

        public static readonly DependencyProperty SamplesProperty =
            DependencyProperty.Register(nameof(Samples), typeof(IReadOnlyList<MuiVectorscopeSample>), typeof(MuiScopesPanel),
                new PropertyMetadata(null, (d, e) => ((MuiScopesPanel)d)._vectorscope.Samples = (IReadOnlyList<MuiVectorscopeSample>?)e.NewValue));

        public IReadOnlyList<double>? RedValues { get => (IReadOnlyList<double>?)GetValue(RedValuesProperty); set => SetValue(RedValuesProperty, value); }
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

            Place(_histogram, 0, 0);
            Place(_waveform, 0, 1);
            Place(_parade, 1, 0);
            Place(_vectorscope, 1, 1);
            Content = _root;
        }

        private void Place(FrameworkElement element, int row, int column)
        {
            Grid.SetRow(element, row);
            Grid.SetColumn(element, column);
            _root.Children.Add(element);
        }
    }
}

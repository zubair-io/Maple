using System;
using System.Collections.Generic;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Shapes;
using Windows.UI;

namespace Maple.UI
{
    /// <summary>
    /// Maple.UI Parade data plot (unified-component-catalog.md §2.6,
    /// "Parade" row: "Three-channel waveform", built from _(plot
    /// primitive)_) — three side-by-side per-channel waveforms, drawn the
    /// same hand-rolled-Shapes way <see cref="MuiHistogram"/> is. Like
    /// Histogram, the R/G/B colors are literal channel identity, not theme
    /// tokens. Per-column samples are expected 0..1 (one array per
    /// channel) — each lane clamps directly rather than scaling against a
    /// shared peak (that's Histogram's layout, not Parade's).
    /// </summary>
    public sealed class MuiParade : ContentControl
    {
        public static readonly DependencyProperty RedValuesProperty =
            DependencyProperty.Register(nameof(RedValues), typeof(IReadOnlyList<double>), typeof(MuiParade),
                new PropertyMetadata(null, (d, _) => ((MuiParade)d).Render()));

        public static readonly DependencyProperty GreenValuesProperty =
            DependencyProperty.Register(nameof(GreenValues), typeof(IReadOnlyList<double>), typeof(MuiParade),
                new PropertyMetadata(null, (d, _) => ((MuiParade)d).Render()));

        public static readonly DependencyProperty BlueValuesProperty =
            DependencyProperty.Register(nameof(BlueValues), typeof(IReadOnlyList<double>), typeof(MuiParade),
                new PropertyMetadata(null, (d, _) => ((MuiParade)d).Render()));

        public static readonly DependencyProperty PlotWidthProperty =
            DependencyProperty.Register(nameof(PlotWidth), typeof(double), typeof(MuiParade),
                new PropertyMetadata(240.0, (d, _) => ((MuiParade)d).Rebuild()));

        public static readonly DependencyProperty PlotHeightProperty =
            DependencyProperty.Register(nameof(PlotHeight), typeof(double), typeof(MuiParade),
                new PropertyMetadata(64.0, (d, _) => ((MuiParade)d).Rebuild()));

        public IReadOnlyList<double>? RedValues
        {
            get => (IReadOnlyList<double>?)GetValue(RedValuesProperty);
            set => SetValue(RedValuesProperty, value);
        }

        public IReadOnlyList<double>? GreenValues
        {
            get => (IReadOnlyList<double>?)GetValue(GreenValuesProperty);
            set => SetValue(GreenValuesProperty, value);
        }

        public IReadOnlyList<double>? BlueValues
        {
            get => (IReadOnlyList<double>?)GetValue(BlueValuesProperty);
            set => SetValue(BlueValuesProperty, value);
        }

        public double PlotWidth
        {
            get => (double)GetValue(PlotWidthProperty);
            set => SetValue(PlotWidthProperty, value);
        }

        public double PlotHeight
        {
            get => (double)GetValue(PlotHeightProperty);
            set => SetValue(PlotHeightProperty, value);
        }

        private const double GapPx = 4;
        private static readonly Color RedColor = Color.FromArgb(0xD9, 0xDC, 0x50, 0x50);
        private static readonly Color GreenColor = Color.FromArgb(0xD9, 0x50, 0xBE, 0x50);
        private static readonly Color BlueColor = Color.FromArgb(0xD9, 0x50, 0x82, 0xDC);

        private readonly Grid _frame = new() { CornerRadius = new CornerRadius(6), BorderThickness = new Thickness(0.5) };
        private readonly Canvas _canvas = new();

        public MuiParade()
        {
            _frame.Children.Add(_canvas);
            Content = _frame;
            IsTabStop = false;

            Rebuild();
        }

        private static Brush R(string key) => (Brush)Application.Current.Resources[key];

        private void Rebuild()
        {
            _frame.Width = PlotWidth;
            _frame.Height = PlotHeight;
            _canvas.Width = PlotWidth;
            _canvas.Height = PlotHeight;
            _frame.Background = R("MapleImageCanvas");
            _frame.BorderBrush = R("MapleBorder");
            Render();
        }

        private void Render()
        {
            _canvas.Children.Clear();
            var w = PlotWidth;
            var h = PlotHeight;
            if (w <= 0 || h <= 0) return;

            var laneX0 = MuiPlotMath.LaneX(0, 3, w, GapPx);
            var laneX1 = MuiPlotMath.LaneX(1, 3, w, GapPx);
            var laneX2 = MuiPlotMath.LaneX(2, 3, w, GapPx);
            var laneWidth = MuiPlotMath.LaneWidth(3, w, GapPx);

            DrawLane(RedValues, RedColor, laneX0, laneWidth, h);
            DrawLane(GreenValues, GreenColor, laneX1, laneWidth, h);
            DrawLane(BlueValues, BlueColor, laneX2, laneWidth, h);
        }

        private void DrawLane(IReadOnlyList<double>? values, Color color, double laneX, double laneWidth, double h)
        {
            var vals = values ?? Array.Empty<double>();
            if (vals.Count == 0 || laneWidth <= 0) return;

            var colWidth = laneWidth / vals.Count;
            var brush = new SolidColorBrush(color);
            for (var i = 0; i < vals.Count; i++)
            {
                var barHeight = MuiPlotMath.ClampUnit(vals[i]) * h;
                if (barHeight <= 0) continue;

                var rect = new Rectangle { Width = Math.Max(1, colWidth), Height = barHeight, Fill = brush };
                Canvas.SetLeft(rect, laneX + i * colWidth);
                Canvas.SetTop(rect, h - barHeight);
                _canvas.Children.Add(rect);
            }
        }
    }
}

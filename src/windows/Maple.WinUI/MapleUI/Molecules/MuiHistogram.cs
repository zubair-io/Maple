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
    /// Maple.UI Histogram data plot (unified-component-catalog.md §2.6,
    /// "Histogram" row: "RGB distribution plot", built from _(plot
    /// primitive)_) — draws directly via WinUI Shapes onto a
    /// <see cref="Canvas"/> (the same "hand-rolled Shapes plot" technique
    /// <see cref="MuiCurvePlot"/> uses in this library, rather than a Win2D
    /// dependency this project doesn't reference).
    ///
    /// R/G/B channel colors are literal, not theme tokens — same
    /// "content-functional, not chrome color" precedent
    /// `mui-histogram.component.ts`'s own header comment gives (a
    /// histogram's channel colors ARE the channel identity, independent of
    /// the app's accent color). Peak-relative scaling via
    /// <see cref="MuiPlotMath"/>: every bin's bar height is relative to the
    /// tallest bin across all three channels, and channels overlap (not
    /// gapped/laned — that's Parade's layout).
    /// </summary>
    public sealed class MuiHistogram : ContentControl
    {
        public static readonly DependencyProperty RedValuesProperty =
            DependencyProperty.Register(nameof(RedValues), typeof(IReadOnlyList<double>), typeof(MuiHistogram),
                new PropertyMetadata(null, (d, _) => ((MuiHistogram)d).Render()));

        public static readonly DependencyProperty GreenValuesProperty =
            DependencyProperty.Register(nameof(GreenValues), typeof(IReadOnlyList<double>), typeof(MuiHistogram),
                new PropertyMetadata(null, (d, _) => ((MuiHistogram)d).Render()));

        public static readonly DependencyProperty BlueValuesProperty =
            DependencyProperty.Register(nameof(BlueValues), typeof(IReadOnlyList<double>), typeof(MuiHistogram),
                new PropertyMetadata(null, (d, _) => ((MuiHistogram)d).Render()));

        public static readonly DependencyProperty PlotWidthProperty =
            DependencyProperty.Register(nameof(PlotWidth), typeof(double), typeof(MuiHistogram),
                new PropertyMetadata(240.0, (d, _) => ((MuiHistogram)d).Rebuild()));

        public static readonly DependencyProperty PlotHeightProperty =
            DependencyProperty.Register(nameof(PlotHeight), typeof(double), typeof(MuiHistogram),
                new PropertyMetadata(64.0, (d, _) => ((MuiHistogram)d).Rebuild()));

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

        private static readonly Color RedColor = Color.FromArgb(0x99, 0xDC, 0x50, 0x50);
        private static readonly Color GreenColor = Color.FromArgb(0x99, 0x50, 0xBE, 0x50);
        private static readonly Color BlueColor = Color.FromArgb(0x99, 0x50, 0x82, 0xDC);

        private readonly Grid _frame = new() { CornerRadius = new CornerRadius(6), BorderThickness = new Thickness(0.5) };
        private readonly Canvas _canvas = new();

        public MuiHistogram()
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

            var channels = new[]
            {
                RedValues ?? Array.Empty<double>(),
                GreenValues ?? Array.Empty<double>(),
                BlueValues ?? Array.Empty<double>(),
            };
            var peak = MuiPlotMath.Peak(channels);

            DrawChannel(RedValues, RedColor, peak, w, h);
            DrawChannel(GreenValues, GreenColor, peak, w, h);
            DrawChannel(BlueValues, BlueColor, peak, w, h);
        }

        private void DrawChannel(IReadOnlyList<double>? values, Color color, double peak, double w, double h)
        {
            var vals = values ?? Array.Empty<double>();
            if (vals.Count == 0) return;

            var barWidth = w / vals.Count;
            var brush = new SolidColorBrush(color);
            for (var i = 0; i < vals.Count; i++)
            {
                var barHeight = MuiPlotMath.BarHeightFraction(vals[i], peak) * h;
                if (barHeight <= 0) continue;

                var rect = new Rectangle { Width = Math.Max(1, barWidth), Height = barHeight, Fill = brush };
                Canvas.SetLeft(rect, i * barWidth);
                Canvas.SetTop(rect, h - barHeight);
                _canvas.Children.Add(rect);
            }
        }
    }
}

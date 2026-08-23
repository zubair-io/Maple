using System;
using System.Collections.Generic;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Shapes;

namespace Maple.UI
{
    /// <summary>
    /// Maple.UI Waveform data plot (unified-component-catalog.md §2.6,
    /// "Waveform" row: "Luma waveform", built from _(plot primitive)_) — a
    /// single-channel luma column plot, drawn the same hand-rolled-Shapes
    /// way <see cref="MuiHistogram"/> is. Unlike Histogram/Parade's literal
    /// RGB channel colors, a luma waveform has no inherent color of its
    /// own, so it reads the app's accent token (`MaplePrimary`) rather than
    /// a hardcoded literal — matching `mui-waveform.component.ts`'s own
    /// "reads the live accent custom property" choice.
    /// </summary>
    public sealed class MuiWaveform : ContentControl
    {
        public static readonly DependencyProperty LumaProperty =
            DependencyProperty.Register(nameof(Luma), typeof(IReadOnlyList<double>), typeof(MuiWaveform),
                new PropertyMetadata(null, (d, _) => ((MuiWaveform)d).Render()));

        public static readonly DependencyProperty PlotWidthProperty =
            DependencyProperty.Register(nameof(PlotWidth), typeof(double), typeof(MuiWaveform),
                new PropertyMetadata(240.0, (d, _) => ((MuiWaveform)d).Rebuild()));

        public static readonly DependencyProperty PlotHeightProperty =
            DependencyProperty.Register(nameof(PlotHeight), typeof(double), typeof(MuiWaveform),
                new PropertyMetadata(64.0, (d, _) => ((MuiWaveform)d).Rebuild()));

        /// <summary>Per-column luma samples, 0..1.</summary>
        public IReadOnlyList<double>? Luma
        {
            get => (IReadOnlyList<double>?)GetValue(LumaProperty);
            set => SetValue(LumaProperty, value);
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

        private readonly Grid _frame = new() { CornerRadius = new CornerRadius(6), BorderThickness = new Thickness(0.5) };
        private readonly Canvas _canvas = new();

        public MuiWaveform()
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
            var samples = Luma ?? Array.Empty<double>();
            if (w <= 0 || h <= 0 || samples.Count == 0) return;

            var brush = R("MaplePrimary");
            var colWidth = w / samples.Count;
            for (var i = 0; i < samples.Count; i++)
            {
                var barHeight = MuiPlotMath.ClampUnit(samples[i]) * (h - 2);
                if (barHeight <= 0) continue;

                var rect = new Rectangle { Width = Math.Max(1, colWidth - 0.5), Height = barHeight, Fill = brush };
                Canvas.SetLeft(rect, i * colWidth);
                Canvas.SetTop(rect, h - barHeight);
                _canvas.Children.Add(rect);
            }
        }
    }
}

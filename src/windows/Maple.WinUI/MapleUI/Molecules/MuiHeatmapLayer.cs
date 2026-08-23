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
    /// Maple.UI Heatmap Layer data plot (unified-component-catalog.md
    /// §2.6, "Heatmap Layer" row: "Density overlay synced to a camera",
    /// built from _(plot primitive)_) — a density grid rendered as an
    /// alpha-blended overlay (e.g. a face-detection density map synced to a
    /// map/photo viewport camera elsewhere in the app). The camera-sync
    /// itself is the host's concern — matching `mui-heatmap-layer.component.ts`'s
    /// own scope, this control only rasterizes the grid it's given. Cell
    /// color reads the accent token, alpha-blended per cell by that cell's
    /// normalized density.
    /// </summary>
    public sealed class MuiHeatmapLayer : ContentControl
    {
        public static readonly DependencyProperty DensityProperty =
            DependencyProperty.Register(nameof(Density), typeof(IReadOnlyList<IReadOnlyList<double>>), typeof(MuiHeatmapLayer),
                new PropertyMetadata(null, (d, _) => ((MuiHeatmapLayer)d).Render()));

        public static readonly DependencyProperty PlotWidthProperty =
            DependencyProperty.Register(nameof(PlotWidth), typeof(double), typeof(MuiHeatmapLayer),
                new PropertyMetadata(160.0, (d, _) => ((MuiHeatmapLayer)d).Rebuild()));

        public static readonly DependencyProperty PlotHeightProperty =
            DependencyProperty.Register(nameof(PlotHeight), typeof(double), typeof(MuiHeatmapLayer),
                new PropertyMetadata(96.0, (d, _) => ((MuiHeatmapLayer)d).Rebuild()));

        /// <summary>Rows of per-cell density, each 0..1. Every row must be
        /// the same length; an empty grid draws nothing.</summary>
        public IReadOnlyList<IReadOnlyList<double>>? Density
        {
            get => (IReadOnlyList<IReadOnlyList<double>>?)GetValue(DensityProperty);
            set => SetValue(DensityProperty, value);
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

        public MuiHeatmapLayer()
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
            var rows = Density ?? Array.Empty<IReadOnlyList<double>>();
            if (w <= 0 || h <= 0 || rows.Count == 0 || rows[0].Count == 0) return;

            var cellWidth = MuiHeatmapMath.CellWidth(rows, w);
            var cellHeight = MuiHeatmapMath.CellHeight(rows, h);
            var baseColor = ((SolidColorBrush)R("MaplePrimary")).Color;

            for (var rowIndex = 0; rowIndex < rows.Count; rowIndex++)
            {
                var row = rows[rowIndex];
                for (var colIndex = 0; colIndex < row.Count; colIndex++)
                {
                    var density = MuiHeatmapMath.ClampDensity(row[colIndex]);
                    if (density <= 0) continue;

                    var alpha = (byte)Math.Round(density * 255);
                    var rect = new Rectangle
                    {
                        Width = cellWidth,
                        Height = cellHeight,
                        Fill = new SolidColorBrush(Color.FromArgb(alpha, baseColor.R, baseColor.G, baseColor.B)),
                    };
                    Canvas.SetLeft(rect, colIndex * cellWidth);
                    Canvas.SetTop(rect, rowIndex * cellHeight);
                    _canvas.Children.Add(rect);
                }
            }
        }
    }
}

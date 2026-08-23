using System;
using System.Collections.Generic;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Shapes;

namespace Maple.UI
{
    /// <summary>
    /// Maple.UI Vectorscope data plot (unified-component-catalog.md §2.6,
    /// "Vectorscope" row: "Chroma scatter plot", built from _(plot
    /// primitive)_) — a chroma scatter plot on a circular graticule: each
    /// RGB sample is converted to BT.601 Cb/Cr via
    /// <see cref="MuiVectorscopeMath"/> and plotted as a dot. Chrome
    /// (circle, spokes) uses the border token; dots use the accent token —
    /// matching `mui-vectorscope.component.ts`'s own token choices.
    /// </summary>
    public sealed class MuiVectorscope : ContentControl
    {
        public static readonly DependencyProperty SamplesProperty =
            DependencyProperty.Register(nameof(Samples), typeof(IReadOnlyList<MuiVectorscopeSample>), typeof(MuiVectorscope),
                new PropertyMetadata(null, (d, _) => ((MuiVectorscope)d).Render()));

        public static readonly DependencyProperty ScopeSizeProperty =
            DependencyProperty.Register(nameof(ScopeSize), typeof(double), typeof(MuiVectorscope),
                new PropertyMetadata(120.0, (d, _) => ((MuiVectorscope)d).Rebuild()));

        public IReadOnlyList<MuiVectorscopeSample>? Samples
        {
            get => (IReadOnlyList<MuiVectorscopeSample>?)GetValue(SamplesProperty);
            set => SetValue(SamplesProperty, value);
        }

        public double ScopeSize
        {
            get => (double)GetValue(ScopeSizeProperty);
            set => SetValue(ScopeSizeProperty, value);
        }

        private readonly Grid _frame = new() { CornerRadius = new CornerRadius(999), BorderThickness = new Thickness(0.5) };
        private readonly Canvas _canvas = new();
        private readonly Ellipse _circle = new() { StrokeThickness = 0.5 };
        private readonly List<Line> _spokes = new();
        private readonly List<Ellipse> _dots = new();

        public MuiVectorscope()
        {
            _canvas.Children.Add(_circle);
            for (var i = 0; i < 6; i++)
            {
                var spoke = new Line { StrokeThickness = 0.5 };
                _spokes.Add(spoke);
                _canvas.Children.Add(spoke);
            }
            _frame.Children.Add(_canvas);
            Content = _frame;
            IsTabStop = false;

            Rebuild();
        }

        private static Brush R(string key) => (Brush)Application.Current.Resources[key];

        private void Rebuild()
        {
            _frame.Width = ScopeSize;
            _frame.Height = ScopeSize;
            _canvas.Width = ScopeSize;
            _canvas.Height = ScopeSize;
            _frame.Background = R("MapleImageCanvas");

            var chromeBrush = R("MapleBorder");
            _circle.Stroke = chromeBrush;
            _circle.Fill = null;
            foreach (var spoke in _spokes)
                spoke.Stroke = chromeBrush;

            Render();
        }

        private void Render()
        {
            var size = ScopeSize;
            if (size <= 0) return;

            var cx = size / 2;
            var cy = size / 2;
            var radius = size / 2 - 4;

            _circle.Width = radius * 2;
            _circle.Height = radius * 2;
            Canvas.SetLeft(_circle, cx - radius);
            Canvas.SetTop(_circle, cy - radius);

            for (var i = 0; i < _spokes.Count; i++)
            {
                var angle = (double)i / _spokes.Count * Math.PI * 2;
                var spoke = _spokes[i];
                spoke.X1 = cx;
                spoke.Y1 = cy;
                spoke.X2 = cx + Math.Cos(angle) * radius;
                spoke.Y2 = cy + Math.Sin(angle) * radius;
            }

            foreach (var dot in _dots)
                _canvas.Children.Remove(dot);
            _dots.Clear();

            var dotBrush = R("MaplePrimary");
            foreach (var sample in Samples ?? Array.Empty<MuiVectorscopeSample>())
            {
                var (x, y) = MuiVectorscopeMath.ToPoint(sample.R, sample.G, sample.B, cx, cy, radius);
                var dot = new Ellipse { Width = 3, Height = 3, Fill = dotBrush };
                Canvas.SetLeft(dot, x - 1.5);
                Canvas.SetTop(dot, y - 1.5);
                _dots.Add(dot);
                _canvas.Children.Add(dot);
            }
        }
    }
}

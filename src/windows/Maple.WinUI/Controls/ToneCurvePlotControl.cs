using System;
using System.Collections.Generic;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Shapes;
using Windows.UI;
using Maple.WinUI.Models;

namespace Maple.WinUI.Controls
{
    /// <summary>
    /// Interactive point tone-curve plot (#2576) — the web ToneCurveComponent's
    /// layout and interaction model: quarter grid, dashed identity diagonal,
    /// luma histogram backdrop, 64-segment monotone-cubic curve, draggable
    /// knots (endpoints vertical-only), click-to-insert, double-tap-to-delete.
    /// Emits the committed knot list on every edit; the host owns the model.
    /// </summary>
    public sealed class ToneCurvePlotControl : Grid
    {
        private static readonly Color CanvasAlt = Color.FromArgb(0xFF, 0x08, 0x07, 0x0A);
        private static readonly Color GridLine = Color.FromArgb(0x14, 0xFF, 0xFF, 0xFF);   // 8%
        private static readonly Color Diagonal = Color.FromArgb(0x33, 0xFF, 0xFF, 0xFF);   // 20%
        private static readonly Color HistFill = Color.FromArgb(0x0F, 0xFF, 0xFF, 0xFF);   // 6%
        private static readonly Color KnotFill = Color.FromArgb(0xFF, 0xF2, 0xEF, 0xE9);
        private static readonly Color PinnedRim = Color.FromArgb(0x4D, 0xFF, 0xFF, 0xFF);  // 30%

        private readonly Canvas _canvas = new();
        private readonly Polygon _histogram = new() { Fill = new SolidColorBrush(HistFill) };
        private readonly Polyline _curve = new()
        {
            StrokeThickness = 1.5,
            StrokeLineJoin = PenLineJoin.Round,
            StrokeStartLineCap = PenLineCap.Round,
            StrokeEndLineCap = PenLineCap.Round,
            IsHitTestVisible = false,
        };
        private readonly List<Line> _gridLines = new();
        private readonly Line _diagonal = new()
        {
            Stroke = new SolidColorBrush(Diagonal),
            StrokeThickness = 0.75,
            StrokeDashArray = new DoubleCollection { 3, 4 },
        };
        private readonly List<Ellipse> _knotShapes = new();

        private List<CurvePoint> _committed = new();
        private List<CurvePoint>? _working;             // non-null while dragging
        private int _dragIndex = -1;
        private uint[]? _lumaBins;
        private Color _channelColor = Color.FromArgb(0xFF, 0xC4, 0x49, 0x3A);

        /// <summary>Raised on every edit (drag tick, insert, delete) with the
        /// full committed knot list — [] is the identity.</summary>
        public event Action<List<CurvePoint>>? PointsChanged;

        public ToneCurvePlotControl()
        {
            Background = new SolidColorBrush(CanvasAlt);
            CornerRadius = new CornerRadius(6);
            BorderBrush = new SolidColorBrush(Color.FromArgb(0xFF, 0x32, 0x2D, 0x26));
            BorderThickness = new Thickness(0.5);

            _canvas.Children.Add(_histogram);
            for (var i = 0; i < 6; i++)
            {
                var line = new Line { Stroke = new SolidColorBrush(GridLine), StrokeThickness = 0.5 };
                _gridLines.Add(line);
                _canvas.Children.Add(line);
            }
            _canvas.Children.Add(_diagonal);
            _canvas.Children.Add(_curve);
            Children.Add(_canvas);

            PointerPressed += OnPointerPressed;
            PointerMoved += OnPointerMoved;
            PointerReleased += OnPointerReleased;
            PointerCanceled += OnPointerReleased;
            PointerCaptureLost += (_, _) => EndDrag(commit: false);
            DoubleTapped += OnDoubleTapped;
            SizeChanged += (_, _) => Render();
        }

        // --- host API ---

        public void SetPoints(List<CurvePoint> committed)
        {
            _committed = new List<CurvePoint>(committed);
            if (_working == null)
                Render();
        }

        public void SetChannelColor(Color color)
        {
            _channelColor = color;
            Render();
        }

        public void SetHistogram(uint[]? lumaBins)
        {
            _lumaBins = lumaBins;
            RenderHistogram();
        }

        // --- pointer interaction ---

        private (double X, double Y)? ToAuthoring(PointerRoutedEventArgs e)
        {
            if (ActualWidth <= 0 || ActualHeight <= 0)
                return null;
            var pt = e.GetCurrentPoint(this).Position;
            return (pt.X / ActualWidth, 1 - pt.Y / ActualHeight);
        }

        private void OnPointerPressed(object sender, PointerRoutedEventArgs e)
        {
            if (!e.GetCurrentPoint(this).Properties.IsLeftButtonPressed)
                return;
            if (ToAuthoring(e) is not { } pos)
                return;
            var working = ToneCurveMath.Materialize(_committed);
            var hit = ToneCurveMath.HitTest(working, pos.X, pos.Y);
            if (hit < 0)
            {
                hit = ToneCurveMath.InsertPoint(working, pos.X, pos.Y);
                if (hit < 0)
                    return;                              // x-collision no-op
            }
            _working = working;
            _dragIndex = hit;
            CapturePointer(e.Pointer);
            Commit();                                    // insert lands immediately
            e.Handled = true;
        }

        private void OnPointerMoved(object sender, PointerRoutedEventArgs e)
        {
            if (_working == null || _dragIndex < 0 || ToAuthoring(e) is not { } pos)
                return;
            ToneCurveMath.MovePoint(_working, _dragIndex, pos.X, pos.Y);
            Commit();
            e.Handled = true;
        }

        private void OnPointerReleased(object sender, PointerRoutedEventArgs e)
        {
            if (_working == null)
                return;
            ReleasePointerCaptures();
            EndDrag(commit: true);
            e.Handled = true;
        }

        private void EndDrag(bool commit)
        {
            if (_working == null)
                return;
            if (commit)
                Commit();
            _working = null;
            _dragIndex = -1;
            Render();
        }

        private void OnDoubleTapped(object sender, DoubleTappedRoutedEventArgs e)
        {
            var pos = e.GetPosition(this);
            if (ActualWidth <= 0 || ActualHeight <= 0)
                return;
            var x = pos.X / ActualWidth;
            var y = 1 - pos.Y / ActualHeight;
            var working = ToneCurveMath.Materialize(_committed);
            var hit = ToneCurveMath.HitTest(working, x, y);
            // Pinned endpoints are not deletable.
            if (hit <= 0 || hit >= working.Count - 1)
                return;
            ToneCurveMath.RemovePoint(working, hit);
            _committed = working;
            PointsChanged?.Invoke(new List<CurvePoint>(_committed));
            Render();
            e.Handled = true;
        }

        private void Commit()
        {
            if (_working == null)
                return;
            _committed = new List<CurvePoint>(_working);
            PointsChanged?.Invoke(new List<CurvePoint>(_committed));
            Render();
        }

        // --- rendering ---

        private void Render()
        {
            var w = ActualWidth;
            var h = ActualHeight;
            if (w <= 0 || h <= 0)
                return;

            for (var i = 0; i < 3; i++)
            {
                var f = 0.25 * (i + 1);
                var v = _gridLines[i];
                v.X1 = f * w; v.X2 = f * w; v.Y1 = 0; v.Y2 = h;
                var hz = _gridLines[i + 3];
                hz.X1 = 0; hz.X2 = w; hz.Y1 = f * h; hz.Y2 = f * h;
            }
            _diagonal.X1 = 0; _diagonal.Y1 = h; _diagonal.X2 = w; _diagonal.Y2 = 0;

            var knots = ToneCurveMath.PrepareCurve(_working ?? _committed);
            _curve.Stroke = new SolidColorBrush(_channelColor);
            var pts = new PointCollection();
            const int samples = 64;
            for (var i = 0; i <= samples; i++)
            {
                var x = (double)i / samples;
                var y = ToneCurveMath.Eval(knots, x);
                pts.Add(new Windows.Foundation.Point(x * w, (1 - y) * h));
            }
            _curve.Points = pts;

            RenderKnots(knots, w, h);
            RenderHistogram();
        }

        private void RenderKnots(IReadOnlyList<CurvePoint> knots, double w, double h)
        {
            foreach (var shape in _knotShapes)
                _canvas.Children.Remove(shape);
            _knotShapes.Clear();
            var radius = 2.6 / 100 * Math.Min(w, h);     // web: r=2.6 in a 100-unit viewbox
            for (var i = 0; i < knots.Count; i++)
            {
                var pinned = i == 0 || i == knots.Count - 1;
                var dot = new Ellipse
                {
                    Width = radius * 2,
                    Height = radius * 2,
                    Fill = new SolidColorBrush(KnotFill),
                    Stroke = new SolidColorBrush(pinned ? PinnedRim : _channelColor),
                    StrokeThickness = pinned ? 1 : 1.5,
                    IsHitTestVisible = false,
                };
                Canvas.SetLeft(dot, knots[i].X * w - radius);
                Canvas.SetTop(dot, (1 - knots[i].Y) * h - radius);
                _knotShapes.Add(dot);
                _canvas.Children.Add(dot);
            }
        }

        private void RenderHistogram()
        {
            var w = ActualWidth;
            var h = ActualHeight;
            if (w <= 0 || h <= 0 || _lumaBins == null || _lumaBins.Length == 0)
            {
                _histogram.Points = new PointCollection();
                return;
            }
            uint peak = 1;
            foreach (var count in _lumaBins)
                if (count > peak) peak = count;
            var scale = h / Math.Log(1.0 + peak);
            var pts = new PointCollection { new Windows.Foundation.Point(0, h) };
            for (var i = 0; i < _lumaBins.Length; i++)
            {
                var x = (double)i / (_lumaBins.Length - 1) * w;
                var y = h - Math.Log(1.0 + _lumaBins[i]) * scale * 0.88;
                pts.Add(new Windows.Foundation.Point(x, y));
            }
            pts.Add(new Windows.Foundation.Point(w, h));
            _histogram.Points = pts;
        }
    }
}

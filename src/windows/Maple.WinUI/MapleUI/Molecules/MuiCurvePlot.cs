using System;
using System.Collections.Generic;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Shapes;
using Windows.System;

namespace Maple.UI
{
    /// <summary>
    /// Maple.UI Curve Plot data plot (unified-component-catalog.md §2.6,
    /// "Curve Plot" row: "Draggable point curve", built from _(plot
    /// primitive)_) — a draggable control-point curve (e.g. a tone-curve-
    /// shaped editor), drawn via a real <see cref="Path"/>
    /// (<see cref="QuadraticBezierSegment"/>/<see cref="LineSegment"/>)
    /// rather than a sampled Polyline — WinUI's Path geometry traces the
    /// exact same curve the web port's `ctx.quadraticCurveTo` draws, with
    /// no manual Bezier sampling needed.
    ///
    /// Ports `mui-curve-plot.component.ts`'s drag contract: pointerdown
    /// hit-tests an EXISTING point only (a miss is a no-op — this primitive
    /// has no click-to-insert, unlike the app's own richer
    /// <c>ToneCurvePlotControl</c>) → <see cref="UIElement.PointerPressed"/>
    /// captures the pointer on the canvas, not the document, matching
    /// <see cref="MuiPad2D"/>/<see cref="MuiLivingSlider"/>'s own
    /// pointer-capture-drag convention already established in this
    /// library — plus arrow-key nudging of whichever point was last
    /// interacted with, via <see cref="MuiCurvePlotMath"/>.
    /// </summary>
    public sealed class MuiCurvePlot : ContentControl
    {
        private static readonly IReadOnlyList<MuiCurvePoint> DefaultPoints = new[]
        {
            new MuiCurvePoint(0, 0),
            new MuiCurvePoint(0.5, 0.5),
            new MuiCurvePoint(1, 1),
        };

        public static readonly DependencyProperty PointsProperty =
            DependencyProperty.Register(nameof(Points), typeof(IReadOnlyList<MuiCurvePoint>), typeof(MuiCurvePlot),
                new PropertyMetadata(DefaultPoints, (d, _) => ((MuiCurvePlot)d).Render()));

        public static readonly DependencyProperty PlotWidthProperty =
            DependencyProperty.Register(nameof(PlotWidth), typeof(double), typeof(MuiCurvePlot),
                new PropertyMetadata(120.0, (d, _) => ((MuiCurvePlot)d).Rebuild()));

        public static readonly DependencyProperty PlotHeightProperty =
            DependencyProperty.Register(nameof(PlotHeight), typeof(double), typeof(MuiCurvePlot),
                new PropertyMetadata(80.0, (d, _) => ((MuiCurvePlot)d).Rebuild()));

        public IReadOnlyList<MuiCurvePoint> Points
        {
            get => (IReadOnlyList<MuiCurvePoint>)GetValue(PointsProperty);
            set => SetValue(PointsProperty, value);
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

        /// <summary>Fires with the full point list on every edit (drag tick
        /// or arrow-key nudge).</summary>
        public event EventHandler<IReadOnlyList<MuiCurvePoint>>? PointsChanged;

        private readonly Grid _frame = new() { CornerRadius = new CornerRadius(6), BorderThickness = new Thickness(1) };
        private readonly Canvas _canvas = new();
        private readonly Path _curvePath = new() { StrokeThickness = 2 };
        private readonly List<Ellipse> _knotShapes = new();

        private int? _activeIndex;
        private uint? _activePointerId;

        public MuiCurvePlot()
        {
            _canvas.Children.Add(_curvePath);
            _frame.Children.Add(_canvas);
            Content = _frame;
            IsTabStop = true;

            _canvas.PointerPressed += OnPointerPressed;
            _canvas.PointerMoved += OnPointerMoved;
            _canvas.PointerReleased += OnPointerReleased;
            _canvas.PointerCanceled += OnPointerReleased;
            _canvas.PointerCaptureLost += (_, _) => { _activeIndex = null; _activePointerId = null; };
            KeyDown += OnKeyDown;

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
            _curvePath.Stroke = R("MaplePrimary");
            Render();
        }

        private void OnPointerPressed(object sender, PointerRoutedEventArgs e)
        {
            if (!e.GetCurrentPoint(_canvas).Properties.IsLeftButtonPressed) return;
            var pos = e.GetCurrentPoint(_canvas).Position;
            var hit = MuiCurvePlotMath.HitTest(Points, pos.X, pos.Y, PlotWidth, PlotHeight);
            if (hit is null) return;

            _activeIndex = hit;
            _activePointerId = e.Pointer.PointerId;
            _canvas.CapturePointer(e.Pointer);
            Focus(FocusState.Pointer);
            Render();
            e.Handled = true;
        }

        private void OnPointerMoved(object sender, PointerRoutedEventArgs e)
        {
            if (_activeIndex is not { } index || e.Pointer.PointerId != _activePointerId) return;
            var pos = e.GetCurrentPoint(_canvas).Position;
            var next = MuiCurvePlotMath.FromCanvasPoint(pos.X, pos.Y, PlotWidth, PlotHeight);
            UpdatePoint(index, next);
            e.Handled = true;
        }

        private void OnPointerReleased(object sender, PointerRoutedEventArgs e)
        {
            if (e.Pointer.PointerId != _activePointerId) return;
            _canvas.ReleasePointerCapture(e.Pointer);
            _activePointerId = null;
            e.Handled = true;
        }

        private void OnKeyDown(object sender, KeyRoutedEventArgs e)
        {
            if (_activeIndex is not { } index || index >= Points.Count) return;
            var keyName = e.Key switch
            {
                VirtualKey.Up => "Up",
                VirtualKey.Down => "Down",
                VirtualKey.Left => "Left",
                VirtualKey.Right => "Right",
                _ => null,
            };
            if (keyName is null) return;

            e.Handled = true;
            UpdatePoint(index, MuiCurvePlotMath.Nudge(Points[index], keyName));
        }

        private void UpdatePoint(int index, MuiCurvePoint next)
        {
            var updated = new List<MuiCurvePoint>(Points) { [index] = next };
            Points = updated;
            PointsChanged?.Invoke(this, updated);
        }

        private void Render()
        {
            var w = PlotWidth;
            var h = PlotHeight;
            if (w <= 0 || h <= 0) return;

            var pts = Points;
            var segments = MuiCurvePlotMath.BuildSmoothedPath(pts, out var start);

            if (segments.Count == 0)
            {
                _curvePath.Data = null;
            }
            else
            {
                var figure = new PathFigure { StartPoint = ToWindowsPoint(MuiCurvePlotMath.ToCanvasPoint(start, w, h)) };
                foreach (var segment in segments)
                {
                    switch (segment)
                    {
                        case MuiCurveLineTo lineTo:
                            figure.Segments.Add(new LineSegment { Point = ToWindowsPoint(MuiCurvePlotMath.ToCanvasPoint(lineTo.To, w, h)) });
                            break;
                        case MuiCurveQuadTo quadTo:
                            figure.Segments.Add(new QuadraticBezierSegment
                            {
                                Point1 = ToWindowsPoint(MuiCurvePlotMath.ToCanvasPoint(quadTo.Control, w, h)),
                                Point2 = ToWindowsPoint(MuiCurvePlotMath.ToCanvasPoint(quadTo.To, w, h)),
                            });
                            break;
                    }
                }
                var geometry = new PathGeometry();
                geometry.Figures.Add(figure);
                _curvePath.Data = geometry;
            }

            RenderKnots(pts, w, h);
        }

        private static Windows.Foundation.Point ToWindowsPoint(MuiCurvePoint p) => new(p.X, p.Y);

        private void RenderKnots(IReadOnlyList<MuiCurvePoint> pts, double w, double h)
        {
            foreach (var shape in _knotShapes)
                _canvas.Children.Remove(shape);
            _knotShapes.Clear();

            var accent = R("MaplePrimary");
            for (var i = 0; i < pts.Count; i++)
            {
                var c = MuiCurvePlotMath.ToCanvasPoint(pts[i], w, h);
                var active = i == _activeIndex;
                var diameter = active ? 9.0 : 6.0;
                var dot = new Ellipse { Width = diameter, Height = diameter, Fill = accent };
                Canvas.SetLeft(dot, c.X - diameter / 2);
                Canvas.SetTop(dot, c.Y - diameter / 2);
                _knotShapes.Add(dot);
                _canvas.Children.Add(dot);
            }
        }
    }
}

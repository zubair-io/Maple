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
    /// <summary>How <see cref="MuiCurvePlot"/> smooths the drawn curve.</summary>
    public enum MuiCurvePlotSmoothing
    {
        /// <summary>The web port's midpoint-quadratic stand-in (default) —
        /// see <see cref="MuiCurvePlotMath.BuildSmoothedPath"/>.</summary>
        MidpointQuadratic,
        /// <summary>The pipeline's own Fritsch–Carlson monotone cubic
        /// (<see cref="MuiToneCurveMath.Eval"/>, sampled at 64 segments) —
        /// the tone-curve editor uses this so the drawn curve IS the curve
        /// the render pipeline applies.</summary>
        MonotoneCubic,
    }

    /// <summary>
    /// Maple.UI Curve Plot data plot (unified-component-catalog.md §2.6,
    /// "Curve Plot" row: "Draggable point curve", built from _(plot
    /// primitive)_) — a draggable control-point curve, drawn via a real
    /// <see cref="Path"/> rather than a manually sampled Polyline where the
    /// midpoint-quadratic smoothing allows it.
    ///
    /// Ports `mui-curve-plot.component.ts`'s drag contract: pointerdown
    /// hit-tests an EXISTING point (default mode) →
    /// <see cref="UIElement.PointerPressed"/> captures the pointer on the
    /// canvas, matching <see cref="MuiPad2D"/>/<see cref="MuiLivingSlider"/>'s
    /// pointer-capture-drag convention — plus arrow-key nudging of whichever
    /// point was last interacted with, via <see cref="MuiCurvePlotMath"/>.
    ///
    /// The MN2 wave (#3051) extended this primitive with the app tone-curve
    /// editor's richer contract (previously a hand-rolled app-side plot
    /// control, deleted in that wave), all opt-in:
    /// <see cref="PointEditing"/> (click-to-insert, double-tap-to-delete,
    /// pinned vertical-only endpoints, empty-list = identity, via
    /// <see cref="MuiToneCurveMath"/>), <see cref="Smoothing"/>
    /// (<see cref="MuiCurvePlotSmoothing.MonotoneCubic"/> renders the exact
    /// pipeline curve), <see cref="AccentBrush"/> (per-channel curve color),
    /// <see cref="HistogramBins"/> (log-scaled luma backdrop) and
    /// <see cref="ShowGrid"/> (quarter grid + dashed identity diagonal).
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

        public static readonly DependencyProperty SmoothingProperty =
            DependencyProperty.Register(nameof(Smoothing), typeof(MuiCurvePlotSmoothing), typeof(MuiCurvePlot),
                new PropertyMetadata(MuiCurvePlotSmoothing.MidpointQuadratic, (d, _) => ((MuiCurvePlot)d).Render()));

        public static readonly DependencyProperty PointEditingProperty =
            DependencyProperty.Register(nameof(PointEditing), typeof(bool), typeof(MuiCurvePlot),
                new PropertyMetadata(false, (d, _) => ((MuiCurvePlot)d).Render()));

        public static readonly DependencyProperty AccentBrushProperty =
            DependencyProperty.Register(nameof(AccentBrush), typeof(Brush), typeof(MuiCurvePlot),
                new PropertyMetadata(null, (d, _) => ((MuiCurvePlot)d).Render()));

        public static readonly DependencyProperty HistogramBinsProperty =
            DependencyProperty.Register(nameof(HistogramBins), typeof(uint[]), typeof(MuiCurvePlot),
                new PropertyMetadata(null, (d, _) => ((MuiCurvePlot)d).RenderHistogram()));

        public static readonly DependencyProperty ShowGridProperty =
            DependencyProperty.Register(nameof(ShowGrid), typeof(bool), typeof(MuiCurvePlot),
                new PropertyMetadata(false, (d, _) => ((MuiCurvePlot)d).Rebuild()));

        public static readonly DependencyProperty StretchToFitProperty =
            DependencyProperty.Register(nameof(StretchToFit), typeof(bool), typeof(MuiCurvePlot),
                new PropertyMetadata(false, (d, _) => ((MuiCurvePlot)d).Rebuild()));

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

        public MuiCurvePlotSmoothing Smoothing
        {
            get => (MuiCurvePlotSmoothing)GetValue(SmoothingProperty);
            set => SetValue(SmoothingProperty, value);
        }

        /// <summary>Tone-curve editing mode: a pointer press on empty plot
        /// inserts a knot (x-collision is a no-op), double-tap deletes an
        /// interior knot, endpoints are pinned to x=0/x=1 and move
        /// vertically only, and an empty <see cref="Points"/> list is the
        /// canonical identity (materialized to the anchor pair on first
        /// interaction). Off by default — the plain primitive drags
        /// existing points only.</summary>
        public bool PointEditing
        {
            get => (bool)GetValue(PointEditingProperty);
            set => SetValue(PointEditingProperty, value);
        }

        /// <summary>Curve/knot accent override (e.g. per-channel tone-curve
        /// colors). Null (default) uses the `MaplePrimary` token.</summary>
        public Brush? AccentBrush
        {
            get => (Brush?)GetValue(AccentBrushProperty);
            set => SetValue(AccentBrushProperty, value);
        }

        /// <summary>Optional histogram backdrop bins (log-scaled fill behind
        /// the curve — the tone-curve editor feeds the luma bins here).</summary>
        public uint[]? HistogramBins
        {
            get => (uint[]?)GetValue(HistogramBinsProperty);
            set => SetValue(HistogramBinsProperty, value);
        }

        /// <summary>Quarter grid lines + dashed identity diagonal.</summary>
        public bool ShowGrid
        {
            get => (bool)GetValue(ShowGridProperty);
            set => SetValue(ShowGridProperty, value);
        }

        /// <summary>Sizes the plot to the control's own arranged bounds
        /// (host-driven layout: e.g. stretch-width in a panel with a fixed
        /// Height) instead of the fixed <see cref="PlotWidth"/>/<see
        /// cref="PlotHeight"/>. Off by default — the plain primitive keeps
        /// its fixed plot box.</summary>
        public bool StretchToFit
        {
            get => (bool)GetValue(StretchToFitProperty);
            set => SetValue(StretchToFitProperty, value);
        }

        /// <summary>Fires with the full point list on every edit (drag tick,
        /// insert, delete, or arrow-key nudge).</summary>
        public event EventHandler<IReadOnlyList<MuiCurvePoint>>? PointsChanged;

        private readonly Grid _frame = new() { CornerRadius = new CornerRadius(6), BorderThickness = new Thickness(1) };
        private readonly Canvas _canvas = new();
        private readonly Polygon _histogram = new() { IsHitTestVisible = false };
        private readonly List<Line> _gridLines = new();
        private readonly Line _diagonal = new()
        {
            StrokeThickness = 0.75,
            StrokeDashArray = new DoubleCollection { 3, 4 },
            Opacity = 0.6,
            IsHitTestVisible = false,
        };
        private readonly Microsoft.UI.Xaml.Shapes.Path _curvePath = new() { StrokeThickness = 2, IsHitTestVisible = false };
        private readonly List<Ellipse> _knotShapes = new();

        private int? _activeIndex;
        private uint? _activePointerId;

        public MuiCurvePlot()
        {
            // Transparent (not null) background: the pointer handlers live on
            // the canvas, and a background-less Canvas only hit-tests its
            // child shapes — presses on empty plot area (the click-to-insert
            // gesture, and grabs near but not exactly on a knot) would fall
            // through to the frame and never reach OnPointerPressed.
            _canvas.Background = new SolidColorBrush(Microsoft.UI.Colors.Transparent);
            _canvas.Children.Add(_histogram);
            for (var i = 0; i < 6; i++)
            {
                var line = new Line { StrokeThickness = 0.5, IsHitTestVisible = false };
                _gridLines.Add(line);
                _canvas.Children.Add(line);
            }
            _canvas.Children.Add(_diagonal);
            _canvas.Children.Add(_curvePath);
            _frame.Children.Add(_canvas);
            Content = _frame;
            IsTabStop = true;

            _canvas.PointerPressed += OnPointerPressed;
            _canvas.PointerMoved += OnPointerMoved;
            _canvas.PointerReleased += OnPointerReleased;
            _canvas.PointerCanceled += OnPointerReleased;
            _canvas.PointerCaptureLost += (_, _) => { _activeIndex = null; _activePointerId = null; };
            _canvas.DoubleTapped += OnDoubleTapped;
            KeyDown += OnKeyDown;
            _frame.SizeChanged += (_, _) => { if (StretchToFit) Rebuild(); };

            Rebuild();
        }

        private static Brush R(string key) => (Brush)Application.Current.Resources[key];

        private Brush Accent => AccentBrush ?? R("MaplePrimary");

        /// <summary>The live plot box — the arranged frame size when
        /// <see cref="StretchToFit"/> is on, the fixed plot box otherwise.
        /// Everything (rendering, hit-testing, authoring conversion) keys
        /// off this so pointer math always matches what is drawn.</summary>
        private (double W, double H) PlotBox => StretchToFit
            ? (_frame.ActualWidth, _frame.ActualHeight)
            : (PlotWidth, PlotHeight);

        private void Rebuild()
        {
            if (StretchToFit)
            {
                _frame.Width = double.NaN;
                _frame.Height = double.NaN;
                HorizontalContentAlignment = HorizontalAlignment.Stretch;
                VerticalContentAlignment = VerticalAlignment.Stretch;
            }
            else
            {
                _frame.Width = PlotWidth;
                _frame.Height = PlotHeight;
            }
            var (w, h) = PlotBox;
            _canvas.Width = double.IsNaN(w) ? 0 : Math.Max(0, w);
            _canvas.Height = double.IsNaN(h) ? 0 : Math.Max(0, h);
            _frame.Background = R("MapleImageCanvas");
            _frame.BorderBrush = R("MapleBorder");

            var showGrid = ShowGrid ? Visibility.Visible : Visibility.Collapsed;
            for (var i = 0; i < 3; i++)
            {
                var f = 0.25 * (i + 1);
                var v = _gridLines[i];
                v.X1 = f * w; v.X2 = f * w; v.Y1 = 0; v.Y2 = h;
                var hz = _gridLines[i + 3];
                hz.X1 = 0; hz.X2 = w; hz.Y1 = f * h; hz.Y2 = f * h;
            }
            foreach (var line in _gridLines)
            {
                line.Stroke = R("MapleBorder");
                line.Visibility = showGrid;
            }
            _diagonal.X1 = 0; _diagonal.Y1 = h; _diagonal.X2 = w; _diagonal.Y2 = 0;
            _diagonal.Stroke = R("MapleBorderHi");
            _diagonal.Visibility = showGrid;

            RenderHistogram();
            Render();
        }

        // --- pointer interaction ---

        private (double X, double Y) ToAuthoring(Windows.Foundation.Point pos)
        {
            var (w, h) = PlotBox;
            return (w > 0 ? pos.X / w : 0, h > 0 ? 1 - pos.Y / h : 0);
        }

        private void OnPointerPressed(object sender, PointerRoutedEventArgs e)
        {
            if (!e.GetCurrentPoint(_frame).Properties.IsLeftButtonPressed) return;
            var pos = e.GetCurrentPoint(_frame).Position;

            if (PointEditing)
            {
                var (ax, ay) = ToAuthoring(pos);
                var working = MuiToneCurveMath.Materialize(Points);
                var hit = MuiToneCurveMath.HitTest(working, ax, ay);
                if (hit < 0)
                {
                    hit = MuiToneCurveMath.InsertPoint(working, ax, ay);
                    if (hit < 0) return;                 // x-collision no-op
                }
                _activeIndex = hit;
                _activePointerId = e.Pointer.PointerId;
                _canvas.CapturePointer(e.Pointer);
                Focus(FocusState.Pointer);
                CommitPoints(working);                   // insert lands immediately
                e.Handled = true;
                return;
            }

            var (bw, bh) = PlotBox;
            var hitIndex = MuiCurvePlotMath.HitTest(Points, pos.X, pos.Y, bw, bh);
            if (hitIndex is null) return;

            _activeIndex = hitIndex;
            _activePointerId = e.Pointer.PointerId;
            _canvas.CapturePointer(e.Pointer);
            Focus(FocusState.Pointer);
            Render();
            e.Handled = true;
        }

        private void OnPointerMoved(object sender, PointerRoutedEventArgs e)
        {
            if (_activeIndex is not { } index || e.Pointer.PointerId != _activePointerId) return;
            var pos = e.GetCurrentPoint(_frame).Position;

            if (PointEditing)
            {
                if (index >= Points.Count) return;
                var (ax, ay) = ToAuthoring(pos);
                var working = new List<MuiCurvePoint>(Points);
                MuiToneCurveMath.MovePoint(working, index, ax, ay);
                CommitPoints(working);
                e.Handled = true;
                return;
            }

            var (bw, bh) = PlotBox;
            var next = MuiCurvePlotMath.FromCanvasPoint(pos.X, pos.Y, bw, bh);
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

        private void OnDoubleTapped(object sender, DoubleTappedRoutedEventArgs e)
        {
            if (!PointEditing) return;
            var (ax, ay) = ToAuthoring(e.GetPosition(_frame));
            var working = MuiToneCurveMath.Materialize(Points);
            var hit = MuiToneCurveMath.HitTest(working, ax, ay);
            // Pinned endpoints are not deletable.
            if (hit <= 0 || hit >= working.Count - 1) return;
            MuiToneCurveMath.RemovePoint(working, hit);
            _activeIndex = null;
            CommitPoints(working);
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
            var nudged = MuiCurvePlotMath.Nudge(Points[index], keyName);

            if (PointEditing)
            {
                // Route the nudge through the tone-curve move constraints so
                // pinned endpoints stay pinned and MinXGap holds.
                var working = new List<MuiCurvePoint>(Points);
                MuiToneCurveMath.MovePoint(working, index, nudged.X, nudged.Y);
                CommitPoints(working);
                return;
            }

            UpdatePoint(index, nudged);
        }

        private void UpdatePoint(int index, MuiCurvePoint next)
        {
            var updated = new List<MuiCurvePoint>(Points) { [index] = next };
            Points = updated;
            PointsChanged?.Invoke(this, updated);
        }

        private void CommitPoints(List<MuiCurvePoint> points)
        {
            Points = points;
            PointsChanged?.Invoke(this, points);
        }

        // --- rendering ---

        private void Render()
        {
            var (w, h) = PlotBox;
            if (double.IsNaN(w) || double.IsNaN(h) || w <= 0 || h <= 0) return;

            var pts = Points;
            _curvePath.Stroke = Accent;

            if (Smoothing == MuiCurvePlotSmoothing.MonotoneCubic)
                RenderMonotoneCubic(pts, w, h);
            else
                RenderMidpointQuadratic(pts, w, h);

            RenderKnots(pts, w, h);
        }

        private void RenderMidpointQuadratic(IReadOnlyList<MuiCurvePoint> pts, double w, double h)
        {
            var segments = MuiCurvePlotMath.BuildSmoothedPath(pts, out var start);

            if (segments.Count == 0)
            {
                _curvePath.Data = null;
                return;
            }

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

        /// <summary>64-sample trace of the Fritsch–Carlson evaluation — the
        /// same segment count the render pipeline's editor plot has always
        /// drawn, so what the user sees is what the pipeline applies (an
        /// empty list traces the identity diagonal).</summary>
        private void RenderMonotoneCubic(IReadOnlyList<MuiCurvePoint> pts, double w, double h)
        {
            var knots = MuiToneCurveMath.PrepareCurve(pts);
            const int samples = 64;
            var poly = new PolyLineSegment();
            var figure = new PathFigure();
            for (var i = 0; i <= samples; i++)
            {
                var x = (double)i / samples;
                var y = MuiToneCurveMath.Eval(knots, x);
                var point = new Windows.Foundation.Point(x * w, (1 - y) * h);
                if (i == 0)
                    figure.StartPoint = point;
                else
                    poly.Points.Add(point);
            }
            figure.Segments.Add(poly);
            var geometry = new PathGeometry();
            geometry.Figures.Add(figure);
            _curvePath.Data = geometry;
        }

        private static Windows.Foundation.Point ToWindowsPoint(MuiCurvePoint p) => new(p.X, p.Y);

        private void RenderKnots(IReadOnlyList<MuiCurvePoint> pts, double w, double h)
        {
            foreach (var shape in _knotShapes)
                _canvas.Children.Remove(shape);
            _knotShapes.Clear();

            var accent = Accent;
            for (var i = 0; i < pts.Count; i++)
            {
                var c = MuiCurvePlotMath.ToCanvasPoint(pts[i], w, h);
                var active = i == _activeIndex;
                var diameter = active ? 9.0 : 6.0;
                // In editing mode the endpoints are pinned (vertical-only,
                // not deletable) — render them dimmed as the affordance cue.
                var pinned = PointEditing && (i == 0 || i == pts.Count - 1);
                var dot = new Ellipse
                {
                    Width = diameter,
                    Height = diameter,
                    Fill = accent,
                    Opacity = pinned ? 0.55 : 1.0,
                    IsHitTestVisible = false,
                };
                Canvas.SetLeft(dot, c.X - diameter / 2);
                Canvas.SetTop(dot, c.Y - diameter / 2);
                _knotShapes.Add(dot);
                _canvas.Children.Add(dot);
            }
        }

        private void RenderHistogram()
        {
            var (w, h) = PlotBox;
            var bins = HistogramBins;
            if (double.IsNaN(w) || double.IsNaN(h) || w <= 0 || h <= 0 || bins is not { Length: > 0 })
            {
                _histogram.Points = new PointCollection();
                return;
            }
            // Token-tinted 6%-alpha fill (the legacy plot's backdrop
            // treatment, re-expressed over the MapleTextMain token).
            var tint = ((SolidColorBrush)R("MapleTextMain")).Color;
            _histogram.Fill = new SolidColorBrush(Windows.UI.Color.FromArgb(0x0F, tint.R, tint.G, tint.B));

            uint peak = 1;
            foreach (var count in bins)
                if (count > peak) peak = count;
            var scale = h / Math.Log(1.0 + peak);
            var pts = new PointCollection { new Windows.Foundation.Point(0, h) };
            for (var i = 0; i < bins.Length; i++)
            {
                var x = (double)i / (bins.Length - 1) * w;
                var y = h - Math.Log(1.0 + bins[i]) * scale * 0.88;
                pts.Add(new Windows.Foundation.Point(x, y));
            }
            pts.Add(new Windows.Foundation.Point(w, h));
            _histogram.Points = pts;
        }
    }
}

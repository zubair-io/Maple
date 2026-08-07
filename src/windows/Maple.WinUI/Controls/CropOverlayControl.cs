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
    /// Interactive crop overlay (#2582) — the web crop-overlay component's
    /// interaction model over the image footprint: four dark mask rects, the
    /// frame stroke, a rule-of-thirds grid, corner circles and edge mid-point
    /// bars. Hit tolerance 14 px; MIN_CROP_FRACTION 0.05; corners resize both
    /// axes, edges one, the interior moves the rect; a fixed aspect constrains
    /// resizes. The host feeds SetState and receives CropChanged per drag tick
    /// (one undo boundary per gesture comes from the session's quiet timer).
    /// </summary>
    public sealed class CropOverlayControl : Canvas
    {
        private const double HandleTolerance = 14;
        private const double MinCropFraction = 0.05;

        private static readonly Color MaskColor = Color.FromArgb(0x8C, 0x00, 0x00, 0x00);   // 55% black
        private static readonly Color FrameColor = Color.FromArgb(0xE6, 0xFF, 0xFF, 0xFF);  // 90% white
        private static readonly Color GridColor = Color.FromArgb(0x59, 0xFF, 0xFF, 0xFF);   // 35% white

        private readonly Rectangle[] _masks = new Rectangle[4];
        private readonly Rectangle _frame;
        private readonly Line[] _grid = new Line[4];
        private readonly Ellipse[] _corners = new Ellipse[4];
        private readonly Rectangle[] _edges = new Rectangle[4];

        private Rect _footprint;                     // image rect in local coords
        private CropState _crop = CropState.Identity;
        private double? _aspect;                     // width / height, null = free
        private string? _dragHandle;
        private CropState _dragStart;
        private Windows.Foundation.Point _dragStartPos;

        public event Action<CropState>? CropChanged;

        private readonly record struct Rect(double X, double Y, double W, double H);

        public CropOverlayControl()
        {
            for (var i = 0; i < 4; i++)
            {
                _masks[i] = new Rectangle { Fill = new SolidColorBrush(MaskColor), IsHitTestVisible = false };
                Children.Add(_masks[i]);
            }
            for (var i = 0; i < 4; i++)
            {
                _grid[i] = new Line
                {
                    Stroke = new SolidColorBrush(GridColor),
                    StrokeThickness = 0.5,
                    IsHitTestVisible = false,
                };
                Children.Add(_grid[i]);
            }
            _frame = new Rectangle
            {
                Stroke = new SolidColorBrush(FrameColor),
                StrokeThickness = 1,
                Fill = new SolidColorBrush(Color.FromArgb(0, 0, 0, 0)),   // hit-testable interior
                IsHitTestVisible = false,
            };
            Children.Add(_frame);
            for (var i = 0; i < 4; i++)
            {
                _corners[i] = new Ellipse
                {
                    Width = 12,
                    Height = 12,
                    Fill = new SolidColorBrush(FrameColor),
                    IsHitTestVisible = false,
                };
                _edges[i] = new Rectangle { Fill = new SolidColorBrush(FrameColor), IsHitTestVisible = false };
                Children.Add(_corners[i]);
                Children.Add(_edges[i]);
            }

            Background = new SolidColorBrush(Color.FromArgb(0, 0, 0, 0));   // receive pointer everywhere
            PointerPressed += OnPointerPressed;
            PointerMoved += OnPointerMoved;
            PointerReleased += OnPointerReleased;
            PointerCanceled += OnPointerReleased;
            PointerCaptureLost += (_, _) => _dragHandle = null;
        }

        // --- host API ---

        /// <summary>Footprint = the un-cropped image rect in this control's
        /// coordinate space (the fit box the frame is displayed in).</summary>
        public void SetState(double footprintX, double footprintY,
            double footprintW, double footprintH, CropState crop, double? aspect)
        {
            _footprint = new Rect(footprintX, footprintY, footprintW, footprintH);
            _crop = crop;
            _aspect = aspect;
            Render();
        }

        // --- geometry (crop-geometry.ts) ---

        private Rect CropRectPx()
        {
            var c = _crop.RectIsValid ? _crop : CropState.Identity;
            return new Rect(
                _footprint.X + c.Left * _footprint.W,
                _footprint.Y + c.Top * _footprint.H,
                (c.Right - c.Left) * _footprint.W,
                (c.Bottom - c.Top) * _footprint.H);
        }

        private string? HitTestHandle(Windows.Foundation.Point p)
        {
            var r = CropRectPx();
            var candidates = new (string Id, double X, double Y)[]
            {
                ("tl", r.X, r.Y), ("tr", r.X + r.W, r.Y),
                ("bl", r.X, r.Y + r.H), ("br", r.X + r.W, r.Y + r.H),
                ("t", r.X + r.W / 2, r.Y), ("b", r.X + r.W / 2, r.Y + r.H),
                ("l", r.X, r.Y + r.H / 2), ("r", r.X + r.W, r.Y + r.H / 2),
            };
            string? best = null;
            var bestDist = HandleTolerance;
            foreach (var (id, x, y) in candidates)
            {
                var d = Math.Sqrt((p.X - x) * (p.X - x) + (p.Y - y) * (p.Y - y));
                if (d <= bestDist)
                {
                    best = id;
                    bestDist = d;
                }
            }
            if (best != null)
                return best;
            return p.X >= r.X && p.X <= r.X + r.W && p.Y >= r.Y && p.Y <= r.Y + r.H
                ? "move"
                : null;
        }

        private CropState ResizeCrop(CropState start, string handle, double dxN, double dyN)
        {
            double top = start.Top, left = start.Left, bottom = start.Bottom, right = start.Right;
            if (handle.Contains('l')) left = Math.Clamp(left + dxN, 0, right - MinCropFraction);
            if (handle.Contains('r')) right = Math.Clamp(right + dxN, left + MinCropFraction, 1);
            if (handle.Contains('t')) top = Math.Clamp(top + dyN, 0, bottom - MinCropFraction);
            if (handle.Contains('b')) bottom = Math.Clamp(bottom + dyN, top + MinCropFraction, 1);

            var next = start with { Top = top, Left = left, Bottom = bottom, Right = right };
            return _aspect is { } aspect ? ConstrainAspect(next, handle, aspect) : next;
        }

        /// <summary>Re-impose the fixed ratio after an edge/corner drag by
        /// adjusting the axis the handle did not primarily move, anchored on
        /// the opposite edge/corner.</summary>
        private CropState ConstrainAspect(CropState c, string handle, double aspect)
        {
            // aspect is width/height in IMAGE-normalized terms scaled by the
            // footprint, so convert to the normalized domain.
            var ratioN = aspect * _footprint.H / _footprint.W;
            var w = c.Right - c.Left;
            var h = c.Bottom - c.Top;
            switch (handle)
            {
                case "l" or "r":
                    h = Math.Min(w / ratioN, 1);
                    var cy = (c.Top + c.Bottom) / 2;
                    c = c with { Top = Math.Max(0, cy - h / 2), Bottom = Math.Min(1, cy + h / 2) };
                    break;
                case "t" or "b":
                    w = Math.Min(h * ratioN, 1);
                    var cx = (c.Left + c.Right) / 2;
                    c = c with { Left = Math.Max(0, cx - w / 2), Right = Math.Min(1, cx + w / 2) };
                    break;
                default:
                    // Corners: height follows width, anchored vertically on the
                    // stationary edge.
                    h = Math.Min(w / ratioN, 1);
                    c = handle is "tl" or "tr"
                        ? c with { Top = Math.Max(0, c.Bottom - h) }
                        : c with { Bottom = Math.Min(1, c.Top + h) };
                    break;
            }
            return c;
        }

        private static CropState MoveCrop(CropState start, double dxN, double dyN)
        {
            var w = start.Right - start.Left;
            var h = start.Bottom - start.Top;
            var left = Math.Clamp(start.Left + dxN, 0, 1 - w);
            var top = Math.Clamp(start.Top + dyN, 0, 1 - h);
            return start with { Left = left, Top = top, Right = left + w, Bottom = top + h };
        }

        // --- pointer interaction ---

        private void OnPointerPressed(object sender, PointerRoutedEventArgs e)
        {
            if (!e.GetCurrentPoint(this).Properties.IsLeftButtonPressed || _footprint.W <= 0)
                return;
            var pos = e.GetCurrentPoint(this).Position;
            _dragHandle = HitTestHandle(pos);
            if (_dragHandle == null)
                return;
            _dragStart = _crop.RectIsValid ? _crop : CropState.Identity with { Angle = _crop.Angle };
            _dragStartPos = pos;
            CapturePointer(e.Pointer);
            e.Handled = true;
        }

        private void OnPointerMoved(object sender, PointerRoutedEventArgs e)
        {
            if (_dragHandle == null)
                return;
            var pos = e.GetCurrentPoint(this).Position;
            var dxN = (pos.X - _dragStartPos.X) / _footprint.W;
            var dyN = (pos.Y - _dragStartPos.Y) / _footprint.H;
            _crop = _dragHandle == "move"
                ? MoveCrop(_dragStart, dxN, dyN)
                : ResizeCrop(_dragStart, _dragHandle, dxN, dyN);
            CropChanged?.Invoke(_crop);
            Render();
            e.Handled = true;
        }

        private void OnPointerReleased(object sender, PointerRoutedEventArgs e)
        {
            if (_dragHandle == null)
                return;
            _dragHandle = null;
            ReleasePointerCaptures();
            e.Handled = true;
        }

        // --- rendering ---

        private void Render()
        {
            if (_footprint.W <= 0 || _footprint.H <= 0)
                return;
            var r = CropRectPx();
            var f = _footprint;

            // Four mask rects bounded to the image footprint (Apple parity).
            SetRect(_masks[0], f.X, f.Y, f.W, r.Y - f.Y);                                  // top
            SetRect(_masks[1], f.X, r.Y + r.H, f.W, f.Y + f.H - (r.Y + r.H));              // bottom
            SetRect(_masks[2], f.X, r.Y, r.X - f.X, r.H);                                  // left
            SetRect(_masks[3], r.X + r.W, r.Y, f.X + f.W - (r.X + r.W), r.H);              // right

            SetRect(_frame, r.X, r.Y, r.W, r.H);

            for (var i = 0; i < 2; i++)
            {
                var x = r.X + r.W * (i + 1) / 3;
                _grid[i].X1 = x; _grid[i].X2 = x; _grid[i].Y1 = r.Y; _grid[i].Y2 = r.Y + r.H;
                var y = r.Y + r.H * (i + 1) / 3;
                _grid[i + 2].X1 = r.X; _grid[i + 2].X2 = r.X + r.W;
                _grid[i + 2].Y1 = y; _grid[i + 2].Y2 = y;
            }

            var cornerPos = new (double X, double Y)[]
            {
                (r.X, r.Y), (r.X + r.W, r.Y), (r.X, r.Y + r.H), (r.X + r.W, r.Y + r.H),
            };
            for (var i = 0; i < 4; i++)
            {
                SetLeft(_corners[i], cornerPos[i].X - 6);
                SetTop(_corners[i], cornerPos[i].Y - 6);
            }

            // Edge mid-point bars: 24×4 horizontal, 4×24 vertical.
            SetRect(_edges[0], r.X + r.W / 2 - 12, r.Y - 2, 24, 4);                        // top
            SetRect(_edges[1], r.X + r.W / 2 - 12, r.Y + r.H - 2, 24, 4);                  // bottom
            SetRect(_edges[2], r.X - 2, r.Y + r.H / 2 - 12, 4, 24);                        // left
            SetRect(_edges[3], r.X + r.W - 2, r.Y + r.H / 2 - 12, 4, 24);                  // right
        }

        private static void SetRect(Rectangle rect, double x, double y, double w, double h)
        {
            SetLeft(rect, x);
            SetTop(rect, y);
            rect.Width = Math.Max(0, w);
            rect.Height = Math.Max(0, h);
        }
    }
}

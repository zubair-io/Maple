using System;
using System.Collections.Generic;
using Microsoft.UI.Input;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Shapes;
using Windows.Foundation;
using Windows.System;
using Maple.UI.Atoms;

namespace Maple.UI
{
    /// <summary>
    /// Maple.UI Crop Overlay organism (unified-component-catalog.md
    /// §4.5, "Crop Overlay" row: "Draggable crop with grid and mask",
    /// built from Drag Bar, Icon) — a darkened mask outside
    /// <see cref="Rect"/>, a rule-of-thirds grid inside it, and eight
    /// small square handles (the four corners plus edge midpoints,
    /// styled like a compact <see cref="MuiDragBar"/> grip) a caller
    /// drags to resize. All resize math is
    /// <see cref="MuiCropOverlayMath.ApplyHandleDelta"/>, unit tested
    /// standalone; dragging the region's own body (not a handle) calls
    /// <see cref="MuiCropOverlayMath.Translate"/> instead. Coordinates
    /// are in the same image-pixel space <see cref="Bounds"/> describes —
    /// the host (<see cref="MuiImageCanvas"/>) is responsible for scaling
    /// this control's own rendered size to match that space.
    /// </summary>
    public sealed class MuiCropOverlay : ContentControl
    {
        private const double HandleSize = 12;

        public static readonly DependencyProperty RectProperty =
            DependencyProperty.Register(nameof(Rect), typeof(MuiCropRect), typeof(MuiCropOverlay),
                new PropertyMetadata(default(MuiCropRect), (d, _) => ((MuiCropOverlay)d).Rebuild()));

        public static readonly DependencyProperty BoundsProperty =
            DependencyProperty.Register(nameof(Bounds), typeof(Size), typeof(MuiCropOverlay),
                new PropertyMetadata(default(Size), (d, _) => ((MuiCropOverlay)d).Rebuild()));

        public static readonly DependencyProperty AspectRatioProperty =
            DependencyProperty.Register(nameof(AspectRatio), typeof(double?), typeof(MuiCropOverlay),
                new PropertyMetadata(null));

        public static readonly DependencyProperty MinRegionWidthProperty =
            DependencyProperty.Register(nameof(MinRegionWidth), typeof(double), typeof(MuiCropOverlay),
                new PropertyMetadata(MuiCropOverlayMath.MinSize));

        public static readonly DependencyProperty MinRegionHeightProperty =
            DependencyProperty.Register(nameof(MinRegionHeight), typeof(double), typeof(MuiCropOverlay),
                new PropertyMetadata(MuiCropOverlayMath.MinSize));

        public MuiCropRect Rect { get => (MuiCropRect)GetValue(RectProperty); set => SetValue(RectProperty, value); }
        public Size Bounds { get => (Size)GetValue(BoundsProperty); set => SetValue(BoundsProperty, value); }

        /// <summary>Fixed width/height ratio (in this overlay's pixel space)
        /// re-imposed after every handle drag via
        /// <see cref="MuiCropOverlayMath.ConstrainAspect"/>. Null (default)
        /// leaves resizes free-form. (MN2, #3051 — the crop session's
        /// aspect lock.)</summary>
        public double? AspectRatio { get => (double?)GetValue(AspectRatioProperty); set => SetValue(AspectRatioProperty, value); }

        /// <summary>Per-axis minimum region size in pixels — the app's crop
        /// session feeds 5% of each footprint axis. Defaults keep the
        /// original fixed <see cref="MuiCropOverlayMath.MinSize"/>.</summary>
        public double MinRegionWidth { get => (double)GetValue(MinRegionWidthProperty); set => SetValue(MinRegionWidthProperty, value); }

        /// <inheritdoc cref="MinRegionWidth"/>
        public double MinRegionHeight { get => (double)GetValue(MinRegionHeightProperty); set => SetValue(MinRegionHeightProperty, value); }

        public event EventHandler<MuiCropRect>? RectChanged;
        public event EventHandler? GestureStarted;
        public event EventHandler? GestureCompleted;

        private readonly Canvas _canvas = new();
        // Four bands around Rect, not one full-bounds panel — a mask has
        // to leave a hole over the crop region, and WinUI has no cheap
        // built-in "rect with a hole" brush this wave can reach for
        // safely, so the hole is just the gap between these four pieces.
        private readonly Border _maskTop = new();
        private readonly Border _maskBottom = new();
        private readonly Border _maskLeft = new();
        private readonly Border _maskRight = new();
        // Transparent (not null) background: a null-background Border only
        // hit-tests its 1px border stroke, which would make the drag-the-
        // region-body gesture ungrabbable everywhere but the frame line.
        private readonly MuiCropTarget _region = new("Move crop region");
        private readonly Canvas _gridLines = new() { IsHitTestVisible = false };
        private readonly List<MuiCropTarget> _handles = new();
        private readonly Dictionary<MuiCropTarget, MuiCropHandle> _handleKind = new();
        private bool _keyboardGesture;

        private bool _draggingRegion;
        private MuiCropHandle? _draggingHandle;
        private Point _dragOrigin;
        private uint? _activePointerId;

        public MuiCropOverlay()
        {
            _region.Frame.BorderThickness = new Thickness(1);
            _region.Frame.Background = new SolidColorBrush(Microsoft.UI.Colors.Transparent);
            WireKeyboard(_region, null);
            _canvas.Children.Add(_maskTop);
            _canvas.Children.Add(_maskBottom);
            _canvas.Children.Add(_maskLeft);
            _canvas.Children.Add(_maskRight);
            _canvas.Children.Add(_region);
            _canvas.Children.Add(_gridLines);

            foreach (MuiCropHandle kind in Enum.GetValues(typeof(MuiCropHandle)))
            {
                var handle = new MuiCropTarget($"Crop {HandleName(kind)} handle")
                {
                    Width = HandleSize,
                    Height = HandleSize,
                };
                handle.Frame.CornerRadius = new CornerRadius(2);
                handle.Frame.BorderThickness = new Thickness(1);
                WireKeyboard(handle, kind);
                handle.PointerPressed += (_, e) => OnHandlePressed(kind, e);
                _handleKind[handle] = kind;
                _handles.Add(handle);
                _canvas.Children.Add(handle);
            }

            _region.PointerPressed += OnRegionPressed;
            PointerMoved += OnPointerMoved;
            PointerReleased += OnPointerEnded;
            PointerCanceled += OnPointerEnded;
            PointerCaptureLost += OnPointerEnded;
            Unloaded += (_, _) => { EndDrag(); EndKeyboardGesture(); };

            Content = _canvas;
            IsHitTestVisible = true;
            Rebuild();
        }

        private static Brush R(string key) => (Brush)Application.Current.Resources[key];

        private static string HandleName(MuiCropHandle kind) => kind switch
        {
            MuiCropHandle.TopLeft => "top left", MuiCropHandle.TopRight => "top right",
            MuiCropHandle.BottomLeft => "bottom left", MuiCropHandle.BottomRight => "bottom right",
            _ => kind.ToString().ToLowerInvariant(),
        };

        private void WireKeyboard(MuiCropTarget target, MuiCropHandle? handle)
        {
            target.PointerPressed += (_, _) => target.Focus(FocusState.Pointer);
            target.KeyDown += (_, e) =>
            {
                var (dx, dy) = e.Key switch
                {
                    VirtualKey.Left => (-1.0, 0.0), VirtualKey.Right => (1.0, 0.0),
                    VirtualKey.Up => (0.0, -1.0), VirtualKey.Down => (0.0, 1.0),
                    _ => (0.0, 0.0),
                };
                if (dx == 0 && dy == 0) return;
                e.Handled = true; // Never navigate to a different photo.
                if (!IsEnabled || _activePointerId != null) return;
                var step = InputKeyboardSource.GetKeyStateForCurrentThread(VirtualKey.Shift)
                    .HasFlag(Windows.UI.Core.CoreVirtualKeyStates.Down) ? 10 : 1;
                var resized = handle is { } kind
                    ? MuiCropOverlayMath.ApplyHandleDelta(Rect, kind, dx * step, dy * step,
                        Bounds.Width, Bounds.Height, MinRegionWidth, MinRegionHeight)
                    : MuiCropOverlayMath.Translate(Rect, dx * step, dy * step, Bounds.Width, Bounds.Height);
                var next = handle is { } aspectHandle && AspectRatio is { } aspect
                    ? MuiCropOverlayMath.ConstrainAspect(resized, aspectHandle, aspect,
                        Bounds.Width, Bounds.Height, MinRegionWidth, MinRegionHeight) : resized;
                if (next == Rect) return;
                if (!_keyboardGesture)
                {
                    _keyboardGesture = true;
                    GestureStarted?.Invoke(this, EventArgs.Empty);
                }
                Rect = next;
                RectChanged?.Invoke(this, next);
            };
            target.KeyUp += (_, e) =>
            {
                if (e.Key is VirtualKey.Left or VirtualKey.Right or VirtualKey.Up or VirtualKey.Down)
                {
                    EndKeyboardGesture();
                    e.Handled = true;
                }
            };
            target.LostFocus += (_, _) => EndKeyboardGesture();
        }

        private void EndKeyboardGesture()
        {
            if (!_keyboardGesture) return;
            _keyboardGesture = false;
            GestureCompleted?.Invoke(this, EventArgs.Empty);
        }

        private void OnHandlePressed(MuiCropHandle kind, PointerRoutedEventArgs e)
        {
            if (!CanStartDrag(e)) return;
            _draggingHandle = kind;
            _dragOrigin = e.GetCurrentPoint(this).Position;
            // Capture on the control (the library's pointer-capture-drag
            // convention — MuiPad2D/MuiCurvePlot) so fast drags that leave
            // the overlay keep tracking until release.
            StartDrag(e);
            e.Handled = true;
        }

        private void OnRegionPressed(object sender, PointerRoutedEventArgs e)
        {
            if (!CanStartDrag(e)) return;
            _draggingRegion = true;
            _dragOrigin = e.GetCurrentPoint(this).Position;
            StartDrag(e);
            e.Handled = true;
        }

        private void EndDrag()
        {
            if (_activePointerId == null) return;
            _activePointerId = null;
            _draggingRegion = false;
            _draggingHandle = null;
            GestureCompleted?.Invoke(this, EventArgs.Empty);
            ReleasePointerCaptures();
        }

        private bool CanStartDrag(PointerRoutedEventArgs e) => IsEnabled && _activePointerId == null
            && e.GetCurrentPoint(this).Properties.IsLeftButtonPressed;

        private void StartDrag(PointerRoutedEventArgs e)
        {
            EndKeyboardGesture();
            _activePointerId = e.Pointer.PointerId;
            GestureStarted?.Invoke(this, EventArgs.Empty);
            if (!CapturePointer(e.Pointer)) EndDrag();
        }

        private void OnPointerEnded(object sender, PointerRoutedEventArgs e)
        {
            if (e.Pointer.PointerId == _activePointerId) EndDrag();
        }

        private void OnPointerMoved(object sender, PointerRoutedEventArgs e)
        {
            if (e.Pointer.PointerId != _activePointerId || (_draggingHandle is null && !_draggingRegion)) return;
            var pos = e.GetCurrentPoint(this).Position;
            var dx = pos.X - _dragOrigin.X;
            var dy = pos.Y - _dragOrigin.Y;
            _dragOrigin = pos;

            var resized = _draggingHandle is { } handle
                ? MuiCropOverlayMath.ApplyHandleDelta(Rect, handle, dx, dy, Bounds.Width, Bounds.Height,
                    MinRegionWidth, MinRegionHeight)
                : MuiCropOverlayMath.Translate(Rect, dx, dy, Bounds.Width, Bounds.Height);
            var next = _draggingHandle is { } aspectHandle && AspectRatio is { } aspect
                ? MuiCropOverlayMath.ConstrainAspect(resized, aspectHandle, aspect, Bounds.Width, Bounds.Height,
                    MinRegionWidth, MinRegionHeight)
                : resized;

            Rect = next;
            RectChanged?.Invoke(this, next);
        }

        private void Rebuild()
        {
            var position = $"Left {Rect.Left:0.#}, top {Rect.Top:0.#}, width {Rect.Width:0.#}, height {Rect.Height:0.#} pixels";
            AutomationProperties.SetItemStatus(_region, position);
            foreach (var target in _handles) AutomationProperties.SetItemStatus(target, position);
            var maskBrush = new SolidColorBrush(Windows.UI.Color.FromArgb(0x99, 0, 0, 0));
            var boundsWidth = Math.Max(0, Bounds.Width);
            var boundsHeight = Math.Max(0, Bounds.Height);
            _canvas.Width = boundsWidth;
            _canvas.Height = boundsHeight;

            LayoutBand(_maskTop, maskBrush, 0, 0, boundsWidth, Rect.Top);
            LayoutBand(_maskBottom, maskBrush, 0, Rect.Bottom, boundsWidth, boundsHeight - Rect.Bottom);
            LayoutBand(_maskLeft, maskBrush, 0, Rect.Top, Rect.Left, Rect.Height);
            LayoutBand(_maskRight, maskBrush, Rect.Right, Rect.Top, boundsWidth - Rect.Right, Rect.Height);

            _region.Frame.BorderBrush = R("MaplePrimary");
            _region.Width = Rect.Width;
            _region.Height = Rect.Height;
            Canvas.SetLeft(_region, Rect.X);
            Canvas.SetTop(_region, Rect.Y);

            RebuildGrid();

            foreach (var handle in _handles)
            {
                handle.Frame.Background = R("MapleSurface");
                handle.Frame.BorderBrush = R("MaplePrimary");
                var (x, y) = HandlePosition(_handleKind[handle]);
                Canvas.SetLeft(handle, x - HandleSize / 2);
                Canvas.SetTop(handle, y - HandleSize / 2);
            }
        }

        private static void LayoutBand(Border band, Brush brush, double x, double y, double width, double height)
        {
            band.Background = brush;
            band.Width = Math.Max(0, width);
            band.Height = Math.Max(0, height);
            Canvas.SetLeft(band, x);
            Canvas.SetTop(band, y);
        }

        private (double X, double Y) HandlePosition(MuiCropHandle kind) => kind switch
        {
            MuiCropHandle.TopLeft => (Rect.Left, Rect.Top),
            MuiCropHandle.Top => (Rect.Left + Rect.Width / 2, Rect.Top),
            MuiCropHandle.TopRight => (Rect.Right, Rect.Top),
            MuiCropHandle.Right => (Rect.Right, Rect.Top + Rect.Height / 2),
            MuiCropHandle.BottomRight => (Rect.Right, Rect.Bottom),
            MuiCropHandle.Bottom => (Rect.Left + Rect.Width / 2, Rect.Bottom),
            MuiCropHandle.BottomLeft => (Rect.Left, Rect.Bottom),
            _ => (Rect.Left, Rect.Top + Rect.Height / 2), // Left
        };

        private void RebuildGrid()
        {
            _gridLines.Children.Clear();
            for (var i = 1; i <= 2; i++)
            {
                var x = Rect.Left + Rect.Width * i / 3.0;
                _gridLines.Children.Add(GridLine(x, Rect.Top, x, Rect.Bottom));
                var y = Rect.Top + Rect.Height * i / 3.0;
                _gridLines.Children.Add(GridLine(Rect.Left, y, Rect.Right, y));
            }
        }

        private static Line GridLine(double x1, double y1, double x2, double y2) => new()
        {
            X1 = x1,
            Y1 = y1,
            X2 = x2,
            Y2 = y2,
            Stroke = R("MapleBorderHi"),
            StrokeThickness = 1,
            Opacity = 0.6,
        };
    }
}

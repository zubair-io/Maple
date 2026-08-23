using System;
using System.Collections.Generic;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Shapes;
using Windows.Foundation;
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

        public MuiCropRect Rect { get => (MuiCropRect)GetValue(RectProperty); set => SetValue(RectProperty, value); }
        public Size Bounds { get => (Size)GetValue(BoundsProperty); set => SetValue(BoundsProperty, value); }

        public event EventHandler<MuiCropRect>? RectChanged;

        private readonly Canvas _canvas = new();
        // Four bands around Rect, not one full-bounds panel — a mask has
        // to leave a hole over the crop region, and WinUI has no cheap
        // built-in "rect with a hole" brush this wave can reach for
        // safely, so the hole is just the gap between these four pieces.
        private readonly Border _maskTop = new();
        private readonly Border _maskBottom = new();
        private readonly Border _maskLeft = new();
        private readonly Border _maskRight = new();
        private readonly Border _region = new() { BorderThickness = new Thickness(1) };
        private readonly Canvas _gridLines = new() { IsHitTestVisible = false };
        private readonly List<Border> _handles = new();
        private readonly Dictionary<Border, MuiCropHandle> _handleKind = new();

        private bool _draggingRegion;
        private MuiCropHandle? _draggingHandle;
        private Point _dragOrigin;

        public MuiCropOverlay()
        {
            _canvas.Children.Add(_maskTop);
            _canvas.Children.Add(_maskBottom);
            _canvas.Children.Add(_maskLeft);
            _canvas.Children.Add(_maskRight);
            _canvas.Children.Add(_region);
            _canvas.Children.Add(_gridLines);

            foreach (MuiCropHandle kind in Enum.GetValues(typeof(MuiCropHandle)))
            {
                var handle = new Border
                {
                    Width = HandleSize,
                    Height = HandleSize,
                    CornerRadius = new CornerRadius(2),
                    BorderThickness = new Thickness(1),
                };
                handle.PointerPressed += (_, e) => OnHandlePressed(kind, e);
                _handleKind[handle] = kind;
                _handles.Add(handle);
                _canvas.Children.Add(handle);
            }

            _region.PointerPressed += OnRegionPressed;
            PointerMoved += OnPointerMoved;
            PointerReleased += (_, _) => { _draggingRegion = false; _draggingHandle = null; };

            Content = _canvas;
            IsHitTestVisible = true;
            Rebuild();
        }

        private static Brush R(string key) => (Brush)Application.Current.Resources[key];

        private void OnHandlePressed(MuiCropHandle kind, PointerRoutedEventArgs e)
        {
            _draggingHandle = kind;
            _dragOrigin = e.GetCurrentPoint(this).Position;
            e.Handled = true;
        }

        private void OnRegionPressed(object sender, PointerRoutedEventArgs e)
        {
            _draggingRegion = true;
            _dragOrigin = e.GetCurrentPoint(this).Position;
            e.Handled = true;
        }

        private void OnPointerMoved(object sender, PointerRoutedEventArgs e)
        {
            if (_draggingHandle is null && !_draggingRegion) return;
            var pos = e.GetCurrentPoint(this).Position;
            var dx = pos.X - _dragOrigin.X;
            var dy = pos.Y - _dragOrigin.Y;
            _dragOrigin = pos;

            var next = _draggingHandle is { } handle
                ? MuiCropOverlayMath.ApplyHandleDelta(Rect, handle, dx, dy, Bounds.Width, Bounds.Height)
                : MuiCropOverlayMath.Translate(Rect, dx, dy, Bounds.Width, Bounds.Height);

            Rect = next;
            RectChanged?.Invoke(this, next);
        }

        private void Rebuild()
        {
            var maskBrush = new SolidColorBrush(Windows.UI.Color.FromArgb(0x99, 0, 0, 0));
            var boundsWidth = Math.Max(0, Bounds.Width);
            var boundsHeight = Math.Max(0, Bounds.Height);
            _canvas.Width = boundsWidth;
            _canvas.Height = boundsHeight;

            LayoutBand(_maskTop, maskBrush, 0, 0, boundsWidth, Rect.Top);
            LayoutBand(_maskBottom, maskBrush, 0, Rect.Bottom, boundsWidth, boundsHeight - Rect.Bottom);
            LayoutBand(_maskLeft, maskBrush, 0, Rect.Top, Rect.Left, Rect.Height);
            LayoutBand(_maskRight, maskBrush, Rect.Right, Rect.Top, boundsWidth - Rect.Right, Rect.Height);

            _region.BorderBrush = R("MaplePrimary");
            _region.Width = Rect.Width;
            _region.Height = Rect.Height;
            Canvas.SetLeft(_region, Rect.X);
            Canvas.SetTop(_region, Rect.Y);

            RebuildGrid();

            foreach (var handle in _handles)
            {
                handle.Background = R("MapleSurface");
                handle.BorderBrush = R("MaplePrimary");
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

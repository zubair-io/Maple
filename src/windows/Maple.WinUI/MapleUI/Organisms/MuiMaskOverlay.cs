using System;
using System.Linq;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Shapes;
using Windows.Foundation;

namespace Maple.UI
{
    /// <summary>
    /// Maple.UI Mask Overlay organism (docs/design/maple-ui/components/
    /// mask-overlay.md) — the on-canvas half of local adjustments (#280/
    /// #3406), the masking sibling of <see cref="MuiCropOverlay"/>: a pin +
    /// dashed axis for a linear gradient, or a center pin + dashed ellipse +
    /// per-axis resize pins + a rotation pin for a radial mask. Renders only
    /// the selected layer — an unselected layer has no overlay presence; its
    /// list row is the only way in (mask-overlay.md § Variants).
    ///
    /// Coordinates are in the same normalized [0, 1] mask space the render
    /// pipeline evaluates in (<see cref="MuiMaskShape"/>); the host is
    /// responsible for scaling this control's own rendered size (via
    /// <see cref="Bounds"/>) and for placing it inside whatever transform
    /// chain already carries the image through crop/straighten — the same
    /// "host scales, this control just draws" contract
    /// <see cref="MuiCropOverlay"/> documents.
    /// </summary>
    public sealed class MuiMaskOverlay : ContentControl
    {
        private const double PinSize = 12;
        private const double BodyHandleSize = 10;

        public static readonly DependencyProperty ShapeProperty =
            DependencyProperty.Register(nameof(Shape), typeof(MuiMaskShape), typeof(MuiMaskOverlay),
                new PropertyMetadata(null, (d, _) => ((MuiMaskOverlay)d).Rebuild()));

        public static readonly DependencyProperty BoundsProperty =
            DependencyProperty.Register(nameof(Bounds), typeof(Size), typeof(MuiMaskOverlay),
                new PropertyMetadata(default(Size), (d, _) => ((MuiMaskOverlay)d).Rebuild()));

        /// <summary>The selected layer's mask geometry, or null when nothing
        /// is selected — mask-overlay.md's "No selection" state: the overlay
        /// mounts empty.</summary>
        public MuiMaskShape? Shape { get => (MuiMaskShape?)GetValue(ShapeProperty); set => SetValue(ShapeProperty, value); }

        public Size Bounds { get => (Size)GetValue(BoundsProperty); set => SetValue(BoundsProperty, value); }

        public static readonly DependencyProperty InvertProperty =
            DependencyProperty.Register(nameof(Invert), typeof(bool), typeof(MuiMaskOverlay),
                new PropertyMetadata(false, (d, _) => ((MuiMaskOverlay)d).Rebuild()));

        /// <summary>Accessibility-only (mask-overlay.md's "Inverted radial
        /// mask" value string) — Invert has no overlay handle of its own.</summary>
        public bool Invert { get => (bool)GetValue(InvertProperty); set => SetValue(InvertProperty, value); }

        /// <summary>Fires on every pointer move during a drag (live preview);
        /// the host writes it straight into the model and re-renders, the
        /// same <see cref="MuiCropOverlay.RectChanged"/> contract.</summary>
        public event EventHandler<MuiMaskShape>? ShapeChanged;

        private readonly Canvas _canvas = new();
        private readonly Polyline _outline = new() { StrokeDashArray = new DoubleCollection { 4, 3 }, StrokeThickness = 1.5 };
        private readonly Line _axis = new() { StrokeDashArray = new DoubleCollection { 4, 3 }, StrokeThickness = 1.5 };
        private readonly Border _startPin = Pin();
        private readonly Border _endPin = Pin();
        private readonly Border _bodyHandle = Pin(BodyHandleSize);
        private readonly Border _centerPin = Pin();
        private readonly Border _radiusXPin = Pin();
        private readonly Border _radiusYPin = Pin();
        private readonly Border _rotatePin = Pin();

        private MuiMaskHandle? _draggingHandle;

        public MuiMaskOverlay()
        {
            _canvas.Children.Add(_outline);
            _canvas.Children.Add(_axis);
            foreach (var (pin, handle) in new[]
            {
                (_startPin, MuiMaskHandle.LinearStart), (_endPin, MuiMaskHandle.LinearEnd), (_bodyHandle, MuiMaskHandle.LinearBody),
                (_centerPin, MuiMaskHandle.RadialCenter), (_radiusXPin, MuiMaskHandle.RadialRadiusX),
                (_radiusYPin, MuiMaskHandle.RadialRadiusY), (_rotatePin, MuiMaskHandle.RadialRotate),
            })
            {
                pin.PointerPressed += (_, e) => OnHandlePressed(handle, e);
                _canvas.Children.Add(pin);
            }

            PointerMoved += OnPointerMoved;
            PointerReleased += (_, _) => EndDrag();
            PointerCanceled += (_, _) => EndDrag();
            PointerCaptureLost += (_, _) => _draggingHandle = null;

            Content = _canvas;
            IsHitTestVisible = true;
            Rebuild();
        }

        private static Border Pin(double size = PinSize) => new()
        {
            Width = size,
            Height = size,
            CornerRadius = new CornerRadius(size / 2),
            BorderThickness = new Thickness(1.5),
        };

        private static Brush R(string key) => (Brush)Application.Current.Resources[key];

        private void OnHandlePressed(MuiMaskHandle handle, PointerRoutedEventArgs e)
        {
            _draggingHandle = handle;
            CapturePointer(e.Pointer);
            e.Handled = true;
        }

        private void EndDrag()
        {
            _draggingHandle = null;
            ReleasePointerCaptures();
        }

        private void OnPointerMoved(object sender, PointerRoutedEventArgs e)
        {
            if (_draggingHandle is not { } handle || Shape is not { } shape)
                return;
            var pos = e.GetCurrentPoint(this).Position;
            var next = MuiMaskOverlayMath.ApplyDrag(
                shape, handle, new MuiMaskPoint(pos.X, pos.Y), Bounds.Width, Bounds.Height);
            Shape = next;
            ShapeChanged?.Invoke(this, next);
            e.Handled = true;
        }

        private void Rebuild()
        {
            var w = Math.Max(0, Bounds.Width);
            var h = Math.Max(0, Bounds.Height);
            _canvas.Width = w;
            _canvas.Height = h;
            Visibility = Shape is null ? Visibility.Collapsed : Visibility.Visible;
            AutomationProperties.SetName(this, ShapeDescription(Shape, Invert));

            var isLinear = Shape is MuiLinearMaskShape;
            var isRadial = Shape is MuiRadialMaskShape;
            _axis.Visibility = isLinear ? Visibility.Visible : Visibility.Collapsed;
            _startPin.Visibility = isLinear ? Visibility.Visible : Visibility.Collapsed;
            _endPin.Visibility = isLinear ? Visibility.Visible : Visibility.Collapsed;
            _bodyHandle.Visibility = isLinear ? Visibility.Visible : Visibility.Collapsed;
            _outline.Visibility = isRadial ? Visibility.Visible : Visibility.Collapsed;
            _centerPin.Visibility = isRadial ? Visibility.Visible : Visibility.Collapsed;
            _radiusXPin.Visibility = isRadial ? Visibility.Visible : Visibility.Collapsed;
            _radiusYPin.Visibility = isRadial ? Visibility.Visible : Visibility.Collapsed;
            _rotatePin.Visibility = isRadial ? Visibility.Visible : Visibility.Collapsed;

            if (Shape is null)
                return;

            var strokeBrush = new SolidColorBrush(Windows.UI.Color.FromArgb(0xE6, 0xFF, 0xFF, 0xFF)); // white @ 0.9
            _axis.Stroke = strokeBrush;
            _outline.Stroke = strokeBrush;

            foreach (var pin in new[] { _startPin, _endPin, _bodyHandle, _centerPin, _radiusXPin, _radiusYPin })
            {
                pin.Background = R("MapleSurface");
                pin.BorderBrush = new SolidColorBrush(Windows.UI.Color.FromArgb(0x80, 0, 0, 0)); // black @ 0.5
            }
            _rotatePin.Background = R("MaplePrimary");
            _rotatePin.BorderBrush = new SolidColorBrush(Windows.UI.Color.FromArgb(0x80, 0, 0, 0));

            switch (Shape)
            {
                case MuiLinearMaskShape l:
                    var start = MuiMaskOverlayMath.ToScreen(l.Start, w, h);
                    var end = MuiMaskOverlayMath.ToScreen(l.End, w, h);
                    var mid = MuiMaskOverlayMath.ToScreen(
                        new MuiMaskPoint((l.Start.X + l.End.X) / 2, (l.Start.Y + l.End.Y) / 2), w, h);
                    _axis.X1 = start.X; _axis.Y1 = start.Y; _axis.X2 = end.X; _axis.Y2 = end.Y;
                    Place(_startPin, start, PinSize);
                    Place(_endPin, end, PinSize);
                    Place(_bodyHandle, mid, BodyHandleSize);
                    AutomationProperties.SetName(_startPin, "Mask handle: gradient start");
                    AutomationProperties.SetName(_endPin, "Mask handle: gradient end");
                    AutomationProperties.SetName(_bodyHandle, "Mask handle: gradient");
                    break;
                case MuiRadialMaskShape r:
                    var outline = MuiMaskOverlayMath.RadialOutline(r);
                    _outline.Points.Clear();
                    foreach (var p in outline.Append(outline[0]))
                        _outline.Points.Add(MuiMaskOverlayMath.ToScreen(p, w, h).ToWindowsPoint());
                    var positions = MuiMaskOverlayMath.HandlePositions(r);
                    Place(_centerPin, MuiMaskOverlayMath.ToScreen(positions[MuiMaskHandle.RadialCenter], w, h), PinSize);
                    Place(_radiusXPin, MuiMaskOverlayMath.ToScreen(positions[MuiMaskHandle.RadialRadiusX], w, h), PinSize);
                    Place(_radiusYPin, MuiMaskOverlayMath.ToScreen(positions[MuiMaskHandle.RadialRadiusY], w, h), PinSize);
                    Place(_rotatePin, MuiMaskOverlayMath.ToScreen(positions[MuiMaskHandle.RadialRotate], w, h), PinSize);
                    AutomationProperties.SetName(_centerPin, "Mask handle: center");
                    AutomationProperties.SetName(_radiusXPin, "Mask handle: horizontal radius");
                    AutomationProperties.SetName(_radiusYPin, "Mask handle: vertical radius");
                    AutomationProperties.SetName(_rotatePin, "Mask handle: rotation");
                    break;
            }
        }

        private static void Place(Border pin, MuiMaskPoint screen, double size)
        {
            Canvas.SetLeft(pin, screen.X - size / 2);
            Canvas.SetTop(pin, screen.Y - size / 2);
        }

        private static string ShapeDescription(MuiMaskShape? shape, bool invert) => shape switch
        {
            MuiLinearMaskShape => "Linear gradient mask",
            MuiRadialMaskShape => invert ? "Inverted radial mask" : "Radial mask",
            _ => "No mask selected",
        };
    }

    internal static class MuiMaskPointExtensions
    {
        public static Point ToWindowsPoint(this MuiMaskPoint p) => new(p.X, p.Y);
    }
}

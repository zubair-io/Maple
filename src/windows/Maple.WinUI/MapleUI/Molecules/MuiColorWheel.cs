using System;
using System.Runtime.InteropServices.WindowsRuntime;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Media.Imaging;
using Microsoft.UI.Xaml.Shapes;
using Windows.UI;

namespace Maple.UI
{
    /// <summary>
    /// Maple.UI Color Wheel molecule (unified-component-catalog.md §2.1,
    /// "Color Wheel" row: "Draggable hue/saturation puck", a primitive plot
    /// with no atom dependency) — a hue disc with a radial saturation fade,
    /// draggable puck, keyboard arrows, and double-tap reset.
    ///
    /// Uses the same rendering TECHNIQUE the app's original hand-rolled
    /// grading wheel established (conic-hue + radial-fade
    /// <see cref="WriteableBitmap"/>, same polar convention: hue 0° right,
    /// increasing counter-clockwise, puck radius = saturation), TOKEN-styled
    /// (the surface/rim colors come from `MapleSurfaceColor`/`MapleTextMain`
    /// rather than literal hex/white) and driving its pointer math through
    /// the standalone, unit-tested <see cref="MuiColorWheelMath"/>. As of
    /// the MN2 wave (#3051) this molecule IS the app's grading wheel — the
    /// legacy control it studied is deleted and MainWindow's Grade panel
    /// builds four of these.
    /// </summary>
    public sealed class MuiColorWheel : ContentControl
    {
        private const int BitmapPx = 236;

        public static readonly DependencyProperty HueProperty =
            DependencyProperty.Register(nameof(Hue), typeof(double), typeof(MuiColorWheel),
                new PropertyMetadata(0.0, (d, _) => ((MuiColorWheel)d).OnValueChanged()));

        public static readonly DependencyProperty SaturationProperty =
            DependencyProperty.Register(nameof(Saturation), typeof(double), typeof(MuiColorWheel),
                new PropertyMetadata(0.0, (d, _) => ((MuiColorWheel)d).OnValueChanged()));

        public static readonly DependencyProperty WheelSizeProperty =
            DependencyProperty.Register(nameof(WheelSize), typeof(double), typeof(MuiColorWheel),
                new PropertyMetadata(96.0, (d, _) => ((MuiColorWheel)d).Rebuild()));

        public static readonly DependencyProperty AccessibleLabelProperty =
            DependencyProperty.Register(nameof(AccessibleLabel), typeof(string), typeof(MuiColorWheel),
                new PropertyMetadata("Color wheel", (d, _) => ((MuiColorWheel)d).Rebuild()));

        /// <summary>Degrees, [0, 360).</summary>
        public double Hue
        {
            get => (double)GetValue(HueProperty);
            set => SetValue(HueProperty, value);
        }

        /// <summary>[0, 100].</summary>
        public double Saturation
        {
            get => (double)GetValue(SaturationProperty);
            set => SetValue(SaturationProperty, value);
        }

        public double WheelSize
        {
            get => (double)GetValue(WheelSizeProperty);
            set => SetValue(WheelSizeProperty, value);
        }

        public string AccessibleLabel
        {
            get => (string)GetValue(AccessibleLabelProperty);
            set => SetValue(AccessibleLabelProperty, value);
        }

        /// <summary>Fires on every drag/keyboard change with the new (hue,
        /// saturation) reading.</summary>
        public event EventHandler<MuiColorWheelValue>? ValueChanged;

        /// <summary>Fires on double-tap — the host should reset to the
        /// identity state (hue 0, saturation 0).</summary>
        public event EventHandler? ResetRequested;

        private readonly Grid _surface = new();
        private readonly Image _disc;
        private readonly Ellipse _puck;
        private bool _dragging;
        private uint? _activePointerId;

        public MuiColorWheel()
        {
            _disc = new Image { Source = BuildDiscBitmap(), Stretch = Stretch.Uniform };
            _puck = new Ellipse
            {
                Width = 12,
                Height = 12,
                StrokeThickness = 2,
                Fill = new SolidColorBrush(Microsoft.UI.Colors.Transparent),
                IsHitTestVisible = false,
                HorizontalAlignment = HorizontalAlignment.Left,
                VerticalAlignment = VerticalAlignment.Top,
            };
            _surface.Children.Add(_disc);
            _surface.Children.Add(_puck);
            Content = _surface;
            IsTabStop = true;

            PointerPressed += OnPointerPressed;
            PointerMoved += OnPointerMoved;
            PointerReleased += OnPointerReleased;
            PointerCanceled += OnPointerReleased;
            PointerCaptureLost += (_, _) => { _dragging = false; _activePointerId = null; };
            DoubleTapped += (_, _) => { if (IsEnabled) ResetRequested?.Invoke(this, EventArgs.Empty); };
            KeyDown += OnKeyDown;
            _surface.SizeChanged += (_, _) => PositionPuck();
            IsEnabledChanged += (_, _) => Rebuild();

            Rebuild();
        }

        private static Brush R(string key) => (Brush)Application.Current.Resources[key];
        // The `Maple*Color` tokens are raw Color resources (Themes/Tokens.xaml
        // defines the brushes FROM them) — read them directly; casting
        // through SolidColorBrush throws InvalidCastException at first
        // construction.
        private static Color TokenColor(string key) => (Color)Application.Current.Resources[key];

        private void OnValueChanged()
        {
            PositionPuck();
        }

        private void OnPointerPressed(object sender, PointerRoutedEventArgs e)
        {
            if (!IsEnabled || !e.GetCurrentPoint(this).Properties.IsLeftButtonPressed || _dragging) return;
            _dragging = true;
            _activePointerId = e.Pointer.PointerId;
            CapturePointer(e.Pointer);
            ApplyPointer(e);
            e.Handled = true;
        }

        private void OnPointerMoved(object sender, PointerRoutedEventArgs e)
        {
            if (!_dragging || e.Pointer.PointerId != _activePointerId) return;
            ApplyPointer(e);
            e.Handled = true;
        }

        private void OnPointerReleased(object sender, PointerRoutedEventArgs e)
        {
            if (e.Pointer.PointerId != _activePointerId) return;
            _dragging = false;
            _activePointerId = null;
            ReleasePointerCapture(e.Pointer);
            e.Handled = true;
        }

        private void ApplyPointer(PointerRoutedEventArgs e)
        {
            var width = _surface.ActualWidth;
            var height = _surface.ActualHeight;
            if (width <= 0 || height <= 0) return;
            var pt = e.GetCurrentPoint(_surface).Position;
            var next = MuiColorWheelMath.PointerToValue(pt.X / width, pt.Y / height, fallbackHue: Hue);
            Hue = next.Hue;
            Saturation = next.Saturation;
            ValueChanged?.Invoke(this, next);
        }

        private void OnKeyDown(object sender, KeyRoutedEventArgs e)
        {
            if (!IsEnabled) return;
            double hue = Hue, sat = Saturation;
            switch (e.Key)
            {
                case Windows.System.VirtualKey.Left: hue = MuiColorWheelMath.WrapHue(hue - 1); break;
                case Windows.System.VirtualKey.Right: hue = MuiColorWheelMath.WrapHue(hue + 1); break;
                case Windows.System.VirtualKey.Up: sat = MuiSliderMath.Clamp(sat + 1, 0, 100); break;
                case Windows.System.VirtualKey.Down: sat = MuiSliderMath.Clamp(sat - 1, 0, 100); break;
                default: return;
            }
            e.Handled = true;
            Hue = hue;
            Saturation = sat;
            ValueChanged?.Invoke(this, new MuiColorWheelValue(hue, sat));
        }

        private void PositionPuck()
        {
            var width = _surface.ActualWidth;
            var height = _surface.ActualHeight;
            if (width <= 0 || height <= 0) return;
            var (x01, y01) = MuiColorWheelMath.ValueToUnitPosition(Hue, Saturation);
            _puck.Margin = new Thickness(x01 * width - 6, y01 * height - 6, 0, 0);
        }

        private void Rebuild()
        {
            Width = WheelSize;
            Height = WheelSize;
            _puck.Stroke = R("MapleTextMain");
            PositionPuck();

            Opacity = IsEnabled ? 1.0 : 0.45;

            var name = $"{AccessibleLabel}, hue {Math.Round(Hue)} degrees, saturation {Math.Round(Saturation)} percent";
            AutomationProperties.SetName(this, name);
        }

        // --- disc bitmap: conic hue ring + radial surface fade + rim, token-tinted ---

        private static WriteableBitmap? _sharedDisc;

        private static WriteableBitmap BuildDiscBitmap()
        {
            if (_sharedDisc != null) return _sharedDisc;

            var surface = TokenColor("MapleSurfaceColor");
            var rimTint = TokenColor("MapleTextMainColor");

            var bmp = new WriteableBitmap(BitmapPx, BitmapPx);
            var pixels = new byte[BitmapPx * BitmapPx * 4];
            var half = BitmapPx / 2.0;
            var aa = 1.5 / half;
            for (var yPix = 0; yPix < BitmapPx; yPix++)
            {
                for (var xPix = 0; xPix < BitmapPx; xPix++)
                {
                    var dx = (xPix + 0.5) / half - 1;
                    var dy = 1 - (yPix + 0.5) / half;
                    var r = Math.Sqrt(dx * dx + dy * dy);
                    var o = (yPix * BitmapPx + xPix) * 4;
                    if (r > 1)
                    {
                        var edge = Math.Clamp((r - 1) / aa, 0, 1);
                        if (edge >= 1) continue;
                        WritePixel(pixels, o, rimTint, (1 - edge) * 0.12);
                        continue;
                    }
                    var hue = MuiColorWheelMath.WrapHue(Math.Atan2(dy, dx) * 180 / Math.PI);
                    var (hr, hg, hb) = HslToRgb(hue, 1.0, 0.5);
                    var fade = Math.Clamp(1 - r / (0.72 * Math.Sqrt(2)), 0, 1);
                    var cr = (byte)(hr + (surface.R - hr) * fade);
                    var cg = (byte)(hg + (surface.G - hg) * fade);
                    var cb = (byte)(hb + (surface.B - hb) * fade);
                    var rim = Math.Clamp((r - (1 - 2.0 / half)) * half / 2.0, 0, 1) * 0.12;
                    cr = (byte)(cr + (rimTint.R - cr) * rim);
                    cg = (byte)(cg + (rimTint.G - cg) * rim);
                    cb = (byte)(cb + (rimTint.B - cb) * rim);
                    pixels[o] = cb;
                    pixels[o + 1] = cg;
                    pixels[o + 2] = cr;
                    pixels[o + 3] = 255;
                }
            }
            using (var stream = bmp.PixelBuffer.AsStream())
                stream.Write(pixels, 0, pixels.Length);
            _sharedDisc = bmp;
            return bmp;
        }

        private static void WritePixel(byte[] px, int o, Color tint, double alpha)
        {
            var a = (byte)(alpha * 255);
            px[o] = (byte)(tint.B * a / 255);
            px[o + 1] = (byte)(tint.G * a / 255);
            px[o + 2] = (byte)(tint.R * a / 255);
            px[o + 3] = a;
        }

        private static (byte R, byte G, byte B) HslToRgb(double h, double s, double l)
        {
            var c = (1 - Math.Abs(2 * l - 1)) * s;
            var hp = h / 60.0;
            var x = c * (1 - Math.Abs(hp % 2 - 1));
            var (r1, g1, b1) = hp switch
            {
                < 1 => (c, x, 0.0),
                < 2 => (x, c, 0.0),
                < 3 => (0.0, c, x),
                < 4 => (0.0, x, c),
                < 5 => (x, 0.0, c),
                _ => (c, 0.0, x),
            };
            var m = l - c / 2;
            return ((byte)((r1 + m) * 255), (byte)((g1 + m) * 255), (byte)((b1 + m) * 255));
        }
    }
}
